import { type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode, Fragment, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import {
  parseApiError,
  parseInviteResponse,
  parseMagicLinkConsumeResponse,
  parseMagicLinkConfirmationResponse,
  parseSessionResponse,
  parseTripListResponse,
  parseTripResponse,
  type CreateTripInput,
  type MagicLinkConsumeResponse,
  type MagicLinkConfirmationResponse,
  type SessionResponse,
  type TripDto,
  type TripSummaryDto,
  type UserDto,
} from "@along-the-way/contracts/private-trips";

import { CalendarDays, ChevronRight, ChevronsUpDown, MapPin, MessageSquareText, Route, Users } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AdminView } from "./AdminView";
import { AccountSettingsDialog } from "./AccountSettingsDialog";
import { CreateTripDialog } from "./CreateTripDialog";
import { AppToaster, notify } from "./AppToaster";
import { FeedbackDialog } from "./FeedbackDialog";
import { FirstTripOnboarding } from "./FirstTripOnboarding";
import { LoginExperience, LoginConfirmation, AuthProgress, type AuthProgressPhase } from "./LoginExperience";
import { auth } from "./locales/zh-TW/auth";
import { DiscoveryWorkspace } from "./DiscoveryWorkspace";
import { TripSkeletonWorkspace } from "./TripSkeletonWorkspace";
import { TripPlaceWorkspace } from "./TripPlaceWorkspace";
import { TripPlanningSettings } from "./TripPlanningSettings";
import { TravelWorkspace } from "./TravelWorkspace";
import { useI18n, type Messages } from "./i18n";
import { canArrangeItinerary } from "./trip-permissions";
import { parseTripSkeletonResponse, type TripSkeletonResponse } from "@along-the-way/contracts/trip-skeleton";
import { parseTripPlaceListResponse, type TripPlaceListResponse } from "@along-the-way/contracts/trip-places";
import { TodayWorkspace } from "./TodayWorkspace";
import type { WholeTripPlannerLaunch } from "./WholeTripPlanning";
import { TripOnboardingChecklist } from "./TripOnboardingChecklist";
import { createTodayModel, tripClock } from "./today-model";
import { PENDING_SERVER_LOGOUT_STORAGE_KEY, TodaySnapshotStore, TODAY_SCHEMA_VERSION, TODAY_SIGNED_OUT_STORAGE_KEY, type TodaySnapshot } from "./today-snapshot";
import {
  defaultSegment,
  itinerarySegmentIds,
  membersSegmentIds,
  placesSegmentIds,
  readTripLocation,
  tripTabIds,
  writeTripLocation,
  writeTripOverviewFilter,
  type ItinerarySegment,
  type MembersSegment,
  type PlacesSegment,
  type TripSegment,
  type TripTab,
} from "./trip-location";
import { ApiRequestError, localizedApiErrorMessage } from "./api-error";
import { useTripLiveUpdates } from "./useTripLiveUpdates";
import { useDiscoveryJob, useDiscoveryJobTitle, type DiscoveryJobBadge } from "./useDiscoveryJob";
import { useScheduleToast } from "./ScheduleToast";
import { focusDiscoveryBatch } from "./DiscoveryInvestigate";
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



class LoginConfirmationRequired extends Error {
  constructor(readonly details: MagicLinkConfirmationResponse) {
    super(details.error.message);
  }
}

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
    if (response.status === 409 && parsed.error.code === "confirmation_required") {
      throw new LoginConfirmationRequired(parseMagicLinkConfirmationResponse(value));
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
      parsed.error.transitCallsNeeded,
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
type GlobalView = "admin" | null;

function readGlobalView(): GlobalView {
  return new URL(window.location.href).searchParams.get("view") === "admin" ? "admin" : null;
}



interface TripMembersWorkspaceProps {
  trip: TripDto;
  currentUser: UserDto;
  /** Which responsibility is shown: people, your own profile, invitations or permissions. */
  segment: MembersSegment;
  onChanged: () => Promise<void>;
  onProfileSaved(user: UserDto): void;
  request<T>(url: string, options?: RequestOptions): Promise<T>;
}

function TripMembersWorkspace({ trip, currentUser, segment, onChanged, onProfileSaved, request }: TripMembersWorkspaceProps) {
  const { t } = useI18n();
  const [inviteEmail, setInviteEmail] = useState("");
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
      await onChanged();
      notify("success", t.app.invitationSent(response.invite.email));
    } catch (error) {
      notify("error", error instanceof Error ? error.message : t.app.unableInviteMember);
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
      notify("error", error instanceof Error ? error.message : t.errors.unknown);
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
      notify("error", error instanceof Error ? error.message : t.errors.unknown);
    }
  }

  const [savingArrange, setSavingArrange] = useState(false);
  async function setEditorsCanSchedule(enabled: boolean) {
    const identity = `editors-can-schedule:${enabled}`;
    setSavingArrange(true);
    try {
      await request(`/api/trips/${trip.id}/editors-can-schedule`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Idempotency-Key": actionKey(identity) },
        body: JSON.stringify({ enabled }),
      });
      actionKeys.current.delete(identity);
      await onChanged();
    } catch (error) {
      notify("error", error instanceof Error ? error.message : t.errors.unknown);
    } finally {
      setSavingArrange(false);
    }
  }

  const [nickname, setNickname] = useState(currentUser.displayName ?? "");
  const [savingNickname, setSavingNickname] = useState(false);
  useEffect(() => { setNickname(currentUser.displayName ?? ""); }, [currentUser.displayName]);
  async function saveNickname(event: FormEvent) {
    event.preventDefault();
    setSavingNickname(true);
    try {
      const { user } = await request<{ user: UserDto }>("/api/session/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: nickname.trim() || null }),
        parse: parseSessionResponse,
      });
      onProfileSaved(user);
      await onChanged();
      notify("success", t.app.membersPage.nicknameSaved);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : t.errors.unknown);
    } finally {
      setSavingNickname(false);
    }
  }

  const page = t.app.membersPage;
  const isOwner = trip.role === "owner";
  const pendingInvites = trip.invites.filter((invite) => invite.status === "pending");
  const panelClass = "rounded-card border border-ink/10 bg-surface p-5 shadow-card sm:p-8";

  if (segment === "profile") {
    return (
      <section className={panelClass} aria-labelledby="members-profile-title">
        <h3 id="members-profile-title" className="font-display text-2xl">{page.profileTitle}</h3>
        <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">{page.profileHelp}</p>
        <form className="mt-5 grid max-w-md gap-2" onSubmit={saveNickname}>
          <label className="grid gap-1 font-semibold" htmlFor="member-nickname">{page.nicknameLabel}</label>
          <input
            id="member-nickname"
            className="min-h-11 rounded-lg border px-3 outline-none focus:border-focus focus:ring-2 focus:ring-focus/30"
            maxLength={40}
            placeholder={page.nicknamePlaceholder}
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
          />
          <small className="text-muted-foreground">{page.nicknameHint}</small>
          <button className="mt-2 min-h-11 justify-self-start rounded-xl bg-ink-strong px-4 font-bold text-white outline-none hover:bg-ink focus:ring-4 focus:ring-focus/30 disabled:opacity-60" disabled={savingNickname || nickname.trim() === (currentUser.displayName ?? "")}>
            {savingNickname ? page.savingNickname : page.saveNickname}
          </button>
        </form>
        <dl className="mt-8 grid max-w-xl gap-4 border-t border-ink/10 pt-6 sm:grid-cols-[10rem_1fr]">
          <dt className="text-sm text-muted-foreground">{page.loginEmail}</dt>
          <dd className="[overflow-wrap:anywhere]">{currentUser.email}</dd>
          <dt className="text-sm text-muted-foreground">{page.roleInTrip}</dt>
          <dd>{t.app.role(trip.role)}</dd>
          <dt className="text-sm text-muted-foreground">{page.whatYouCanDo}</dt>
          <dd>
            <ul className="grid gap-1">
              <li>{page.canDoCollaborate}</li>
              <li>{canArrangeItinerary(trip) ? page.canDoArrange : page.cannotArrange}</li>
              {isOwner ? <li>{page.canDoManage}</li> : null}
            </ul>
          </dd>
        </dl>
      </section>
    );
  }

  if (segment === "invites" && isOwner) {
    return (
      <section className={panelClass} aria-labelledby="members-invites-title">
        <h3 id="members-invites-title" className="font-display text-2xl">{page.invitesTitle}</h3>
        <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">{page.invitesHelp}</p>
        <form className="mt-5 grid max-w-md gap-3" onSubmit={inviteMember}>
          <label className="grid gap-1 font-semibold">
            {t.app.inviteEditorByEmail}
            <input className="min-h-11 rounded-lg border px-3 outline-none focus:border-focus focus:ring-2 focus:ring-focus/30" type="email" required value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} />
          </label>
          <button className="min-h-11 justify-self-start rounded-xl bg-ink-strong px-4 font-bold text-white outline-none hover:bg-ink focus:ring-4 focus:ring-focus/30">{t.app.sendInvitation}</button>
        </form>
        <h4 className="mt-8 font-semibold">{t.app.pendingInvitations}</h4>
        <ul className="mt-3 grid max-w-xl gap-3">
          {pendingInvites.map((invite) => (
            <li key={invite.id} className="flex min-h-14 items-center justify-between gap-3 rounded-xl bg-surface-subtle px-4 py-3">
              <span className="min-w-0 [overflow-wrap:anywhere]">{invite.email}</span>
              <button className="min-h-11 rounded-lg border px-3 text-sm font-bold outline-none hover:bg-surface focus:ring-4 focus:ring-focus/30" onClick={() => void revokeInvite(invite.id)}>{t.app.revoke}</button>
            </li>
          ))}
          {pendingInvites.length === 0 ? <li className="text-muted-foreground">{t.app.noPendingInvitations}</li> : null}
        </ul>
      </section>
    );
  }

  if (segment === "permissions") {
    return (
      <section className={panelClass} aria-labelledby="members-permissions-title">
        <h3 id="members-permissions-title" className="font-display text-2xl">{page.permissionsTitle}</h3>
        <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">{page.permissionsHelp}</p>
        {isOwner ? (
          <label className="mt-5 flex max-w-xl min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-ink/10 px-4 py-3">
            <input
              type="checkbox"
              className="mt-1 size-5 shrink-0 accent-[var(--accent)]"
              checked={trip.editorsCanSchedule}
              disabled={savingArrange}
              onChange={(event) => void setEditorsCanSchedule(event.target.checked)}
            />
            <span>
              <strong className="block">{t.app.editorsCanSchedule}</strong>
              <small className="text-muted-foreground">{t.app.editorsCanScheduleHelp}</small>
            </span>
          </label>
        ) : (
          <div className="mt-5 grid max-w-xl gap-1 rounded-xl bg-surface-subtle px-4 py-3">
            <p>{trip.editorsCanSchedule ? t.app.editorsCanScheduleGranted : page.editorsCannotSchedule}</p>
            <small className="text-muted-foreground">{page.permissionsReadOnly}</small>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className={panelClass} aria-labelledby="members-people-title">
      <h3 id="members-people-title" className="font-display text-2xl">{page.peopleTitle}</h3>
      <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">{page.peopleHelp(trip.members.length)}</p>
      <ul className="mt-5 grid max-w-2xl gap-3">
        {trip.members.map((member) => {
          const memberLabel = member.displayName ?? member.email ?? "成員";
          const memberDetail = member.displayName ? member.email : page.noNickname;
          return (
            <li key={member.id} className="flex min-h-16 items-center gap-3 rounded-xl bg-surface-subtle px-4 py-3">
              <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-ink-strong font-bold text-on-dark">
                {memberLabel.slice(0, 1).toLocaleUpperCase()}
              </span>
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <strong className="block">{memberLabel}{member.userId === currentUser.id ? `（${t.app.you}）` : ""}</strong>
                <small className="block text-muted-foreground">
                  {t.app.role(member.role)}{memberDetail ? `・${memberDetail}` : ""}
                </small>
              </span>
              {isOwner && member.role === "editor" ? (
                <button className="min-h-11 rounded-lg border border-accent-strong px-3 text-sm font-bold text-accent-strong outline-none hover:bg-surface focus:ring-4 focus:ring-focus/30" onClick={() => void removeMember(member.userId)}>
                  {t.app.remove}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TripSwitcher({ trips, selectedTrip, openCreateTrip, selectTrip }: {
  trips: TripSummaryDto[];
  selectedTrip: TripDto | null;
  openCreateTrip(returnFocus?: HTMLElement | null): void;
  selectTrip(tripId: string): void;
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
      </DialogContent>
    </Dialog>
  );
}

/** 調查 status on 地點 and 幫我找: a dot while it runs, then the new-place count or 「!」 until seen. */
function DiscoveryNavBadge({ badge }: { badge: DiscoveryJobBadge | null }) {
  const { t } = useI18n();
  if (!badge) return null;
  const label = badge.kind === "running" ? t.discovery.run.badgeRunning
    : badge.kind === "failed" ? t.discovery.run.badgeFailed
      : t.discovery.run.badgeDone(badge.count);
  return (
    <span className="atw-nav-badge" data-kind={badge.kind} role="img" aria-label={label}>
      {badge.kind === "done" ? badge.count : badge.kind === "failed" ? "!" : null}
    </span>
  );
}

function TripNavigation({ layout, activeTab, selectTab, itinerarySegment, selectItinerarySegment, membersSegment, membersSegments, selectMembersSegment, openFeedback, placesBadge }: {
  layout: "mobile" | "desktop";
  activeTab: TripTab;
  selectTab(tab: TripTab): void;
  itinerarySegment: ItinerarySegment;
  selectItinerarySegment(segment: ItinerarySegment): void;
  membersSegment: MembersSegment;
  /** The 成員 sub-pages this member can open (邀請 is owner-only). */
  membersSegments: readonly MembersSegment[];
  selectMembersSegment(segment: MembersSegment): void;
  /** Opens the 反饋 dialog; an action next to the tabs, not a destination. */
  openFeedback(trigger: HTMLElement): void;
  placesBadge: DiscoveryJobBadge | null;
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
              {value === "places" ? <DiscoveryNavBadge badge={placesBadge} /> : null}
            </button>
            {/* Desktop child bar under 行程 and 成員; mobile uses the segment strip at the top of the
                panel because the bottom bar has no room. The bars stay mounted so they can expand
                and collapse; a collapsed bar is inert, so keyboards and screen readers skip it. */}
            {layout === "desktop" && value === "itinerary" ? (
              <div className="atw-railnav__expander" data-open={activeTab === "itinerary"} inert={activeTab !== "itinerary"}>
                <div className="atw-railnav__children" role="group" aria-label={t.app.itinerarySectionPicker}>
                  {itinerarySegmentIds.map((segment, index) => (
                    <button
                      key={segment}
                      type="button"
                      data-itinerary-child={segment}
                      aria-current={itinerarySegment === segment ? "page" : undefined}
                      className={itinerarySegment === segment ? "is-active" : ""}
                      style={{ "--atw-child-index": index } as CSSProperties}
                      onClick={() => selectItinerarySegment(segment)}
                    >
                      {t.app.itinerarySegments[segment]}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {layout === "desktop" && value === "members" ? (
              <div className="atw-railnav__expander" data-open={activeTab === "members"} inert={activeTab !== "members"}>
                <div className="atw-railnav__children" role="group" aria-label={t.app.membersSectionPicker}>
                  {membersSegments.map((segment, index) => (
                    <button
                      key={segment}
                      type="button"
                      data-members-child={segment}
                      aria-current={membersSegment === segment ? "page" : undefined}
                      className={membersSegment === segment ? "is-active" : ""}
                      style={{ "--atw-child-index": index } as CSSProperties}
                      onClick={() => selectMembersSegment(segment)}
                    >
                      {t.app.membersSegments[segment]}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </Fragment>
        ))}
      </div>
      <button
        type="button"
        className="atw-nav-feedback"
        data-layout={layout}
        aria-haspopup="dialog"
        onClick={(event) => openFeedback(event.currentTarget)}
      >
        <MessageSquareText aria-hidden="true" className={layout === "mobile" ? "size-[22px]" : "size-5"} />
        <span>{t.app.feedbackNav}</span>
      </button>
    </nav>
  );
}

function SegmentControl<T extends string>({ label, id, items, active, onSelect, badges }: {
  label: string;
  id: string;
  items: readonly { value: T; label: string }[];
  active: T;
  onSelect(value: T): void;
  badges?: Partial<Record<T, ReactNode>>;
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
          {badges?.[item.value]}
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
  const authenticating = useRef(false);
  const signedOut = useRef(false);
  const loadSequence = useRef(0);
  const sessionEpoch = useRef(0);
  const [store] = useState(() => {
    try { return new TodaySnapshotStore(window.localStorage); } catch { return null; }
  });
  const pendingLogoutTarget = useRef<string | null>(store?.pendingServerLogoutUserId() ?? null);
  const [pendingLogoutUserId, setPendingLogoutUserId] = useState(pendingLogoutTarget.current);
  const rememberPendingLogout = useCallback((userId: string | null) => {
    pendingLogoutTarget.current = userId;
    setPendingLogoutUserId(userId);
    store?.setServerLogoutPending(userId);
  }, [store]);
  const restoreSessionAfterTargetMismatch = useRef<() => void>(() => {});
  const pendingLogoutReplay = useRef<Promise<void> | null>(null);
  const replayPendingLogout = useCallback(async () => {
    const target = pendingLogoutTarget.current;
    if (!target || !navigator.onLine) return;
    let replay = pendingLogoutReplay.current;
    if (!replay) {
      replay = (async () => {
        let targetMismatch = false;
        try {
          await requestJson<void>(t.errors, "/api/logout", {
            method: "POST",
            body: JSON.stringify({ userId: target }),
          });
        } catch (reason) {
          if (!(reason instanceof ApiRequestError) || reason.code !== "logout_target_mismatch") throw reason;
          targetMismatch = true;
        }
        if (pendingLogoutTarget.current === target) {
          rememberPendingLogout(null);
          if (targetMismatch) restoreSessionAfterTargetMismatch.current();
        }
      })();
      pendingLogoutReplay.current = replay;
    }
    try {
      await replay;
    } finally {
      if (pendingLogoutReplay.current === replay) pendingLogoutReplay.current = null;
    }
  }, [rememberPendingLogout, t.errors]);
  const [todaySnapshot, setTodaySnapshot] = useState<TodaySnapshot | null>(null);
  const [offline, setOffline] = useState(false);
  const [persisted, setPersisted] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(() => readTripLocation().day);
  const request = useCallback(async <T,>(url: string, options: RequestOptions = {}): Promise<T> => {
    if (url !== "/api/logout" && url !== "/api/logout-everywhere") await replayPendingLogout();
    if (options.method && !["GET", "HEAD"].includes(options.method.toUpperCase()) && (readOnly.current || !navigator.onLine)) {
      throw new Error(t.today.mutationDisabled);
    }
    const isRead = !options.method || ["GET", "HEAD"].includes(options.method.toUpperCase());
    const tripRead = isRead ? url.match(/^\/api\/trips\/([^/?]+)(?:\/(?:skeleton|trip-places))?$/) : null;
    const coreRead = isRead && (tripRead || url === "/api/session" || url === "/api/trips");
    // Optional reads: a failure stays with the feature that asked; it never starts the whole-trip re-read cycle.
    const optionalPlaceRead = isRead && /^\/api\/trips\/[^/?]+\/(?:place-details|place-previews|discovery\/jobs\/latest)(?:\?|$)/.test(url);
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
  }, [replayPendingLogout, store, t.errors, t.today.mutationDisabled]);
  const [user, setUser] = useState<UserDto | null | undefined>(undefined);
  const [sessionDenied, setSessionDenied] = useState(() => store?.isLocallySignedOut() ?? false);
  const [sessionRestoreUnavailable, setSessionRestoreUnavailable] = useState(false);
  const [globalView, setGlobalView] = useState<GlobalView>(readGlobalView);
  const [signingOutEverywhere, setSigningOutEverywhere] = useState(false);
  const [trips, setTrips] = useState<TripSummaryDto[]>([]);
  const [selectedTrip, setSelectedTrip] = useState<TripDto | null>(null);
  const [plannerLaunch, setPlannerLaunch] = useState<{ tripId: string; launch: WholeTripPlannerLaunch } | null>(null);
  const [error, setError] = useState("");
  const [todayMutationError, setTodayMutationError] = useState<{ tripId: string; message: string } | null>(null);
  const [adminRouteError, setAdminRouteError] = useState("");
  const [accepting, setAccepting] = useState(false);
  const inviteKey = useRef<string | null>(null);
  const createTripKey = useRef<string | null>(null);
  useEffect(() => {
    if (error) notify("error", error);
  }, [error]);
  const [authFragment, setAuthFragment] = useState<AuthFragment>(readAuthFragment);
  const authFragmentRef = useRef(authFragment);
  const consumeRequests = useRef(new Map<string, Promise<MagicLinkConsumeResponse>>());
  const completedAuthKeys = useRef(new Set<string>());
  const [authAttempt, setAuthAttempt] = useState(0);
  const [retryMagicToken, setRetryMagicToken] = useState<string | null>(null);
  const [signInError, setSignInError] = useState("");
  const [loginConfirmation, setLoginConfirmation] = useState<{
    details: MagicLinkConfirmationResponse;
    code?: { email: string; code: string };
  } | null>(null);
  const confirmedMagicToken = useRef<string | null>(null);
  const pendingCodeSession = useRef<MagicLinkConsumeResponse | null>(null);
  const [authProgressPhase, setAuthProgressPhase] = useState<AuthProgressPhase>(
    () => authFragment.magicToken ? "consuming-link" : "restoring",
  );
  restoreSessionAfterTargetMismatch.current = () => {
    const needsRestore = signedOut.current || store?.isLocallySignedOut();
    store?.setLocallySignedOut(false);
    if (!needsRestore) return;
    ++sessionEpoch.current;
    signedOut.current = false;
    setSessionDenied(false);
    completedAuthKeys.current.delete("session");
    confirmedMagicToken.current = null;
    pendingCodeSession.current = null;
    removeTokenFragment("magicToken");
    const nextAuthFragment = { ...authFragmentRef.current, magicToken: null };
    authFragmentRef.current = nextAuthFragment;
    setAuthFragment(nextAuthFragment);
    setRetryMagicToken(null);
    setAuthProgressPhase("restoring");
    setUser(undefined);
    setAuthAttempt((attempt) => attempt + 1);
  };
  const [shellEntering, setShellEntering] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const createDialogReturnFocus = useRef<HTMLElement | null>(null);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const accountSettingsReturnFocus = useRef<HTMLElement | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const feedbackReturnFocus = useRef<HTMLElement | null>(null);
  const [onboardingFacts, setOnboardingFacts] = useState<OnboardingFacts | null>(null);
  const [createdTripId, setCreatedTripId] = useState<string | null>(null);
  const [placesRevision, setPlacesRevision] = useState(0);
  const [photoRevision, setPhotoRevision] = useState(0);
  const [syncRevision, setSyncRevision] = useState(0);
  const workspaceRevision = placesRevision + syncRevision;
  const placesChanged = useCallback(() => {
    setPlacesRevision((revision) => revision + 1);
  }, []);
  const photoRemoved = useCallback(() => {
    setPhotoRevision((revision) => revision + 1);
  }, []);
  const [activeTripTab, setActiveTripTab] = useState<TripTab>(() => readTripLocation().tab ?? "itinerary");
  const [activeSegment, setActiveSegment] = useState<TripSegment | null>(() => {
    const location = readTripLocation();
    return location.segment ?? defaultSegment(location.tab ?? "itinerary");
  });
  const clearLocalSession = useCallback(() => {
    ++sessionEpoch.current;
    signedOut.current = true;
    setSessionDenied(true);
    const owner = accountId.current ?? store?.lastAccount();
    if (owner) store?.clearAccount(owner);
    accountId.current = null;
    ++loadSequence.current;
    readOnly.current = false;
    setTodaySnapshot(null);
    setOnboardingFacts(null);
    setSessionRestoreUnavailable(false);
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

  const openAccountSettings = useCallback((returnFocus?: HTMLElement | null) => {
    accountSettingsReturnFocus.current = returnFocus instanceof HTMLElement
      ? returnFocus
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setAccountSettingsOpen(true);
  }, []);

  const changeAccountSettingsOpen = useCallback((open: boolean) => {
    setAccountSettingsOpen(open);
    if (!open) {
      window.requestAnimationFrame(() => accountSettingsReturnFocus.current?.focus());
    }
  }, []);
  const openFeedback = useCallback((trigger: HTMLElement) => {
    // The 反饋 button is passed in: Safari does not focus a clicked button, so activeElement is unreliable.
    feedbackReturnFocus.current = trigger;
    setAccountSettingsOpen(false);
    setFeedbackOpen(true);
  }, []);

  const changeFeedbackOpen = useCallback((open: boolean) => {
    setFeedbackOpen(open);
    if (!open) {
      window.requestAnimationFrame(() => feedbackReturnFocus.current?.focus());
    }
  }, []);

  const openAdmin = useCallback(() => {
    if (!user?.isAdmin) return;
    setAdminRouteError("");
    const url = new URL(window.location.href);
    url.searchParams.set("view", "admin");
    for (const key of ["trip", "tab", "segment", "day", "days", "repair"]) {
      url.searchParams.delete(key);
    }
    window.history.pushState({}, "", url);
    ++loadSequence.current;
    setGlobalView("admin");
    setSelectedTrip(null);
    setTodaySnapshot(null);
    setOnboardingFacts(null);
    setAccountSettingsOpen(false);
  }, [user?.isAdmin]);




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
    setTodayMutationError((current) => current?.tripId === tripId ? null : current);
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
    if (readGlobalView() === "admin") {
      const url = new URL(window.location.href);
      url.searchParams.delete("view");
      window.history.replaceState({}, "", url);
    }
    setGlobalView(null);
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
    if (readGlobalView() === "admin") {
      readOnly.current = false;
      setOffline(false);
      setAdminRouteError(t.admin.unavailable);
      return false;
    }
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
  }, [store, t.admin.unavailable]);

  const deferSessionRestore = useCallback(() => {
    setUser(undefined);
    const restored = restoreSnapshot();
    setSessionRestoreUnavailable(!restored);
    if (!restored) {
      // restoreSnapshot can enter its no-snapshot shell; session identity is still unknown.
      readOnly.current = false;
      setOffline(false);
    }
  }, [restoreSnapshot]);

  const reconnect = useCallback(async () => {
    if (sessionDenied || signedOut.current || store?.isLocallySignedOut() || reconnecting.current || authenticating.current) return;
    reconnecting.current = true;
    setRetrying(true);
    const epoch = sessionEpoch.current;
    const navigationSequence = loadSequence.current;
    let sessionRestored = false;
    try {
      const session = await request<{ user: UserDto }>("/api/session", { parse: parseSessionResponse });
      if (epoch !== sessionEpoch.current || navigationSequence !== loadSequence.current) return;
      sessionRestored = true;
      setSessionDenied(false);
      setSessionRestoreUnavailable(false);
      const previousAccount = accountId.current ?? store?.lastAccount();
      if (previousAccount && previousAccount !== session.user.id) {
        store?.clearAccount(previousAccount);
        setTodaySnapshot(null); setSelectedTrip(null); setOnboardingFacts(null); setTrips([]);
      }
      accountId.current = session.user.id;
      setUser(session.user);
      const requestedView = readGlobalView();
      const adminView = requestedView === "admin" && session.user.isAdmin;
      setGlobalView(adminView ? "admin" : null);
      if (requestedView === "admin" && !adminView) {
        const url = new URL(window.location.href);
        url.searchParams.delete("view");
        window.history.replaceState({}, "", url);
      }
      const available = await refreshTrips();
      if (epoch !== sessionEpoch.current || navigationSequence !== loadSequence.current) return;
      setAdminRouteError("");
      const tripId = adminView ? undefined : readTripLocation().trip ?? available[0]?.id;
      if (tripId) {
        await loadTrip(tripId);
        // Read synchronization refreshes mounted panels without triggering the mutation-to-Today effect.
        if (epoch === sessionEpoch.current) setSyncRevision((revision) => revision + 1);
      } else {
        setTodaySnapshot(null);
        setSelectedTrip(null);
        setOnboardingFacts(null);
        setOffline(false);
        readOnly.current = false;
      }
    } catch (reason) {
      if (epoch !== sessionEpoch.current || navigationSequence !== loadSequence.current) return;
      if (!sessionRestored && !(reason instanceof ApiRequestError && reason.status === 401)) {
        deferSessionRestore();
        return;
      }
      if (!(reason instanceof ApiRequestError) || ![401, 403, 404].includes(reason.status ?? 0)) restoreSnapshot();
      setError(reason instanceof Error ? reason.message : t.today.unavailable);
    } finally { reconnecting.current = false; setRetrying(false); }
  }, [deferSessionRestore, loadTrip, refreshTrips, request, restoreSnapshot, sessionDenied, store, t.today.unavailable]);

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
    const synchronizeSessionState = (event: StorageEvent) => {
      if (event.key === PENDING_SERVER_LOGOUT_STORAGE_KEY) {
        const target = event.newValue || null;
        pendingLogoutTarget.current = target;
        setPendingLogoutUserId(target);
      }
      if (event.key === TODAY_SIGNED_OUT_STORAGE_KEY) {
        if (event.newValue === "true") clearLocalSession();
        else if (event.newValue === null && pendingLogoutTarget.current === null) {
          restoreSessionAfterTargetMismatch.current();
        }
      }
    };
    window.addEventListener("storage", synchronizeSessionState);
    return () => window.removeEventListener("storage", synchronizeSessionState);
  }, [clearLocalSession]);

  useEffect(() => {
    const replay = () => { void replayPendingLogout().catch(() => {}); };
    replay();
    window.addEventListener("online", replay);
    return () => window.removeEventListener("online", replay);
  }, [replayPendingLogout]);

  useEffect(() => {
    const unavailable = () => { if (!sessionRestoreUnavailable) restoreSnapshot(); };
    const denied = (event: Event) => {
      const detail = (event as CustomEvent<{ tripId?: string; status: number }>).detail;
      if (detail.status === 401 || detail.tripId === readTripLocation().trip) {
        ++loadSequence.current;
        if (detail.status === 401) ++sessionEpoch.current;
        setTodaySnapshot(null); setSelectedTrip(null);
        setOffline(false); readOnly.current = false;
        if (detail.status === 401) {
          setSessionDenied(true);
          setSessionRestoreUnavailable(false);
          setUser(null); setTrips([]); accountId.current = null;
        }
      }
    };
    const navigate = () => {
      const requestedView = readGlobalView();
      if (requestedView === "admin" && user?.isAdmin) {
        ++loadSequence.current;
        setGlobalView("admin");
        readOnly.current = false;
        setOffline(false);
        setAdminRouteError(navigator.onLine ? "" : t.admin.unavailable);
        setTodaySnapshot(null);
        setSelectedTrip(null);
        setOnboardingFacts(null);
        return;
      }
      setGlobalView(null);
      setAdminRouteError("");
      if (requestedView === "admin") {
        const url = new URL(window.location.href);
        url.searchParams.delete("view");
        window.history.replaceState({}, "", url);
      }
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
        setLoginConfirmation(null);
        confirmedMagicToken.current = null;
        pendingCodeSession.current = null;
        setSignInError("");
        setRetryMagicToken(null);
        setOffline(false);
        readOnly.current = false;
        setAuthProgressPhase("consuming-link");
        setUser(undefined);
      }
    };
    window.addEventListener("offline", unavailable);
    window.addEventListener("today-api-unavailable", unavailable);
    window.addEventListener("today-access-denied", denied);
    window.addEventListener("popstate", navigate);
    window.addEventListener("hashchange", fragmentChanged);
    return () => {
      window.removeEventListener("offline", unavailable);
      window.removeEventListener("today-api-unavailable", unavailable); window.removeEventListener("today-access-denied", denied);
      window.removeEventListener("popstate", navigate);
      window.removeEventListener("hashchange", fragmentChanged);
    };
  }, [loadTrip, restoreSnapshot, sessionRestoreUnavailable, t.admin.unavailable, t.today.unavailable, user?.isAdmin]);

  useEffect(() => {
    if (sessionDenied) return;
    const online = () => { void reconnect(); };
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [reconnect, sessionDenied]);

  useEffect(() => {
    if (sessionDenied || (!offline && !sessionRestoreUnavailable)) return;
    const revalidate = () => {
      if ((sessionRestoreUnavailable || navigator.onLine) && document.visibilityState !== "hidden") void reconnect();
    };
    // An offline shell can reopen while navigator.onLine already reports true; the
    // browser then has no online transition to emit when the API becomes reachable.
    // Keep the existing snapshot recovery cadence; unknown sessions retry less often.
    // Events bypass the interval, and reconnect coalesces simultaneous signals.
    const interval = window.setInterval(revalidate, sessionRestoreUnavailable ? 15_000 : 2_000);
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
    };
  }, [offline, reconnect, sessionDenied, sessionRestoreUnavailable]);

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

  // 調查 runs in the background; following it here keeps the badge, toast and tab title working
  // while the member is on another page.
  const discoveryToast = useScheduleToast();
  const viewingDiscovery = Boolean(selectedTrip) && globalView !== "admin"
    && activeTripTab === "places" && activeSegment === "discovery";
  const discoveryJob = useDiscoveryJob({
    tripId: offline ? undefined : selectedTrip?.id,
    request,
    viewing: viewingDiscovery,
    onResult: (job) => {
      if (viewingDiscovery || !selectedTrip) return;
      const failed = job.status === "failed";
      const count = job.addedCount ?? 0;
      discoveryToast.show(
        failed ? t.discovery.run.toastFailed : count > 0 ? t.discovery.run.toastDone(count) : t.discovery.run.toastNone,
        {
          label: failed ? t.discovery.run.viewReason : t.discovery.run.view,
          href: `?trip=${encodeURIComponent(selectedTrip.id)}&tab=places&segment=discovery`,
          navigate: () => {
            selectSegment("places", "discovery");
            focusDiscoveryBatch();
          },
        },
      );
    },
  });
  useDiscoveryJobTitle(discoveryJob.badge, selectedTrip?.name, t.discovery.run);
  projectionFailure.current = retryReadModels;

  useEffect(() => {
    let active = true;
    const epoch = sessionEpoch.current;
    const magicToken = authFragment.magicToken;
    const codeSession = pendingCodeSession.current;
    const authKey = magicToken ?? "session";
    let authenticatedUser: UserDto | null = null;
    let linkedInviteOutcome: MagicLinkConsumeResponse["inviteOutcome"];
    void authAttempt;
    if (completedAuthKeys.current.has(authKey)) {
      return () => {
        active = false;
      };
    }
    authenticating.current = true;
    setSessionRestoreUnavailable(false);

    void (async () => {
      try {
        if (!magicToken && !codeSession && store?.isLocallySignedOut()) {
          completedAuthKeys.current.add(authKey);
          setSessionDenied(true);
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
              body: JSON.stringify({ token: magicToken, confirm: confirmedMagicToken.current === magicToken }),
              parse: (value) => parseMagicLinkConsumeResponse(value),
            });
            consumeRequests.current.set(magicToken, consumeRequest);
          }
          let consumed: MagicLinkConsumeResponse | SessionResponse;
          let linkConsumed = true;
          try {
            consumed = await consumeRequest;
          } catch (reason) {
            if (consumeRequests.current.get(magicToken) === consumeRequest) {
              consumeRequests.current.delete(magicToken);
            }
            if (!active || epoch !== sessionEpoch.current) return;
            if (reason instanceof LoginConfirmationRequired) {
              setUser(null);
              setLoginConfirmation({ details: reason.details });
              return;
            }
            if (
              reason instanceof ApiRequestError &&
              TERMINAL_MAGIC_CODES[reason.code]
            ) {
              completedAuthKeys.current.add(authKey);
              removeTokenFragment("magicToken");
              // People come back by clicking an old email link. If this browser is still signed
              // in, a used or expired link must not sign them out: keep the existing session.
              let sessionError: unknown = null;
              const existing = await request<SessionResponse>("/api/session", {
                parse: (value) => parseSessionResponse(value),
              }).catch((error: unknown) => { sessionError = error; return null; });
              if (!active) return;
              if (!existing) {
                const denied = sessionError instanceof ApiRequestError && sessionError.status === 401;
                // After an explicit sign-out, reconnect() refuses to run, so the reconnect page would
                // be a dead end: those users get the sign-in screen with the link explanation instead.
                const locallySignedOut = signedOut.current || store?.isLocallySignedOut();
                if (!denied && !locallySignedOut) {
                  // The link is spent but the session may still be valid: treat it like any other
                  // transient restore failure instead of claiming the user must sign in again.
                  if (epoch === sessionEpoch.current) deferSessionRestore();
                  return;
                }
                // A 401 already moved the app to signed-out (and bumped the epoch); still explain the link.
                setUser(null);
                setSignInError(`${reason.message} ${t.app.requestNewMagicLink}`);
                setRetryMagicToken(null);
                return;
              }
              if (epoch !== sessionEpoch.current) return;
              consumed = existing;
              linkConsumed = false;
            } else {
              setUser(null);
              setSignInError(
                reason instanceof ApiRequestError
                  && (reason.code === "rate_limited" || reason.status === 429)
                  ? t.app.magicLinkConsumeRateLimited
                  : t.app.unableConsumeMagicLink,
              );
              setRetryMagicToken(magicToken);
              return;
            }
          }
          if (!active || epoch !== sessionEpoch.current) return;
          completedAuthKeys.current.add(authKey);
          removeTokenFragment("magicToken");
          store?.setLocallySignedOut(false);
          signedOut.current = false;
          session = consumed;
          acceptedTripId = linkConsumed ? (consumed as MagicLinkConsumeResponse).acceptedTripId : undefined;
          linkedInviteOutcome = linkConsumed ? (consumed as MagicLinkConsumeResponse).inviteOutcome : undefined;
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
          if (codeSession) {
            pendingCodeSession.current = null;
            session = codeSession;
            acceptedTripId = codeSession.acceptedTripId;
            linkedInviteOutcome = codeSession.inviteOutcome;
            if (acceptedTripId || linkedInviteOutcome) {
              removeTokenFragment("inviteToken");
              const next = { ...authFragmentRef.current, inviteToken: null };
              authFragmentRef.current = next;
              setAuthFragment(next);
            }
          } else {
            session = await request<SessionResponse>("/api/session", {
              parse: (value) => parseSessionResponse(value),
            });
          }
          completedAuthKeys.current.add(authKey);
        }

        authenticatedUser = session.user;
        if (!active || epoch !== sessionEpoch.current) return;
        setSessionDenied(false);
        setAuthProgressPhase("loading-trips");
        const previousAccount = accountId.current ?? store?.lastAccount();
        if (previousAccount && previousAccount !== session.user.id) {
          store?.clearAccount(previousAccount);
        }
        accountId.current = session.user.id;
        const requestedView = readGlobalView();
        const adminView = !acceptedTripId && requestedView === "admin" && session.user.isAdmin;
        setGlobalView(adminView ? "admin" : null);
        if (requestedView === "admin" && !adminView) {
          const url = new URL(window.location.href);
          url.searchParams.delete("view");
          window.history.replaceState({}, "", url);
        }
        const available = await refreshTrips();
        if (!active || epoch !== sessionEpoch.current) return;
        setAdminRouteError("");
        const tripId = adminView ? undefined : acceptedTripId ?? readTripLocation().trip ?? available[0]?.id;
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
        if (!active || epoch !== sessionEpoch.current) return;
        if (!magicToken) completedAuthKeys.current.add(authKey);
        if (!magicToken && !codeSession && !authenticatedUser
          && !(reason instanceof ApiRequestError && reason.status === 401)) {
          deferSessionRestore();
          return;
        }
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
        if (reason instanceof ApiRequestError && reason.status === 401) setSessionDenied(true);
        setUser(null);
      } finally {
        if (active) authenticating.current = false;
      }
    })();
    return () => {
      active = false;
      authenticating.current = false;
    };
  }, [
    authAttempt,
    authFragment.magicToken,
    deferSessionRestore,
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
    const target = accountId.current ?? user?.id ?? null;
    if (target) rememberPendingLogout(target);
    store?.setLocallySignedOut(true);
    clearLocalSession();
    if (target && navigator.onLine) await replayPendingLogout().catch(() => {});
  }

  async function logoutEverywhere() {
    setSigningOutEverywhere(true);
    setError("");
    try {
      await request("/api/logout-everywhere", { method: "POST" });
      rememberPendingLogout(null);
      store?.setLocallySignedOut(true);
      clearLocalSession();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.app.unableSignOutEverywhere);
    } finally {
      setSigningOutEverywhere(false);
    }
  }

  async function verifyCode(email: string, code: string, confirm = false) {
    try {
      const result = await request<MagicLinkConsumeResponse>("/api/auth/magic-links/verify-code", {
        method: "POST", body: JSON.stringify({ email, code, confirm }),
        parse: parseMagicLinkConsumeResponse,
      });
      ++sessionEpoch.current;
      pendingCodeSession.current = result;
      store?.setLocallySignedOut(false);
      signedOut.current = false;
      completedAuthKeys.current.delete("session");
      removeTokenFragment("magicToken");
      const next = { ...authFragmentRef.current, magicToken: null };
      authFragmentRef.current = next;
      setAuthFragment(next);
      setUser(undefined);
      setAuthAttempt((attempt) => attempt + 1);
    } catch (reason) {
      if (reason instanceof LoginConfirmationRequired) {
        setLoginConfirmation({ details: reason.details, code: { email, code } });
        return;
      }
      throw reason;
    }
  }

  if (offline) {
    const offlineTripId = todaySnapshot?.model.tripId ?? readTripLocation().trip;
    return <main className="mx-auto min-h-screen w-[min(100%-1.25rem,58rem)] py-5">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-bold">{todaySnapshot?.model.tripName ?? t.app.tabs.today}</h1><button className="min-h-11 rounded-lg border px-4 font-bold" onClick={() => void logout()}>{t.app.signOut}</button></header>
      <p className="mb-4 text-sm">{t.today.offlineAccount}</p>
      {error ? <p className="mb-4" role="alert">{error}</p> : null}
      {todayMutationError && todayMutationError.tripId === offlineTripId ? <p className="mb-4" role="alert">{todayMutationError.message}</p> : null}
      {todaySnapshot ? <>
        <nav aria-label={t.today.savedTrips} className="mb-4 flex flex-wrap gap-2">{store?.forAccount(todaySnapshot.accountId).map((snapshot) => <button className="min-h-11 rounded-lg border px-3" key={snapshot.model.tripId} onClick={() => {
          writeTripLocation(snapshot.model.tripId, "today", null, null); restoreSnapshot();
        }}>{snapshot.model.tripName}</button>)}</nav>
        <TodayWorkspace model={todaySnapshot.model} fetchedAt={todaySnapshot.fetchedAt} selectedDate={selectedDate} onDayChanged={selectDay} offline retry={() => void reconnect()} retrying={retrying} photoRevision={photoRevision} />
      </> : <section><p role="status">{t.today.noSnapshot}</p><button className="mt-4 min-h-11 rounded-lg border px-4" onClick={() => void reconnect()} disabled={retrying}>{t.today.retry}</button></section>}
    </main>;
  }

  if (loginConfirmation) {
    return <LoginConfirmation
      targetEmail={loginConfirmation.details.targetEmail}
      currentEmail={loginConfirmation.details.currentEmail}
      confirm={() => {
        setLoginConfirmation(null);
        setUser(undefined);
        setAuthProgressPhase("consuming-link");
        if (loginConfirmation.code) {
          void verifyCode(loginConfirmation.code.email, loginConfirmation.code.code, true).catch((reason) => {
            setSignInError(reason instanceof Error ? reason.message : auth.invalidCode);
            setUser(null);
          });
        } else {
          confirmedMagicToken.current = authFragment.magicToken;
          setAuthAttempt((attempt) => attempt + 1);
        }
      }}
      cancel={() => {
        ++sessionEpoch.current;
        setLoginConfirmation(null);
        confirmedMagicToken.current = null;
        removeTokenFragment("magicToken");
        const next = { ...authFragmentRef.current, magicToken: null };
        authFragmentRef.current = next;
        setAuthFragment(next);
        completedAuthKeys.current.delete("session");
        setUser(undefined);
        setAuthAttempt((attempt) => attempt + 1);
      }}
    />;
  }

  if (user === undefined) {
    if (sessionRestoreUnavailable) {
      return (
        <main className="atw-auth-transition-surface auth-page">
          <section className="auth-card" aria-labelledby="session-restore-title">
            <div role="status">
              <h1 id="session-restore-title" className="auth-title auth-progress-title">
                {auth.sessionRestoreUnavailable}
              </h1>
            </div>
            <Button type="button" className="mt-6 min-h-11 px-5" onClick={() => void reconnect()} disabled={retrying}>
              {retrying ? auth.reconnecting : auth.reconnect}
            </Button>
          </section>
        </main>
      );
    }
    return <div className="atw-auth-transition-surface"><AuthProgress phase={authProgressPhase} /></div>;
  }
  if (user === null) {
    return (
      <div className="atw-auth-transition-surface">
        {pendingLogoutUserId ? (
          <p className="mx-auto mb-4 w-[min(100%-2rem,30rem)] rounded-xl border border-accent-strong/30 bg-surface-subtle p-3 text-sm text-accent-strong" role="alert">
            {t.app.pendingServerLogout}
          </p>
        ) : null}
        <LoginExperience
          initialError={signInError || null}
          inviteToken={authFragment.inviteToken}
          verifyCode={verifyCode}
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
          describeError={(reason) => reason instanceof ApiRequestError && reason.code === "invalid_magic_code"
            ? auth.invalidCode : reason instanceof Error ? reason.message : t.app.unableRequestLink}
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
  // 邀請 is the owner's job; other members do not get a page they cannot use.
  const availableMembersSegments = membersSegmentIds.filter((segment) => segment !== "invites" || selectedTrip?.role === "owner");
  const membersSegment = availableMembersSegments.includes(activeSegment as MembersSegment)
    ? activeSegment as MembersSegment
    : "people";
  const placeSegments = [
    { value: "wishlist", label: t.app.placesSegments.wishlist },
    { value: "discovery", label: t.app.placesSegments.discovery },
  ] as const;
  const openTravelSegment = (type: "flight" | "lodging") => {
    const segment: ItinerarySegment = type === "flight" ? "flight" : "lodging";
    selectSegment("itinerary", segment);
    // Focus whichever 航班／住宿 control is visible: rail child (desktop) or segment strip (mobile).
    window.requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>(`#itinerary-segment-${segment}, [data-itinerary-child="${segment}"]`)]
      .find((element) => element.offsetParent !== null)?.focus());
  };
  const selectTrip = (tripId: string) => {
    if (createdTripId && createdTripId !== tripId) setCreatedTripId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    url.searchParams.set("trip", tripId);
    url.searchParams.delete("tab");
    url.searchParams.delete("segment");
    url.searchParams.delete("day");
    url.searchParams.delete("days");
    url.searchParams.delete("repair");
    setGlobalView(null);
    window.history.pushState({}, "", url);
    void loadTrip(tripId).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t.today.unavailable));
  };

  const accountIdentity = user.displayName?.trim() || t.accountSettings.title;
  const accountInitialSource = user.displayName?.trim() || user.email.trim();
  const accountInitial = accountInitialSource.charAt(0).toLocaleUpperCase("zh-TW");
  const accountAccessibleLabel = `${t.accountSettings.title}，${user.email}`;
  const feedbackSegment = activeTripTab === "itinerary"
    ? t.app.itinerarySegments[itinerarySegment]
    : activeTripTab === "places"
      ? t.app.placesSegments[placesSegment]
      : activeTripTab === "members"
        ? t.app.membersSegments[membersSegment]
        : null;
  const feedbackPage = (globalView === "admin"
    ? t.admin.title
    : selectedTrip
      ? [selectedTrip.name, t.app.tabs[activeTripTab], feedbackSegment].filter(Boolean).join("・")
      : t.accountSettings.title
  ).slice(0, 200);

  return (
    <main
      className={`atw-shell min-w-0${shellEntering ? " is-entering" : ""}`}
      data-active-tab={globalView === "admin" ? "admin" : activeTripTab}
      data-has-trip={globalView !== "admin" && selectedTrip ? "true" : "false"}
    >
      <header className="atw-topbar">
        <div className="atw-topbar-content">
          <div className="min-w-0 flex-1">
            <TripSwitcher trips={trips} selectedTrip={selectedTrip} openCreateTrip={openCreateTrip} selectTrip={selectTrip} />
          </div>
          <button
            type="button"
            className={`atw-mobile-account${accountSettingsOpen ? " is-open" : ""}`}
            aria-label={accountAccessibleLabel}
            onClick={(event) => openAccountSettings(event.currentTarget)}
          >
            <span aria-hidden="true" className="atw-account-avatar">{accountInitial}</span>
          </button>
        </div>
      </header>

      <div className="atw-frame">
        <aside className="atw-rail">
          <TripSwitcher trips={trips} selectedTrip={selectedTrip} openCreateTrip={openCreateTrip} selectTrip={selectTrip} />
          {globalView !== "admin" && selectedTrip ? <TripNavigation layout="desktop" activeTab={activeTripTab} selectTab={selectTab} itinerarySegment={itinerarySegment} selectItinerarySegment={(segment) => selectSegment("itinerary", segment)} membersSegment={membersSegment} membersSegments={availableMembersSegments} selectMembersSegment={(segment) => selectSegment("members", segment)} openFeedback={openFeedback} placesBadge={discoveryJob.badge} /> : <div />}
          <div className="atw-account-footer">
            <button
              type="button"
              className={`atw-account-trigger${accountSettingsOpen ? " is-open" : ""}`}
              aria-label={accountAccessibleLabel}
              onClick={(event) => openAccountSettings(event.currentTarget)}
            >
              <span aria-hidden="true" className="atw-account-avatar">{accountInitial}</span>
              <span className="atw-account-trigger__identity">
                <strong title={accountIdentity}>{accountIdentity}</strong>
                <span title={user.email}>{user.email}</span>
              </span>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
            </button>
          </div>
        </aside>

        <div className="atw-main">
          {inviteToken ? (
            <section className="flex flex-wrap items-center justify-between gap-3 rounded-panel bg-ink-strong p-5 text-on-dark">
              <div><strong className="block text-lg">{t.app.tripInvitation}</strong><span>{t.app.acceptWithSignedInEmail}</span></div>
              <button className="min-h-11 rounded-xl bg-accent px-5 font-bold outline-none focus:ring-4 focus:ring-focus/40 disabled:opacity-60" disabled={accepting} onClick={() => void acceptInvitation()}>{accepting ? t.app.accepting : t.app.acceptInvitation}</button>
            </section>
          ) : null}

          {globalView === "admin" && user.isAdmin ? (
            <AdminView request={request} routeError={adminRouteError} onPhotoRemoved={photoRemoved} />
          ) : selectedTrip ? (
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
              {/* The trip name stays as the page's heading for screen readers; dates, currency, role and
                  version were noise above every page (dates live in the trip switcher). */}
              <h1 id="trip-title-heading" className="sr-only">{selectedTrip.name}</h1>
              {!liveConnected ? <p aria-live="polite" role="status" className="rounded-xl border border-ink/10 bg-surface-subtle p-3 text-sm text-muted-foreground">{t.collaboration.reconnecting}</p> : null}

              <div id="trip-panel-today" role="tabpanel" aria-label={t.app.tabs.today} hidden={activeTripTab !== "today"}>
                {todayMutationError && todayMutationError.tripId === selectedTrip.id ? <p className="mb-4" role="alert">{todayMutationError.message}</p> : null}
                {todaySnapshot ? (
                  <TodayWorkspace
                    key={todaySnapshot.model.tripId}
                    model={todaySnapshot.model}
                    fetchedAt={todaySnapshot.fetchedAt}
                    selectedDate={selectedDate}
                    onDayChanged={selectDay}
                    canArrange={canArrangeItinerary(selectedTrip)}
                    onArrangeDay={canArrangeItinerary(selectedTrip) ? (date) => {
                      writeTripOverviewFilter([date]);
                      selectSegment("itinerary", "daily");
                    } : undefined}
                    retry={() => void reconnect()}
                    retrying={retrying}
                    persisted={persisted}
                    photoRevision={photoRevision}
                    request={request}
                    onChanged={() => readTripLocation().trip === selectedTrip.id
                      ? loadTrip(selectedTrip.id, true)
                      : Promise.resolve()}
                    onPersistentError={(message) => setTodayMutationError(message ? { tripId: selectedTrip.id, message } : null)}
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
                      placesRevision={workspaceRevision}
                      onPlacesChanged={placesChanged}
                      onTravelEdit={openTravelSegment}
                      plannerLaunch={plannerLaunch?.tripId === selectedTrip.id ? plannerLaunch.launch : null}
                      onPlannerLaunchConsumed={() => setPlannerLaunch(null)}
                    />
                  </div>
                ) : itinerarySegment === "flight" ? (
                  <div id="itinerary-segment-panel-flight" role="tabpanel" aria-labelledby="itinerary-segment-flight">
                    <TravelWorkspace key={selectedTrip.id} trip={selectedTrip} type="flight" request={request} revision={workspaceRevision}
                      onChanged={async () => { placesChanged(); await loadTrip(selectedTrip.id); }} />
                  </div>
                ) : itinerarySegment === "lodging" ? (
                  <div id="itinerary-segment-panel-lodging" role="tabpanel" aria-labelledby="itinerary-segment-lodging">
                    <TravelWorkspace key={selectedTrip.id} trip={selectedTrip} type="lodging" request={request} revision={workspaceRevision}
                      onChanged={async () => { placesChanged(); await loadTrip(selectedTrip.id); }} />
                  </div>
                ) : (
                  <div id="itinerary-segment-panel-settings" role="tabpanel" aria-labelledby="itinerary-segment-settings">
                    <TripPlanningSettings
                      key={selectedTrip.id}
                      tripId={selectedTrip.id}
                      revision={workspaceRevision}
                      canEdit={canArrangeItinerary(selectedTrip)}
                      request={request}
                      onCreateReplanDraft={(drafts) => {
                        setPlannerLaunch({ tripId: selectedTrip.id, launch: drafts });
                        selectSegment("itinerary", "daily");
                      }}
                    />
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
                  badges={{ discovery: <DiscoveryNavBadge badge={discoveryJob.badge} /> }}
                />
                <div id="places-segment-panel-wishlist" role="tabpanel" aria-labelledby="places-segment-wishlist" hidden={placesSegment !== "wishlist"}>
                  <TripPlaceWorkspace
                    key={selectedTrip.id}
                    trip={selectedTrip}
                    accountId={user.id}
                    request={request}
                    photoRevision={photoRevision}
                    placesRevision={workspaceRevision}
                    onPlacesChanged={placesChanged}
                  />
                </div>
                <div id="places-segment-panel-discovery" role="tabpanel" aria-labelledby="places-segment-discovery" hidden={placesSegment !== "discovery"}>
                  <DiscoveryWorkspace
                    key={selectedTrip.id}
                    trip={selectedTrip}
                    accountId={user.id}
                    request={request}
                    photoRevision={photoRevision}
                    placesRevision={workspaceRevision}
                    onPlacesChanged={placesChanged}
                    job={discoveryJob.job}
                    onJobStarted={discoveryJob.track}
                  />
                </div>
              </div>

              <div id="trip-panel-members" role="tabpanel" aria-label={t.app.tabs.members} hidden={activeTripTab !== "members"} className="grid gap-5">
                <div className="lg:hidden">
                  <SegmentControl
                    label={t.app.membersSectionPicker}
                    id="members"
                    items={availableMembersSegments.map((value) => ({ value, label: t.app.membersSegments[value] }))}
                    active={membersSegment}
                    onSelect={(segment) => selectSegment("members", segment)}
                  />
                </div>
                <div id={`members-segment-panel-${membersSegment}`} role="tabpanel" aria-labelledby={`members-segment-${membersSegment}`}>
                  <TripMembersWorkspace trip={selectedTrip} currentUser={user} segment={membersSegment} onChanged={() => loadTrip(selectedTrip.id)} onProfileSaved={setUser} request={request} />
                </div>
              </div>
            </>
          ) : (
            <FirstTripOnboarding onCreateTrip={openCreateTrip} />
          )}
        </div>
      </div>
      {globalView !== "admin" && selectedTrip ? <TripNavigation layout="mobile" activeTab={activeTripTab} selectTab={selectTab} itinerarySegment={itinerarySegment} selectItinerarySegment={(segment) => selectSegment("itinerary", segment)} membersSegment={membersSegment} membersSegments={availableMembersSegments} selectMembersSegment={(segment) => selectSegment("members", segment)} openFeedback={openFeedback} placesBadge={discoveryJob.badge} /> : null}
      <CreateTripDialog
        open={createDialogOpen}
        onOpenChange={changeCreateDialogOpen}
        createTrip={createTrip}
      />
      <FeedbackDialog
        open={feedbackOpen}
        onOpenChange={changeFeedbackOpen}
        prefilledPage={feedbackPage}
        tripId={globalView === "admin" ? null : selectedTrip?.id ?? null}
        request={request}
      />
      <AccountSettingsDialog
        open={accountSettingsOpen}
        onOpenChange={changeAccountSettingsOpen}
        email={user.email}
        isAdmin={user.isAdmin}
        openAdmin={openAdmin}
        signOut={() => void logout()}
        signOutEverywhere={() => void logoutEverywhere()}
        signingOutEverywhere={signingOutEverywhere}
      />
      <AppToaster />
      {discoveryToast.toast}
    </main>
  );
}
