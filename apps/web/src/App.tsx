import { type FormEvent, type KeyboardEvent, Fragment, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import {
  parseApiError,
  parseInviteResponse,
  parseMagicLinkConsumeResponse,
  parseSessionResponse,
  parseTripListResponse,
  parseTripResponse,
  type CreateTripInput,
  type MagicLinkConsumeResponse,
  type SessionResponse,
  type TripDto,
  type TripSummaryDto,
  type UserDto,
} from "@along-the-way/contracts/private-trips";

import { CalendarDays, ChevronsUpDown, MapPin, Route, Users, Wifi, WifiOff } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { countryStopLabel } from "./country-stop-label";
import { CreateTripDialog } from "./CreateTripDialog";
import { FirstTripOnboarding } from "./FirstTripOnboarding";
import { LoginExperience, AuthProgress, type AuthProgressPhase } from "./LoginExperience";
import { DiscoveryWorkspace } from "./DiscoveryWorkspace";
import { TripSkeletonWorkspace } from "./TripSkeletonWorkspace";
import { TripPlaceWorkspace } from "./TripPlaceWorkspace";
import { TravelWorkspace } from "./TravelWorkspace";
import { useI18n, type Messages } from "./i18n";
import { parseTripSkeletonResponse, type TripSkeletonResponse } from "@along-the-way/contracts/trip-skeleton";
import { parseTripPlaceListResponse, type TripPlaceListResponse } from "@along-the-way/contracts/trip-places";
import { TodayWorkspace } from "./TodayWorkspace";
import { TripOnboardingChecklist } from "./TripOnboardingChecklist";
import { createTodayModel, tripClock } from "./today-model";
import { TodaySnapshotStore, TODAY_SCHEMA_VERSION, TODAY_SIGNED_OUT_STORAGE_KEY, type TodaySnapshot } from "./today-snapshot";
import {
  defaultSegment,
  itinerarySegmentIds,
  placesSegmentIds,
  readTripLocation,
  tripTabIds,
  writeTripLocation,
  type ItinerarySegment,
  type PlacesSegment,
  type TripSegment,
  type TripTab,
} from "./trip-location";
import { ApiRequestError, localizedApiErrorMessage } from "./api-error";
import { useTripLiveUpdates } from "./useTripLiveUpdates";
import { TripHistory } from "./TripHistory";
interface OnboardingFacts {
  tripId: string;
  hasLodging: boolean;
  placeCount: number;
  hasAssignedPlace: boolean;
}


interface RequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}

const TERMINAL_MAGIC_CODES: Record<string, true> = {
  expired_magic_link: true,
  invalid_magic_link: true,
  revoked_magic_link: true,
  used_magic_link: true,
};



async function requestJson<T>(
  messages: Messages["errors"],
  url: string,
  options: RequestOptions = {},
) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new ApiRequestError("unknown", messages.unknown);
  }
  const value = response.status === 204 ? null : await response.json().catch(() => {
    throw new ApiRequestError("unknown", messages.unknown, undefined, undefined, undefined, response.status);
  });
  if (!response.ok) {
    let parsed;
    try {
      parsed = parseApiError(value);
    } catch {
      throw new ApiRequestError("unknown", messages.unknown, undefined, undefined, undefined, response.status);
    }
    throw new ApiRequestError(
      parsed.error.code,
      localizedApiErrorMessage(
        messages,
        parsed.error.code,
        parsed.error.message,
        parsed.error.correlationId,
        parsed.error.currentVersion,
      ),
      parsed.error.correlationId,
      parsed.error.currentVersion,
      parsed.error.latestChange,
      response.status,
    );
  }
  if (!options.parse) return value as T;
  try {
    return options.parse(value) as T;
  } catch {
    throw new ApiRequestError("unknown", messages.unknown, undefined, undefined, undefined, response.status);
  }
}

interface AuthFragment {
  magicToken: string | null;
  inviteToken: string | null;
}

function readAuthFragment(): AuthFragment {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  return {
    magicToken: fragment.get("magicToken"),
    inviteToken: fragment.get("inviteToken"),
  };
}

function removeTokenFragment(remove: "magicToken" | "inviteToken") {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  fragment.delete(remove);
  url.hash = fragment.toString();
  window.history.replaceState({}, "", url);
}



interface TripMembersWorkspaceProps {
  trip: TripDto;
  currentUser: UserDto;
  onChanged: () => Promise<void>;
  request<T>(url: string, options?: RequestOptions): Promise<T>;
}

function TripFlightWorkspace({ trip, request, revision, onChanged }: {
  trip: TripDto;
  request<T>(url: string, options?: RequestOptions): Promise<T>;
  revision: number;
  onChanged(): Promise<void>;
}) {
  const { t } = useI18n();
  return (
    <section className="travel-overview">
      <section aria-labelledby="trip-country-route">
        <h3 id="trip-country-route" className="font-semibold">{t.app.countryRoute}</h3>
        {trip.countryStops.length > 0 ? (
          <ol className="mt-2 grid gap-2">
            {trip.countryStops.map((stop) => (
              <li key={stop.id} className="flex items-center justify-between gap-3 rounded-xl bg-surface-subtle px-4 py-3">
                <span><strong className="mr-3">{stop.position + 1}.</strong>{countryStopLabel(stop.countryCode)}</span>
                <small className="text-muted-foreground">{stop.timeZone ?? t.app.timeZoneNotInferred}</small>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 rounded-xl bg-surface-subtle p-4 text-muted-foreground">{t.app.legacyTripNoCountryRoute}</p>
        )}
      </section>
      <div className="mt-8">
        <TravelWorkspace key={trip.id} trip={trip} type="flight" request={request} revision={revision} onChanged={onChanged} />
      </div>
    </section>
  );
}

function TripMembersWorkspace({ trip, currentUser, onChanged, request }: TripMembersWorkspaceProps) {
  const { t } = useI18n();
  const [inviteEmail, setInviteEmail] = useState("");
  const [message, setMessage] = useState("");
  const inviteKey = useRef<string | null>(null);
  const actionKeys = useRef(new Map<string, string>());

  function actionKey(identity: string) {
    const existing = actionKeys.current.get(identity);
    if (existing) return existing;
    const created = crypto.randomUUID();
    actionKeys.current.set(identity, created);
    return created;
  }

  async function inviteMember(event: FormEvent) {
    event.preventDefault();
    inviteKey.current ??= crypto.randomUUID();
    try {
      const response = await request<{ invite: { email: string } }>(
        `/api/trips/${trip.id}/invites`,
        {
          method: "POST",
          headers: { "Idempotency-Key": inviteKey.current },
          body: JSON.stringify({ email: inviteEmail }),
          parse: (value) => parseInviteResponse(value),
        },
      );
      inviteKey.current = null;
      setInviteEmail("");
      setMessage(t.app.invitationSent(response.invite.email));
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t.app.unableInviteMember);
    }
  }

  async function removeMember(userId: string) {
    const identity = `remove-member:${userId}`;
    try {
      await request(`/api/trips/${trip.id}/members/${userId}`, {
        method: "DELETE",
        headers: { "Idempotency-Key": actionKey(identity) },
      });
      actionKeys.current.delete(identity);
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t.errors.unknown);
    }
  }

  async function revokeInvite(inviteId: string) {
    const identity = `revoke-invite:${inviteId}`;
    try {
      await request(`/api/trips/${trip.id}/invites/${inviteId}`, {
        method: "DELETE",
        headers: { "Idempotency-Key": actionKey(identity) },
      });
      actionKeys.current.delete(identity);
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t.errors.unknown);
    }
  }

  return (
    <section className="rounded-card border border-ink/10 bg-surface p-5 shadow-card sm:p-8">
      <div className="grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <div>
          <h3 className="font-display text-2xl">{t.app.members}</h3>
          <ul className="mt-3 grid gap-3">
            {trip.members.map((member) => {
              const memberLabel = member.displayName ?? member.email;
              return (
                <li key={member.id} className="flex min-h-14 items-center gap-3 rounded-xl bg-surface-subtle px-4 py-3">
                  <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-ink-strong text-sm font-bold text-on-dark">
                    {memberLabel.slice(0, 1).toLocaleUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]"><strong className="block">{memberLabel}</strong><small className="text-muted-foreground">{t.app.role(member.role)}{member.userId === currentUser.id ? `・${t.app.you}` : ""}</small></span>
                  {trip.role === "owner" && member.role === "editor" ? (
                    <button className="min-h-11 rounded-lg border border-accent-strong px-3 text-sm font-bold text-accent-strong outline-none hover:bg-surface-subtle focus:ring-4 focus:ring-focus/30" onClick={() => void removeMember(member.userId)}>
                      {t.app.remove}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>

        <div>
          <h3 className="font-display text-2xl">{t.app.pendingInvitations}</h3>
          <ul className="mt-3 grid gap-3">
            {trip.invites.filter((invite) => invite.status === "pending").map((invite) => (
              <li key={invite.id} className="flex min-h-14 items-center justify-between gap-3 rounded-xl bg-surface-subtle px-4 py-3">
                <span className="min-w-0 [overflow-wrap:anywhere]">{invite.email}</span>
                {trip.role === "owner" ? (
                  <button className="min-h-11 rounded-lg border px-3 text-sm font-bold outline-none hover:bg-surface focus:ring-4 focus:ring-focus/30" onClick={() => void revokeInvite(invite.id)}>{t.app.revoke}</button>
                ) : null}
              </li>
            ))}
            {trip.invites.every((invite) => invite.status !== "pending") ? <li className="text-muted-foreground">{t.app.noPendingInvitations}</li> : null}
          </ul>
          {trip.role === "owner" ? (
            <form className="mt-5 grid gap-3" onSubmit={inviteMember}>
              <label className="grid gap-1 font-semibold">
                {t.app.inviteEditorByEmail}
                <input className="min-h-11 rounded-lg border px-3 outline-none focus:border-focus focus:ring-2 focus:ring-focus/30" type="email" required value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} />
              </label>
              <button className="min-h-11 rounded-xl bg-ink-strong px-4 font-bold text-white outline-none hover:bg-ink focus:ring-4 focus:ring-focus/30">{t.app.sendInvitation}</button>
            </form>
          ) : null}
          {message ? <p className="mt-3" role="status">{message}</p> : null}
        </div>
      </div>
    </section>
  );
}

function TripSwitcher({ layout, trips, selectedTrip, signedInEmail, openCreateTrip, selectTrip, signOut }: {
  layout: "mobile" | "desktop";
  trips: TripSummaryDto[];
  selectedTrip: TripDto | null;
  signedInEmail: string;
  openCreateTrip(returnFocus?: HTMLElement | null): void;
  selectTrip(tripId: string): void;
  signOut(): void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const switcherTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setOpen(false);
  }, [selectedTrip?.id]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        ref={switcherTrigger}
        className="flex min-h-11 w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-lg border border-ink/15 bg-surface px-3 py-2 text-left font-bold outline-none hover:border-ink/30 focus:ring-4 focus:ring-focus/30"
        aria-label={t.app.switchTrip(selectedTrip?.name ?? t.app.chooseTrip)}
      >
        <span className="atw-wrap-two-lines min-w-0 flex-1">{selectedTrip?.name ?? t.app.chooseTrip}</span>
        <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0" />
      </DialogTrigger>
      <DialogContent className="max-lg:bottom-0 max-lg:left-0 max-lg:top-auto max-lg:w-full max-lg:max-w-none max-lg:translate-x-0 max-lg:translate-y-0 max-lg:rounded-b-none lg:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.app.chooseTrip}</DialogTitle>
          <DialogDescription>{t.app.trips}</DialogDescription>
        </DialogHeader>
        {selectedTrip ? (
          <p className="rounded-lg bg-surface-subtle px-3 py-2 text-sm text-muted-foreground">
            {selectedTrip.startDate} – {selectedTrip.endDate}
            {selectedTrip.defaultCurrency ? t.app.defaultCurrency(selectedTrip.defaultCurrency) : t.app.noDefaultCurrency}
          </p>
        ) : null}
        <div className="grid gap-3">
          <div className="grid max-h-[60dvh] gap-2 overflow-y-auto">
            {trips.map((trip) => (
              <button
                key={trip.id}
                type="button"
                className={`min-h-14 rounded-xl border px-4 py-3 text-left outline-none hover:bg-surface-subtle focus:ring-4 focus:ring-focus/30 ${selectedTrip?.id === trip.id ? "border-accent-strong bg-surface-subtle" : "border-ink/10"}`}
                aria-current={selectedTrip?.id === trip.id ? "page" : undefined}
                onClick={() => {
                  setOpen(false);
                  selectTrip(trip.id);
                }}
              >
                <strong className="block">{trip.name}</strong>
                <small className="text-muted-foreground">{t.app.tripDatesAndMembers(trip.startDate, trip.endDate, trip.memberCount)}</small>
              </button>
            ))}
            {trips.length === 0 ? <p className="rounded-xl bg-surface-subtle p-4 text-muted-foreground">{t.app.createFirstTrip}</p> : null}
          </div>
          <Button type="button" className="min-h-10" onClick={() => {
            const returnFocus = switcherTrigger.current;
            setOpen(false);
            window.requestAnimationFrame(() => openCreateTrip(returnFocus));
          }}>
            {t.app.createTrip}
          </Button>
        </div>
        {layout === "mobile" ? (
          <div className="grid gap-2 border-t border-ink/10 pt-4">
            <p className="text-sm text-muted-foreground">{t.app.signedInAs(signedInEmail)}</p>
            <button type="button" className="min-h-11 w-full rounded-lg border px-4 font-bold outline-none hover:bg-surface-subtle focus:ring-4 focus:ring-focus/30" onClick={signOut}>{t.app.signOut}</button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TripNavigation({ layout, activeTab, selectTab, itinerarySegment, selectItinerarySegment }: {
  layout: "mobile" | "desktop";
  activeTab: TripTab;
  selectTab(tab: TripTab): void;
  itinerarySegment: ItinerarySegment;
  selectItinerarySegment(segment: ItinerarySegment): void;
}) {
  const { t } = useI18n();
  const destinations = [
    { value: "today", label: t.app.tabs.today, Icon: CalendarDays },
    { value: "itinerary", label: t.app.tabs.itinerary, Icon: Route },
    { value: "places", label: t.app.tabs.places, Icon: MapPin },
    { value: "members", label: t.app.tabs.members, Icon: Users },
  ] as const;
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: TripTab) => {
    const currentIndex = tripTabIds.indexOf(tab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % tripTabIds.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + tripTabIds.length) % tripTabIds.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tripTabIds.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = tripTabIds[nextIndex]!;
    selectTab(nextTab);
    document.querySelector<HTMLElement>(`[data-trip-tab="${nextTab}"][data-layout="${layout}"]`)?.focus();
  };
  return (
    <nav
      aria-label={t.app.tripSections}
      className={layout === "mobile" ? "atw-bottomnav" : "atw-railnav"}
    >
      <div role="tablist" aria-orientation={layout === "desktop" ? "vertical" : "horizontal"}>
        {destinations.map(({ value, label, Icon }) => (
          <Fragment key={value}>
            <button
              type="button"
              role="tab"
              data-trip-tab={value}
              data-layout={layout}
              aria-controls={`trip-panel-${value}`}
              aria-selected={activeTab === value}
              tabIndex={activeTab === value ? 0 : -1}
              className={activeTab === value ? "is-active" : ""}
              onClick={() => selectTab(value)}
              onKeyDown={(event) => handleKeyDown(event, value)}
            >
              <Icon aria-hidden="true" className={layout === "mobile" ? "size-[22px]" : "size-5"} />
              <span>{label}</span>
            </button>
            {/* Desktop child bar under 行程: the permanent way into 航班／住宿 (mobile uses the
                segment strip at the top of the 行程 panel; the bottom bar has no room). */}
            {layout === "desktop" && value === "itinerary" && activeTab === "itinerary" ? (
              <div className="atw-railnav__children" role="group" aria-label={t.app.itinerarySectionPicker}>
                {itinerarySegmentIds.map((segment) => (
                  <button
                    key={segment}
                    type="button"
                    data-itinerary-child={segment}
                    aria-current={itinerarySegment === segment ? "page" : undefined}
                    className={itinerarySegment === segment ? "is-active" : ""}
                    onClick={() => selectItinerarySegment(segment)}
                  >
                    {t.app.itinerarySegments[segment]}
                  </button>
                ))}
              </div>
            ) : null}
          </Fragment>
        ))}
      </div>
    </nav>
  );
}

function SegmentControl<T extends string>({ label, id, items, active, onSelect }: {
  label: string;
  id: string;
  items: readonly { value: T; label: string }[];
  active: T;
  onSelect(value: T): void;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, value: T) => {
    const currentIndex = items.findIndex((item) => item.value === value);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % items.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = items[nextIndex]!;
    onSelect(next.value);
    document.getElementById(`${id}-segment-${next.value}`)?.focus();
  };
  return (
    <div className="atw-segments" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.value}
          id={`${id}-segment-${item.value}`}
          type="button"
          role="tab"
          aria-controls={`${id}-segment-panel-${item.value}`}
          aria-selected={active === item.value}
          tabIndex={active === item.value ? 0 : -1}
          className={active === item.value ? "is-active" : ""}
          onClick={() => onSelect(item.value)}
          onKeyDown={(event) => handleKeyDown(event, item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function App() {
  const { t } = useI18n();
  const projectionFailure = useRef<(tripId: string, reason?: unknown) => void>(() => {});
  const accountId = useRef<string | null>(null);
  const readOnly = useRef(false);
  const reconnecting = useRef(false);
  const signedOut = useRef(false);
  const loadSequence = useRef(0);
  const sessionEpoch = useRef(0);
  const [store] = useState(() => {
    try { return new TodaySnapshotStore(window.localStorage); } catch { return null; }
  });
  const [todaySnapshot, setTodaySnapshot] = useState<TodaySnapshot | null>(null);
  const [offline, setOffline] = useState(false);
  const [persisted, setPersisted] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(() => readTripLocation().day);
  const request = useCallback(async <T,>(url: string, options: RequestOptions = {}): Promise<T> => {
    if (options.method && !["GET", "HEAD"].includes(options.method.toUpperCase()) && (readOnly.current || !navigator.onLine)) {
      throw new Error(t.today.mutationDisabled);
    }
    const isRead = !options.method || ["GET", "HEAD"].includes(options.method.toUpperCase());
    const tripRead = isRead ? url.match(/^\/api\/trips\/([^/?]+)(?:\/(?:skeleton|trip-places))?$/) : null;
    const coreRead = isRead && (tripRead || url === "/api/session" || url === "/api/trips");
    const optionalPlaceRead = isRead && /^\/api\/trips\/[^/?]+\/(?:place-details|place-previews)(?:\?|$)/.test(url);
    try { return await requestJson<T>(t.errors, url, options); }
    catch (reason) {
      if (reason instanceof ApiRequestError && (reason.status === 401 || (tripRead && [403, 404].includes(reason.status ?? 0)))) {
        const owner = accountId.current ?? store?.lastAccount();
        const tripId = tripRead?.[1];
        if (owner && tripId) store?.clearTrip(owner, tripId);
        if (owner && reason.status === 401) store?.clearAccount(owner);
        window.dispatchEvent(new CustomEvent("today-access-denied", { detail: { tripId, status: reason.status } }));
      } else if (coreRead && (!(reason instanceof ApiRequestError) || reason.status === undefined || reason.status >= 500)) {
        window.dispatchEvent(new Event("today-api-unavailable"));
      }
      const projection = /^\/api\/trips\/([^/?]+)(?:\/([^/?]+))?/.exec(url);
      if (isRead && projection && !optionalPlaceRead && projection[2] !== "version" && projection[2] !== "events" && !readOnly.current) {
        projectionFailure.current(projection[1]!, reason);
      }
      throw reason;
    }
  }, [store, t.errors, t.today.mutationDisabled]);
  const [user, setUser] = useState<UserDto | null | undefined>(undefined);
  const [trips, setTrips] = useState<TripSummaryDto[]>([]);
  const [selectedTrip, setSelectedTrip] = useState<TripDto | null>(null);
  const [error, setError] = useState("");
  const [accepting, setAccepting] = useState(false);
  const inviteKey = useRef<string | null>(null);
  const createTripKey = useRef<string | null>(null);
  const [authFragment, setAuthFragment] = useState<AuthFragment>(readAuthFragment);
  const authFragmentRef = useRef(authFragment);
  const consumeRequests = useRef(new Map<string, Promise<MagicLinkConsumeResponse>>());
  const completedAuthKeys = useRef(new Set<string>());
  const [authAttempt, setAuthAttempt] = useState(0);
  const [retryMagicToken, setRetryMagicToken] = useState<string | null>(null);
  const [signInError, setSignInError] = useState("");
  const [authProgressPhase, setAuthProgressPhase] = useState<AuthProgressPhase>(
    () => authFragment.magicToken ? "consuming-link" : "restoring",
  );
  const [shellEntering, setShellEntering] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const createDialogReturnFocus = useRef<HTMLElement | null>(null);
  const [onboardingFacts, setOnboardingFacts] = useState<OnboardingFacts | null>(null);
  const [createdTripId, setCreatedTripId] = useState<string | null>(null);
  const [placesRevision, setPlacesRevision] = useState(0);
  const [arrangeDate, setArrangeDate] = useState<string | null>(null);
  const [syncRevision, setSyncRevision] = useState(0);
  const workspaceRevision = placesRevision + syncRevision;
  const placesChanged = useCallback(() => {
    setPlacesRevision((revision) => revision + 1);
  }, []);
  const [activeTripTab, setActiveTripTab] = useState<TripTab>(() => readTripLocation().tab ?? "itinerary");
  const [activeSegment, setActiveSegment] = useState<TripSegment | null>(() => {
    const location = readTripLocation();
    return location.segment ?? defaultSegment(location.tab ?? "itinerary");
  });
  const clearLocalSession = useCallback(() => {
    ++sessionEpoch.current;
    signedOut.current = true;
    const owner = accountId.current ?? store?.lastAccount();
    if (owner) store?.clearAccount(owner);
    accountId.current = null;
    ++loadSequence.current;
    readOnly.current = false;
    setTodaySnapshot(null);
    setOnboardingFacts(null);
    setUser(null);
    setTrips([]);
    setSelectedTrip(null);
    setCreatedTripId(null);
    setOffline(false);
    setRetrying(false);
  }, [store]);
  const enterSignedIn = useCallback((authenticatedUser: UserDto) => {
    const reducedMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const transitionDocument = document as Document & {
      startViewTransition?: (update: () => void) => unknown;
    };
    if (!reducedMotion && transitionDocument.startViewTransition) {
      transitionDocument.startViewTransition(() => {
        flushSync(() => setUser(authenticatedUser));
      });
      return;
    }
    setShellEntering(true);
    setUser(authenticatedUser);
  }, []);
  useEffect(() => {
    if (!shellEntering) return;
    const timer = window.setTimeout(() => setShellEntering(false), 320);
    return () => window.clearTimeout(timer);
  }, [shellEntering]);

  const openCreateTrip = useCallback((returnFocus?: HTMLElement | null) => {
    createDialogReturnFocus.current = returnFocus instanceof HTMLElement
      ? returnFocus
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setCreateDialogOpen(true);
  }, []);

  const changeCreateDialogOpen = useCallback((open: boolean) => {
    setCreateDialogOpen(open);
    if (!open) {
      window.requestAnimationFrame(() => createDialogReturnFocus.current?.focus());
    }
  }, []);



  const refreshTrips = useCallback(async () => {
    const epoch = sessionEpoch.current;
    const owner = accountId.current;
    const response = await request<{ trips: TripSummaryDto[] }>("/api/trips", {
      parse: (value) => parseTripListResponse(value),
    });
    if (epoch === sessionEpoch.current && owner === accountId.current) {
      const authorized = new Set(response.trips.map((trip) => trip.id));
      if (owner) for (const snapshot of store?.forAccount(owner) ?? []) {
        if (!authorized.has(snapshot.model.tripId)) store?.clearTrip(owner, snapshot.model.tripId);
      }
      setTodaySnapshot((snapshot) => snapshot && !authorized.has(snapshot.model.tripId) ? null : snapshot);
      setSelectedTrip((trip) => trip && !authorized.has(trip.id) ? null : trip);
      setOnboardingFacts((facts) => facts && !authorized.has(facts.tripId) ? null : facts);
      setTrips(response.trips);
    }
    return response.trips;
  }, [request, store]);

  const loadTrip = useCallback(async (tripId: string, preserveError = false) => {
    const sequence = ++loadSequence.current;
    const [response, skeleton, places] = await Promise.all([
      request<{ trip: TripDto }>(`/api/trips/${tripId}`, { parse: parseTripResponse }),
      request<TripSkeletonResponse>(`/api/trips/${tripId}/skeleton`, { parse: parseTripSkeletonResponse }),
      request<TripPlaceListResponse>(`/api/trips/${tripId}/trip-places`, { parse: parseTripPlaceListResponse }),
    ]);
    if (sequence !== loadSequence.current || !accountId.current) return;
    if (response.trip.version !== skeleton.skeleton.tripVersion) {
      window.dispatchEvent(new Event("today-api-unavailable"));
      throw new Error(t.today.unavailable);
    }
    const model = createTodayModel(response.trip, skeleton.skeleton, places.tripPlaces, accountId.current);
    const saved = store?.save(accountId.current, model);
    setPersisted(Boolean(saved));
    setTodaySnapshot(saved ?? { schemaVersion: TODAY_SCHEMA_VERSION, accountId: accountId.current, model, fetchedAt: new Date().toISOString() });
    const location = readTripLocation();
    const clock = tripClock(model, Date.now());
    const tab = location.trip === tripId && location.tab ? location.tab : clock.today ? "today" : "itinerary";
    const segment = location.trip === tripId && location.tab
      ? location.segment ?? defaultSegment(tab)
      : defaultSegment(tab);
    const date = location.trip === tripId && model.days.some((day) => day.date === location.day) ? location.day : (clock.today ?? (clock.phase === "after" ? model.days.at(-1) : model.days[0]))?.date ?? null;
    setActiveTripTab(tab);
    setActiveSegment(segment);
    setSelectedDate(date);
    writeTripLocation(tripId, tab, segment, date, true);
    setOnboardingFacts({
      tripId,
      hasLodging: skeleton.skeleton.items.some((item) => item.type === "lodging"),
      placeCount: places.tripPlaces.length,
      hasAssignedPlace: places.tripPlaces.some((place) => place.assignedDayId !== null),
    });
    setSelectedTrip(response.trip);
    readOnly.current = false;
    setOffline(false);
    if (!preserveError) setError("");
  }, [request, store, t.today.unavailable]);

  const restoreSnapshot = useCallback(() => {
    if (signedOut.current || store?.isLocallySignedOut()) return false;
    const owner = accountId.current ?? store?.lastAccount();
    if (!owner) return false;
    const location = readTripLocation();
    const snapshot = location.trip ? store?.read(owner, location.trip) : store?.forAccount(owner)[0];
    readOnly.current = true;
    setOffline(true);
    if (!snapshot) { setTodaySnapshot(null); setSelectedTrip(null); setOnboardingFacts(null); setTrips([]); return false; }
    accountId.current = owner;
    ++loadSequence.current;
    setTodaySnapshot(snapshot);
    setSelectedTrip(null);
    setOnboardingFacts(null);
    setTrips([]);
    setActiveTripTab("today");
    setActiveSegment(null);
    setSelectedDate(location.day);
    writeTripLocation(snapshot.model.tripId, "today", null, location.day, true);
    return true;
  }, [store]);

  const reconnect = useCallback(async () => {
    if (signedOut.current || store?.isLocallySignedOut() || reconnecting.current) return;
    reconnecting.current = true;
    setRetrying(true);
    const epoch = sessionEpoch.current;
    try {
      const session = await request<{ user: UserDto }>("/api/session", { parse: parseSessionResponse });
      if (epoch !== sessionEpoch.current) return;
      const previousAccount = accountId.current ?? store?.lastAccount();
      if (previousAccount && previousAccount !== session.user.id) {
        store?.clearAccount(previousAccount);
        setTodaySnapshot(null); setSelectedTrip(null); setOnboardingFacts(null); setTrips([]);
      }
      accountId.current = session.user.id;
      setUser(session.user);
      const available = await refreshTrips();
      if (epoch !== sessionEpoch.current) return;
      const tripId = readTripLocation().trip ?? available[0]?.id;
      if (tripId) {
        await loadTrip(tripId);
        // Read synchronization refreshes mounted panels without triggering the mutation-to-Today effect.
        if (epoch === sessionEpoch.current) setSyncRevision((revision) => revision + 1);
      }
      else { setTodaySnapshot(null); setOffline(false); readOnly.current = false; }
    } catch (reason) {
      if (!(reason instanceof ApiRequestError) || ![401, 403, 404].includes(reason.status ?? 0)) restoreSnapshot();
      setError(reason instanceof Error ? reason.message : t.today.unavailable);
    } finally { reconnecting.current = false; setRetrying(false); }
  }, [loadTrip, refreshTrips, request, restoreSnapshot, store, t.today.unavailable]);

  const selectTab = useCallback((tab: TripTab) => {
    const segment = defaultSegment(tab);
    setActiveTripTab(tab);
    setActiveSegment(segment);
    const location = readTripLocation();
    if (location.trip) writeTripLocation(location.trip, tab, segment, location.day);
  }, []);
  const selectSegment = useCallback((tab: TripTab, segment: TripSegment) => {
    setActiveTripTab(tab);
    setActiveSegment(segment);
    const location = readTripLocation();
    if (location.trip) writeTripLocation(location.trip, tab, segment, location.day);
  }, []);
  const selectDay = useCallback((date: string, replace = false) => {
    setSelectedDate(date);
    const location = readTripLocation();
    const tab = location.tab ?? "today";
    if (location.trip) writeTripLocation(location.trip, tab, location.segment ?? defaultSegment(tab), date, replace);
  }, []);

  useEffect(() => {
    const synchronizeSignOut = (event: StorageEvent) => {
      if (event.key === TODAY_SIGNED_OUT_STORAGE_KEY && event.newValue === "true") {
        clearLocalSession();
      }
    };
    window.addEventListener("storage", synchronizeSignOut);
    return () => window.removeEventListener("storage", synchronizeSignOut);
  }, [clearLocalSession]);

  useEffect(() => {
    const unavailable = () => { restoreSnapshot(); };
    const online = () => { void reconnect(); };
    const denied = (event: Event) => {
      const detail = (event as CustomEvent<{ tripId?: string; status: number }>).detail;
      if (detail.status === 401 || detail.tripId === readTripLocation().trip) {
        ++loadSequence.current;
        if (detail.status === 401) ++sessionEpoch.current;
        setTodaySnapshot(null); setSelectedTrip(null);
        setOffline(false); readOnly.current = false;
        if (detail.status === 401) { setUser(null); setTrips([]); accountId.current = null; }
      }
    };
    const navigate = () => {
      const location = readTripLocation();
      const tab = location.tab ?? "itinerary";
      setActiveTripTab(tab);
      setActiveSegment(location.segment ?? defaultSegment(tab));
      setSelectedDate(location.day);
      if (readOnly.current) restoreSnapshot();
      else if (location.trip) void loadTrip(location.trip).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t.today.unavailable));
    };
    const fragmentChanged = () => {
      let next = readAuthFragment();
      const previous = authFragmentRef.current;
      if (
        next.magicToken &&
        completedAuthKeys.current.has(next.magicToken)
      ) {
        removeTokenFragment("magicToken");
        next = { ...next, magicToken: previous.magicToken };
      }
      authFragmentRef.current = next;
      setAuthFragment(next);
      if (next.magicToken && next.magicToken !== previous.magicToken) {
        ++sessionEpoch.current;
        setSignInError("");
        setRetryMagicToken(null);
        setOffline(false);
        readOnly.current = false;
        setAuthProgressPhase("consuming-link");
        setUser(undefined);
      }
    };
    window.addEventListener("offline", unavailable);
    window.addEventListener("online", online);
    window.addEventListener("today-api-unavailable", unavailable);
    window.addEventListener("today-access-denied", denied);
    window.addEventListener("popstate", navigate);
    window.addEventListener("hashchange", fragmentChanged);
    return () => {
      window.removeEventListener("offline", unavailable); window.removeEventListener("online", online);
      window.removeEventListener("today-api-unavailable", unavailable); window.removeEventListener("today-access-denied", denied);
      window.removeEventListener("popstate", navigate);
      window.removeEventListener("hashchange", fragmentChanged);
    };
  }, [loadTrip, reconnect, restoreSnapshot, t.today.unavailable]);

  useEffect(() => {
    if (!offline) return;
    const revalidate = () => {
      if (navigator.onLine && document.visibilityState !== "hidden") void reconnect();
    };
    // An offline shell can reopen while navigator.onLine already reports true; the
    // browser then has no online transition to emit when the API becomes reachable.
    // Probe only while the visible read-only shell needs recovery. Events bypass
    // the interval, and reconnect's single-flight guard coalesces simultaneous signals.
    const interval = window.setInterval(revalidate, 2_000);
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [offline, reconnect]);

  useEffect(() => {
    if (placesRevision > 0 && selectedTrip && !readOnly.current) void loadTrip(selectedTrip.id, true).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t.today.unavailable));
  }, [placesRevision, loadTrip, selectedTrip?.id, t.today.unavailable]);

  const { connected: liveConnected, retryReadModels } = useTripLiveUpdates({
    tripId: offline ? undefined : selectedTrip?.id,
    request,
    onChanged: async () => {
      // Navigation owns its pending destination; a hint from the old trip must not
      // start a newer load and replace that destination or its browser-history entry.
      if (!selectedTrip || readOnly.current || readTripLocation().trip !== selectedTrip.id) return;
      const epoch = sessionEpoch.current;
      await loadTrip(selectedTrip.id, true);
      if (epoch === sessionEpoch.current && !readOnly.current) setSyncRevision((revision) => revision + 1);
    },
    onRevoked: () => {
      if (readTripLocation().trip === selectedTrip?.id) ++loadSequence.current;
      if (accountId.current && selectedTrip) store?.clearTrip(accountId.current, selectedTrip.id);
      setTodaySnapshot(null);
      setSelectedTrip(null);
      setOnboardingFacts(null);
      void refreshTrips().catch(() => setTrips([]));
    },
  });
  projectionFailure.current = retryReadModels;

  useEffect(() => {
    let active = true;
    const epoch = sessionEpoch.current;
    const magicToken = authFragment.magicToken;
    const authKey = magicToken ?? "session";
    let authenticatedUser: UserDto | null = null;
    let linkedInviteOutcome: MagicLinkConsumeResponse["inviteOutcome"];
    void authAttempt;
    if (completedAuthKeys.current.has(authKey)) {
      return () => {
        active = false;
      };
    }

    void (async () => {
      try {
        if (!magicToken && store?.isLocallySignedOut()) {
          completedAuthKeys.current.add(authKey);
          setUser(null);
          return;
        }

        let session: SessionResponse;
        let acceptedTripId: string | undefined;
        if (magicToken) {
          setAuthProgressPhase("consuming-link");
          setSignInError("");
          setRetryMagicToken(null);
          let consumeRequest = consumeRequests.current.get(magicToken);
          if (!consumeRequest) {
            consumeRequest = request<MagicLinkConsumeResponse>("/api/auth/magic-links/consume", {
              method: "POST",
              body: JSON.stringify({ token: magicToken }),
              parse: (value) => parseMagicLinkConsumeResponse(value),
            });
            consumeRequests.current.set(magicToken, consumeRequest);
          }
          let consumed: MagicLinkConsumeResponse;
          try {
            consumed = await consumeRequest;
          } catch (reason) {
            if (consumeRequests.current.get(magicToken) === consumeRequest) {
              consumeRequests.current.delete(magicToken);
            }
            if (!active || epoch !== sessionEpoch.current) return;
            setUser(null);
            if (
              reason instanceof ApiRequestError &&
              TERMINAL_MAGIC_CODES[reason.code]
            ) {
              completedAuthKeys.current.add(authKey);
              removeTokenFragment("magicToken");
              setSignInError(`${reason.message} ${t.app.requestNewMagicLink}`);
              setRetryMagicToken(null);
            } else {
              setSignInError(
                reason instanceof ApiRequestError
                  && (reason.code === "rate_limited" || reason.status === 429)
                  ? t.app.magicLinkConsumeRateLimited
                  : t.app.unableConsumeMagicLink,
              );
              setRetryMagicToken(magicToken);
            }
            return;
          }
          if (!active || epoch !== sessionEpoch.current) return;
          completedAuthKeys.current.add(authKey);
          removeTokenFragment("magicToken");
          store?.setLocallySignedOut(false);
          signedOut.current = false;
          session = consumed;
          acceptedTripId = consumed.acceptedTripId;
          linkedInviteOutcome = consumed.inviteOutcome;
          if (acceptedTripId || linkedInviteOutcome) {
            removeTokenFragment("inviteToken");
            const next = {
              ...authFragmentRef.current,
              inviteToken: null,
            };
            authFragmentRef.current = next;
            setAuthFragment(next);
          }
        } else {
          setAuthProgressPhase("restoring");
          session = await request<SessionResponse>("/api/session", {
            parse: (value) => parseSessionResponse(value),
          });
          completedAuthKeys.current.add(authKey);
        }

        authenticatedUser = session.user;
        if (!active || epoch !== sessionEpoch.current) return;
        setAuthProgressPhase("loading-trips");
        const previousAccount = accountId.current ?? store?.lastAccount();
        if (previousAccount && previousAccount !== session.user.id) {
          store?.clearAccount(previousAccount);
        }
        accountId.current = session.user.id;
        const available = await refreshTrips();
        if (!active || epoch !== sessionEpoch.current) return;
        const tripId = acceptedTripId ?? readTripLocation().trip ?? available[0]?.id;
        if (tripId) await loadTrip(tripId);
        else {
          setTodaySnapshot(null);
          setSelectedTrip(null);
          setOnboardingFacts(null);
        }
        if (linkedInviteOutcome === "expired-or-revoked") {
          setError(t.app.linkedInvitationUnavailable);
        }
        if (active && epoch === sessionEpoch.current) enterSignedIn(session.user);
      } catch (reason) {
        if (!active) return;
        if (!magicToken) completedAuthKeys.current.add(authKey);
        if (!(reason instanceof ApiRequestError) || reason.status === undefined || reason.status >= 500) {
          if (restoreSnapshot()) return;
        }
        if (authenticatedUser) {
          setError(
            linkedInviteOutcome === "expired-or-revoked"
              ? t.app.linkedInvitationUnavailable
              : reason instanceof Error
                ? reason.message
                : t.today.unavailable,
          );
          enterSignedIn(authenticatedUser);
          return;
        }
        setUser(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [
    authAttempt,
    authFragment.magicToken,
    enterSignedIn,
    loadTrip,
    refreshTrips,
    request,
    restoreSnapshot,
    store,
    t.app.linkedInvitationUnavailable,
    t.app.magicLinkConsumeRateLimited,
    t.app.requestNewMagicLink,
    t.app.unableConsumeMagicLink,
    t.today.unavailable,
  ]);

  async function acceptInvitation() {
    const token = authFragment.inviteToken;
    if (!token) return;
    setAccepting(true);
    setError("");
    inviteKey.current ??= crypto.randomUUID();
    try {
      const response = await request<{ trip: TripDto }>("/api/invites/accept", {
        method: "POST",
        headers: { "Idempotency-Key": inviteKey.current },
        body: JSON.stringify({ token }),
        parse: (value) => parseTripResponse(value),
      });
      inviteKey.current = null;
      removeTokenFragment("inviteToken");
      const next = { ...authFragmentRef.current, inviteToken: null };
      authFragmentRef.current = next;
      setAuthFragment(next);
      setSelectedTrip(response.trip);
      await refreshTrips();
      await loadTrip(response.trip.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.app.unableAcceptInvitation);
    } finally {
      setAccepting(false);
    }
  }

  async function createTrip(input: CreateTripInput) {
    createTripKey.current ??= crypto.randomUUID();
    const response = await request<{ trip: TripDto }>("/api/trips", {
      method: "POST",
      headers: { "Idempotency-Key": createTripKey.current },
      body: JSON.stringify(input),
      parse: (value) => parseTripResponse(value),
    });
    createTripKey.current = null;
    setSelectedTrip(response.trip);
    await refreshTrips();
    await loadTrip(response.trip.id);
    setCreatedTripId(response.trip.id);
  }

  async function logout() {
    const wasOffline = readOnly.current || !navigator.onLine;
    store?.setLocallySignedOut(true);
    clearLocalSession();
    if (!wasOffline) await request("/api/logout", { method: "POST" }).catch(() => {});
  }

  if (offline) {
    return <main className="mx-auto min-h-screen w-[min(100%-1.25rem,58rem)] py-5">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-bold">{todaySnapshot?.model.tripName ?? t.today.title}</h1><button className="min-h-11 rounded-lg border px-4 font-bold" onClick={() => void logout()}>{t.app.signOut}</button></header>
      <p className="mb-4 text-sm">{t.today.offlineAccount}</p>
      {error ? <p className="mb-4" role="alert">{error}</p> : null}
      {todaySnapshot ? <>
        <nav aria-label={t.today.savedTrips} className="mb-4 flex flex-wrap gap-2">{store?.forAccount(todaySnapshot.accountId).map((snapshot) => <button className="min-h-11 rounded-lg border px-3" key={snapshot.model.tripId} onClick={() => {
          writeTripLocation(snapshot.model.tripId, "today", null, null); restoreSnapshot();
        }}>{snapshot.model.tripName}</button>)}</nav>
        <TodayWorkspace model={todaySnapshot.model} fetchedAt={todaySnapshot.fetchedAt} selectedDate={selectedDate} onDayChanged={selectDay} offline retry={() => void reconnect()} retrying={retrying} />
      </> : <section><p role="status">{t.today.noSnapshot}</p><button className="mt-4 min-h-11 rounded-lg border px-4" onClick={() => void reconnect()} disabled={retrying}>{t.today.retry}</button></section>}
    </main>;
  }

  if (user === undefined) {
    return <div className="atw-auth-transition-surface"><AuthProgress phase={authProgressPhase} /></div>;
  }
  if (user === null) {
    return (
      <div className="atw-auth-transition-surface">
        <LoginExperience
          initialError={signInError || null}
          inviteToken={authFragment.inviteToken}
          requestLink={async (email) => {
            await requestJson<{ message: string }>(t.errors, "/api/auth/magic-links", {
              method: "POST",
              body: JSON.stringify({ email }),
            });
          }}
          requestInviteLink={async (inviteToken) => {
            await requestJson<{ message: string }>(t.errors, "/api/auth/invite-magic-links", {
              method: "POST",
              body: JSON.stringify({ inviteToken }),
            });
          }}
          retryConsume={retryMagicToken === authFragment.magicToken ? () => {
            ++sessionEpoch.current;
            setSignInError("");
            setRetryMagicToken(null);
            setAuthProgressPhase("consuming-link");
            setUser(undefined);
            setAuthAttempt((attempt) => attempt + 1);
          } : undefined}
          describeError={(reason) => reason instanceof Error ? reason.message : t.app.unableRequestLink}
        />
      </div>
    );
  }

  const inviteToken = authFragment.inviteToken;
  const itinerarySegment = itinerarySegmentIds.includes(activeSegment as ItinerarySegment)
    ? activeSegment as ItinerarySegment
    : "daily";
  const placesSegment = placesSegmentIds.includes(activeSegment as PlacesSegment)
    ? activeSegment as PlacesSegment
    : "wishlist";
  const itinerarySegments = itinerarySegmentIds.map((value) => ({ value, label: t.app.itinerarySegments[value] }));
  const placeSegments = [
    { value: "wishlist", label: t.app.placesSegments.wishlist },
    { value: "discovery", label: t.app.placesSegments.discovery },
  ] as const;
  const selectTrip = (tripId: string) => {
    if (createdTripId && createdTripId !== tripId) setCreatedTripId(null);
    const url = new URL(window.location.href);
    url.searchParams.set("trip", tripId);
    url.searchParams.delete("tab");
    url.searchParams.delete("segment");
    url.searchParams.delete("day");
    window.history.pushState({}, "", url);
    void loadTrip(tripId).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t.today.unavailable));
  };

  return (
    <main
      className={`atw-shell min-w-0${shellEntering ? " is-entering" : ""}`}
      data-active-tab={activeTripTab}
      data-has-trip={selectedTrip ? "true" : "false"}
    >
      <header className="atw-topbar">
        <div className="atw-topbar-content">
          <div className="min-w-0 flex-1">
            <TripSwitcher layout="mobile" trips={trips} selectedTrip={selectedTrip} signedInEmail={user.email} openCreateTrip={openCreateTrip} selectTrip={selectTrip} signOut={() => void logout()} />
          </div>
          {selectedTrip ? (
            <span
              className={`grid size-11 shrink-0 place-items-center ${liveConnected ? "text-accent-strong" : "text-muted-foreground"}`}
              title={liveConnected ? t.collaboration.live : t.collaboration.reconnecting}
            >
              {liveConnected ? <Wifi aria-hidden="true" className="size-5" /> : <WifiOff aria-hidden="true" className="size-5" />}
              <span className="sr-only">{liveConnected ? t.collaboration.live : t.collaboration.reconnecting}</span>
            </span>
          ) : null}
        </div>
      </header>

      <div className="atw-frame">
        <aside className="atw-rail">
          <TripSwitcher layout="desktop" trips={trips} selectedTrip={selectedTrip} signedInEmail={user.email} openCreateTrip={openCreateTrip} selectTrip={selectTrip} signOut={() => void logout()} />
          {selectedTrip ? <TripNavigation layout="desktop" activeTab={activeTripTab} selectTab={selectTab} itinerarySegment={itinerarySegment} selectItinerarySegment={(segment) => selectSegment("itinerary", segment)} /> : null}
          <div className="mt-2 border-t border-ink/10 pt-4">
            {selectedTrip && liveConnected ? (
              <span className="mb-2 flex items-center gap-2 text-xs text-muted-foreground" title={t.collaboration.live}>
                <span aria-hidden="true" className="size-2 rounded-full bg-accent-strong" />
                {t.collaboration.live}
              </span>
            ) : null}
            <p className="atw-wrap-two-lines text-sm text-muted-foreground" title={user.email}>{t.app.signedInAs(user.email)}</p>
            <button className="mt-2 min-h-11 w-full rounded-lg border px-4 font-bold outline-none hover:bg-surface-subtle focus:ring-4 focus:ring-focus/30" onClick={() => void logout()}>{t.app.signOut}</button>
          </div>
        </aside>

        <div className="atw-main">
          {inviteToken ? (
            <section className="flex flex-wrap items-center justify-between gap-3 rounded-panel bg-ink-strong p-5 text-on-dark">
              <div><strong className="block text-lg">{t.app.tripInvitation}</strong><span>{t.app.acceptWithSignedInEmail}</span></div>
              <button className="min-h-11 rounded-xl bg-accent px-5 font-bold outline-none focus:ring-4 focus:ring-focus/40 disabled:opacity-60" disabled={accepting} onClick={() => void acceptInvitation()}>{accepting ? t.app.accepting : t.app.acceptInvitation}</button>
            </section>
          ) : null}
          {error ? <p className="rounded-xl bg-surface p-4 text-accent-strong" role="alert">{error}</p> : null}

          {selectedTrip ? (
            <>
              {onboardingFacts?.tripId === selectedTrip.id ? (
                <TripOnboardingChecklist
                  key={selectedTrip.id}
                  tripId={selectedTrip.id}
                  userId={user.id}
                  isOwner={selectedTrip.role === "owner"}
                  facts={{
                    hasLodging: onboardingFacts.hasLodging,
                    placeCount: onboardingFacts.placeCount,
                    hasAssignedPlace: onboardingFacts.hasAssignedPlace,
                    hasCompanionOrPendingInvite:
                      selectedTrip.members.some((member) => member.userId !== user.id)
                      || selectedTrip.invites.some((invite) => invite.status === "pending"),
                  }}
                  showCreatedConfirmation={createdTripId === selectedTrip.id}
                  navigate={(tab, segment) => {
                    if (segment) selectSegment(tab, segment);
                    else selectTab(tab);
                  }}
                />
              ) : null}
              <section className={activeTripTab === "today" || activeTripTab === "itinerary" ? "sr-only" : "atw-trip-context"} aria-labelledby="trip-title-heading">
                <h1 id="trip-title-heading" className="sr-only">{selectedTrip.name}</h1>
                <p>
                  {selectedTrip.startDate} – {selectedTrip.endDate}
                  {selectedTrip.defaultCurrency ? t.app.defaultCurrency(selectedTrip.defaultCurrency) : t.app.noDefaultCurrency}
                  {`・${t.app.tripVersion(t.app.role(selectedTrip.role), selectedTrip.version)}`}
                </p>
              </section>
              {!liveConnected ? <p aria-live="polite" role="status" className="rounded-xl border border-ink/10 bg-surface-subtle p-3 text-sm text-muted-foreground">{t.collaboration.reconnecting}</p> : null}

              <div id="trip-panel-today" role="tabpanel" aria-label={t.app.tabs.today} hidden={activeTripTab !== "today"}>
                {todaySnapshot ? (
                  <TodayWorkspace
                    key={todaySnapshot.model.tripId}
                    model={todaySnapshot.model}
                    fetchedAt={todaySnapshot.fetchedAt}
                    selectedDate={selectedDate}
                    onDayChanged={selectDay}
                    isOwner={selectedTrip.role === "owner"}
                    onArrangeDay={selectedTrip.role === "owner" ? (date) => {
                      setArrangeDate(date);
                      selectSegment("itinerary", "daily");
                    } : undefined}
                    retry={() => void reconnect()}
                    retrying={retrying}
                    persisted={persisted}
                    request={request}
                  />
                ) : <p role="status">{t.today.unavailable}</p>}
              </div>

              <div id="trip-panel-itinerary" role="tabpanel" aria-label={t.app.tabs.itinerary} hidden={activeTripTab !== "itinerary"}>
                <div className="lg:hidden">
                  <SegmentControl
                    label={t.app.itinerarySectionPicker}
                    id="itinerary"
                    items={itinerarySegments}
                    active={itinerarySegment}
                    onSelect={(segment) => selectSegment("itinerary", segment)}
                  />
                </div>
                {itinerarySegment === "daily" ? (
                  <div id="itinerary-segment-panel-daily" role="tabpanel" aria-labelledby="itinerary-segment-daily">
                    <TripSkeletonWorkspace
                      key={selectedTrip.id}
                      trip={selectedTrip}
                      request={request}
                      onTripChanged={() => loadTrip(selectedTrip.id)}
                      placesRevision={workspaceRevision}
                      onPlacesChanged={placesChanged}
                      arrangeDate={arrangeDate}
                      onArrangeOpened={() => setArrangeDate(null)}
                      onTravelEdit={(type) => {
                        const segment: ItinerarySegment = type === "flight" ? "flight" : "lodging";
                        selectSegment("itinerary", segment);
                        // Focus whichever 航班／住宿 control is visible: rail child (desktop) or segment strip (mobile).
                        window.requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>(`#itinerary-segment-${segment}, [data-itinerary-child="${segment}"]`)]
                          .find((element) => element.offsetParent !== null)?.focus());
                      }}
                    />
                  </div>
                ) : itinerarySegment === "flight" ? (
                  <div id="itinerary-segment-panel-flight" role="tabpanel" aria-labelledby="itinerary-segment-flight">
                    <TripFlightWorkspace
                      trip={selectedTrip}
                      request={request}
                      revision={workspaceRevision}
                      onChanged={async () => { placesChanged(); await loadTrip(selectedTrip.id); }}
                    />
                  </div>
                ) : (
                  <div id="itinerary-segment-panel-lodging" role="tabpanel" aria-labelledby="itinerary-segment-lodging">
                    <TravelWorkspace key={selectedTrip.id} trip={selectedTrip} type="lodging" request={request} revision={workspaceRevision}
                      onChanged={async () => { placesChanged(); await loadTrip(selectedTrip.id); }} />
                  </div>
                )}
              </div>

              <div id="trip-panel-places" role="tabpanel" aria-label={t.app.tabs.places} hidden={activeTripTab !== "places"}>
                <SegmentControl
                  label={t.app.placesSectionPicker}
                  id="places"
                  items={placeSegments}
                  active={placesSegment}
                  onSelect={(segment) => selectSegment("places", segment)}
                />
                <div id="places-segment-panel-wishlist" role="tabpanel" aria-labelledby="places-segment-wishlist" hidden={placesSegment !== "wishlist"}>
                  <TripPlaceWorkspace
                    key={selectedTrip.id}
                    trip={selectedTrip}
                    request={request}
                    placesRevision={workspaceRevision}
                    onPlacesChanged={placesChanged}
                  />
                </div>
                <div id="places-segment-panel-discovery" role="tabpanel" aria-labelledby="places-segment-discovery" hidden={placesSegment !== "discovery"}>
                  <DiscoveryWorkspace
                    key={selectedTrip.id}
                    trip={selectedTrip}
                    request={request}
                    placesRevision={workspaceRevision}
                    onPlacesChanged={placesChanged}
                  />
                </div>
              </div>

              <div id="trip-panel-members" role="tabpanel" aria-label={t.app.tabs.members} hidden={activeTripTab !== "members"} className="grid gap-5">
                <TripMembersWorkspace trip={selectedTrip} currentUser={user} onChanged={() => loadTrip(selectedTrip.id)} request={request} />
                <TripHistory key={selectedTrip.id} tripId={selectedTrip.id} revision={workspaceRevision} active={activeTripTab === "members"} request={request} />
              </div>
            </>
          ) : (
            <FirstTripOnboarding onCreateTrip={openCreateTrip} />
          )}
        </div>
      </div>
      {selectedTrip ? <TripNavigation layout="mobile" activeTab={activeTripTab} selectTab={selectTab} itinerarySegment={itinerarySegment} selectItinerarySegment={(segment) => selectSegment("itinerary", segment)} /> : null}
      <CreateTripDialog
        open={createDialogOpen}
        onOpenChange={changeCreateDialogOpen}
        createTrip={createTrip}
      />
    </main>
  );
}
