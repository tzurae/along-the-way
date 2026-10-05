import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import {
  parseApiError,
  parseInviteResponse,
  parseSessionResponse,
  parseTripListResponse,
  parseTripResponse,
  type CreateTripInput,
  type TripDto,
  type TripSummaryDto,
  type UserDto,
} from "@along-the-way/contracts/private-trips";

import { countryStopLabel } from "./country-stop-label";
import { CreateTripDialog } from "./CreateTripDialog";
import { DiscoveryWorkspace } from "./DiscoveryWorkspace";
import { TripSkeletonWorkspace } from "./TripSkeletonWorkspace";
import { TripPlaceWorkspace } from "./TripPlaceWorkspace";
import { TravelWorkspace } from "./TravelWorkspace";
import { useI18n, type Messages } from "./i18n";

const tripTabIds = ["overview", "discovery", "wishlist", "lodging", "itinerary", "recent"] as const;
type TripTab = (typeof tripTabIds)[number];

interface RequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}

const RECOVERABLE_MAGIC_CODES: Record<string, true> = {
  expired_magic_link: true,
  invalid_magic_link: true,
  revoked_magic_link: true,
  used_magic_link: true,
};

class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly correlationId?: string,
    readonly currentVersion?: number,
  ) {
    super(message);
  }
}

function localizedErrorMessage(
  messages: Messages["errors"],
  code: string,
  detail: string,
  correlationId?: string,
  currentVersion?: number,
) {
  const knownCode = code as keyof typeof messages.byCode;
  const base = Object.prototype.hasOwnProperty.call(messages.byCode, knownCode)
    ? messages.byCode[knownCode]
    : messages.unknown;
  const message =
    code === "validation_error" || code === "conflict"
      ? messages.withDetail(base, detail)
      : base;
  return [
    message,
    currentVersion === undefined ? "" : messages.currentVersion(currentVersion),
    correlationId ? messages.reference(correlationId) : "",
  ].filter(Boolean).join(" ");
}

async function requestJson<T>(
  messages: Messages["errors"],
  url: string,
  options: RequestOptions = {},
) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const value = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    let parsed;
    try {
      parsed = parseApiError(value);
    } catch {
      throw new Error(messages.unknown);
    }
    throw new ApiRequestError(
      parsed.error.code,
      localizedErrorMessage(
        messages,
        parsed.error.code,
        parsed.error.message,
        parsed.error.correlationId,
        parsed.error.currentVersion,
      ),
      parsed.error.correlationId,
      parsed.error.currentVersion,
    );
  }
  return (options.parse ? options.parse(value) : value) as T;
}

function tokenParameter(name: "magicToken" | "inviteToken") {
  return new URLSearchParams(window.location.hash.slice(1)).get(name);
}

function removeTokenFragment(remove: "magicToken" | "inviteToken") {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  fragment.delete(remove);
  url.hash = fragment.toString();
  window.history.replaceState({}, "", url);
}

function LoginPanel({
  initialMessage,
  pendingInviteToken,
}: {
  initialMessage: string;
  pendingInviteToken: string | null;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState(initialMessage);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await requestJson<{ message: string }>(
        t.errors,
        "/api/auth/magic-links",
        {
          method: "POST",
          body: JSON.stringify({
            email,
            ...(pendingInviteToken ? { inviteToken: pendingInviteToken } : {}),
          }),
        },
      );
      setMessage(t.app.magicLinkSent);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t.app.unableRequestLink);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto grid min-h-screen w-[min(100%-1.5rem,58rem)] place-items-center py-8">
      <section className="w-full max-w-[32rem] rounded-card border border-ink/10 bg-surface p-7 shadow-card sm:p-10">
        <p className="mb-3 text-xs font-bold tracking-[0.18em] text-accent-strong">
          ALONG THE WAY
        </p>
        <h1 className="font-display text-4xl leading-tight text-ink-strong">
          {t.app.planTogether}
        </h1>
        <p className="mt-4 text-muted-foreground">
          {t.app.signInDescription}
        </p>
        <form className="mt-8 grid gap-4" onSubmit={submit}>
          <label className="grid gap-2 font-semibold">
            {t.app.email}
            <input
              className="min-h-12 rounded-xl border border-ink/20 bg-white px-4 outline-none focus:border-focus focus:ring-2 focus:ring-focus/30"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <button
            className="min-h-12 rounded-xl bg-ink-strong px-5 font-bold text-on-dark outline-none hover:bg-ink focus:ring-4 focus:ring-focus/40 disabled:opacity-60"
            disabled={submitting}
          >
            {submitting ? t.app.sending : t.app.emailSignInLink}
          </button>
        </form>
        {message ? (
          <p className="mt-5 rounded-xl bg-surface-subtle p-4" role="status">
            {message}
          </p>
        ) : null}
      </section>
    </main>
  );
}


interface TripWorkspaceProps {
  trip: TripDto;
  currentUser: UserDto;
  onChanged: () => Promise<void>;
  request<T>(url: string, options?: RequestOptions): Promise<T>;
  revision: number;
  onTravelChanged(): Promise<void>;
}

function TripWorkspace({ trip, currentUser, onChanged, request, revision, onTravelChanged }: TripWorkspaceProps) {
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
      const response = await requestJson<{ invite: { email: string } }>(
        t.errors,
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
    await requestJson(t.errors, `/api/trips/${trip.id}/members/${userId}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": actionKey(identity) },
    });
    actionKeys.current.delete(identity);
    await onChanged();
  }

  async function revokeInvite(inviteId: string) {
    const identity = `revoke-invite:${inviteId}`;
    await requestJson(t.errors, `/api/trips/${trip.id}/invites/${inviteId}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": actionKey(identity) },
    });
    actionKeys.current.delete(identity);
    await onChanged();
  }

  return (
    <section className="rounded-card border border-ink/10 bg-surface p-5 shadow-card sm:p-8">
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
      <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-ink/10 sm:max-w-sm">
        <div className="bg-surface-subtle p-4"><strong className="block text-2xl">{trip.memberCount}</strong>{t.app.memberUnit}</div>
        <div className="bg-surface-subtle p-4"><strong className="block text-2xl">{trip.dayCount}</strong>{t.app.dayUnit}</div>
      </div>
      <div className="mt-8">
        <TravelWorkspace key={trip.id} trip={trip} type="flight" request={request} revision={revision} onChanged={onTravelChanged} />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <div>
          <h3 className="font-display text-2xl">{t.app.members}</h3>
          <ul className="mt-3 grid gap-3">
            {trip.members.map((member) => (
              <li key={member.id} className="flex min-h-14 items-center justify-between gap-3 rounded-xl bg-surface-subtle px-4 py-3">
                <span className="min-w-0 [overflow-wrap:anywhere]"><strong className="block">{member.displayName ?? member.email}</strong><small className="text-muted-foreground">{t.app.role(member.role)}{member.userId === currentUser.id ? `・${t.app.you}` : ""}</small></span>
                {trip.role === "owner" && member.role === "editor" ? (
                  <button className="min-h-10 rounded-lg border border-accent-strong px-3 text-sm font-bold text-accent-strong" onClick={() => void removeMember(member.userId)}>
                    {t.app.remove}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="font-display text-2xl">{t.app.pendingInvitations}</h3>
          <ul className="mt-3 grid gap-3">
            {trip.invites.filter((invite) => invite.status === "pending").map((invite) => (
              <li key={invite.id} className="flex min-h-14 items-center justify-between gap-3 rounded-xl bg-surface-subtle px-4 py-3">
                <span>{invite.email}</span>
                {trip.role === "owner" ? (
                  <button className="min-h-10 rounded-lg border px-3 text-sm font-bold" onClick={() => void revokeInvite(invite.id)}>{t.app.revoke}</button>
                ) : null}
              </li>
            ))}
            {trip.invites.every((invite) => invite.status !== "pending") ? <li className="text-muted-foreground">{t.app.noPendingInvitations}</li> : null}
          </ul>
          {trip.role === "owner" ? (
            <form className="mt-5 grid gap-3" onSubmit={inviteMember}>
              <label className="grid gap-1 font-semibold">
                {t.app.inviteEditorByEmail}
                <input className="min-h-11 rounded-lg border px-3" type="email" required value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} />
              </label>
              <button className="min-h-11 rounded-xl bg-ink-strong px-4 font-bold text-white">{t.app.sendInvitation}</button>
            </form>
          ) : null}
          {message ? <p className="mt-3" role="status">{message}</p> : null}
        </div>
      </div>
    </section>
  );
}

export function App() {
  const { t } = useI18n();
  const request = useCallback(
    <T,>(url: string, options: RequestOptions = {}) =>
      requestJson<T>(t.errors, url, options),
    [t.errors],
  );
  const [user, setUser] = useState<UserDto | null | undefined>(undefined);
  const [trips, setTrips] = useState<TripSummaryDto[]>([]);
  const [selectedTrip, setSelectedTrip] = useState<TripDto | null>(null);
  const [error, setError] = useState("");
  const [accepting, setAccepting] = useState(false);
  const inviteKey = useRef<string | null>(null);
  const createTripKey = useRef<string | null>(null);
  const [signInError, setSignInError] = useState("");
  const [placesRevision, setPlacesRevision] = useState(0);
  const placesChanged = useCallback(() => {
    setPlacesRevision((revision) => revision + 1);
  }, []);
  const [activeTripTab, setActiveTripTab] = useState<TripTab>("overview");
  const [recentChangesContainer, setRecentChangesContainer] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    setActiveTripTab("overview");
  }, [selectedTrip?.id]);


  const refreshTrips = useCallback(async () => {
    const response = await request<{ trips: TripSummaryDto[] }>("/api/trips", {
      parse: (value) => parseTripListResponse(value),
    });
    setTrips(response.trips);
    return response.trips;
  }, [request]);

  const loadTrip = useCallback(async (tripId: string) => {
    const response = await request<{ trip: TripDto }>(`/api/trips/${tripId}`, {
      parse: (value) => parseTripResponse(value),
    });
    setSelectedTrip(response.trip);
  }, [request]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const magicToken = tokenParameter("magicToken");
        if (magicToken) {
          await request("/api/auth/magic-links/consume", {
            method: "POST",
            body: JSON.stringify({ token: magicToken }),
            parse: (value) => parseSessionResponse(value),
          });
          removeTokenFragment("magicToken");
        }
        const session = await request<{ user: UserDto }>("/api/session", {
          parse: (value) => parseSessionResponse(value),
        });
        if (!active) return;
        setUser(session.user);
        const available = await refreshTrips();
        if (available[0]) await loadTrip(available[0].id);
      } catch (reason) {
        if (active) {
          setUser(null);
          if (
            reason instanceof ApiRequestError &&
            RECOVERABLE_MAGIC_CODES[reason.code]
          ) {
            setSignInError(
              `${reason.message} ${t.app.requestNewMagicLink}`,
            );
            removeTokenFragment("magicToken");
          }
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [loadTrip, refreshTrips, request, t.app.requestNewMagicLink]);

  async function acceptInvitation() {
    const token = tokenParameter("inviteToken");
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
      setSelectedTrip(response.trip);
      await refreshTrips();
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
  }

  async function logout() {
    await request("/api/logout", { method: "POST" });
    setUser(null);
    setTrips([]);
    setSelectedTrip(null);
  }

  if (user === undefined) {
    return <main className="grid min-h-screen place-items-center" role="status">{t.app.openingTrips}</main>;
  }
  if (user === null) {
    return (
      <LoginPanel
        initialMessage={signInError}
        pendingInviteToken={tokenParameter("inviteToken")}
      />
    );
  }

  const inviteToken = tokenParameter("inviteToken");
  const tripTabs = [
    { value: "overview", label: t.app.tabs.overview },
    { value: "discovery", label: t.app.tabs.discovery },
    { value: "wishlist", label: t.app.tabs.wishlist },
    { value: "lodging", label: t.app.tabs.lodging },
    { value: "itinerary", label: t.app.tabs.itinerary },
    { value: "recent", label: t.app.tabs.recent },
  ] as const;


  return (
    <main className="mx-auto min-h-screen w-[min(100%-1.25rem,96rem)] py-5 sm:py-8">
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-panel bg-surface/90 px-5 py-4 shadow-feedback">
        <div><p className="text-xs font-bold tracking-[0.14em] text-accent-strong">ALONG THE WAY</p><p className="text-sm text-muted-foreground">{t.app.signedInAs(user.email)}</p></div>
        <button className="min-h-10 rounded-lg border px-4 font-bold" onClick={() => void logout()}>{t.app.signOut}</button>
      </header>

      {inviteToken ? (
        <section className="my-5 flex flex-wrap items-center justify-between gap-3 rounded-panel bg-ink-strong p-5 text-on-dark">
          <div><strong className="block text-lg">{t.app.tripInvitation}</strong><span>{t.app.acceptWithSignedInEmail}</span></div>
          <button className="min-h-11 rounded-xl bg-accent px-5 font-bold" disabled={accepting} onClick={() => void acceptInvitation()}>{accepting ? t.app.accepting : t.app.acceptInvitation}</button>
        </section>
      ) : null}
      {error ? <p className="my-4 rounded-xl bg-surface p-4 text-accent-strong" role="alert">{error}</p> : null}

      <div className="my-6 grid gap-5 lg:grid-cols-[17rem_1fr]">
        <aside className="grid content-start gap-4">
          <CreateTripDialog createTrip={createTrip} />
          <nav aria-label={t.app.trips} className="grid gap-2">
            {trips.map((trip) => (
              <button key={trip.id} className={`min-h-14 rounded-xl border px-4 py-3 text-left outline-none focus:ring-4 focus:ring-focus/30 ${selectedTrip?.id === trip.id ? "border-accent-strong bg-surface" : "border-ink/10 bg-surface/70"}`} onClick={() => void loadTrip(trip.id)}>
                <strong className="block">{trip.name}</strong><small className="text-muted-foreground">{t.app.tripSummary(trip.memberCount, trip.dayCount)}</small>
              </button>
            ))}
            {trips.length === 0 ? <p className="rounded-xl bg-surface/70 p-4 text-muted-foreground">{t.app.createFirstTrip}</p> : null}
          </nav>
        </aside>
        {selectedTrip ? (
          <div className="grid gap-5">
            <section
              className="rounded-card border border-ink/10 bg-surface p-5 shadow-card sm:p-8"
              aria-labelledby="trip-title-heading"
            >
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-accent-strong">
                {t.app.tripVersion(t.app.role(selectedTrip.role), selectedTrip.version)}
              </p>
              <h2 id="trip-title-heading" className="mt-2 font-display text-3xl text-ink-strong sm:text-4xl">
                {selectedTrip.name}
              </h2>
              <p className="mt-2 text-muted-foreground">
                {selectedTrip.startDate} – {selectedTrip.endDate}
                {selectedTrip.defaultCurrency
                  ? t.app.defaultCurrency(selectedTrip.defaultCurrency)
                  : t.app.noDefaultCurrency}
              </p>
            </section>

            <nav className="sticky top-0 z-40 overflow-x-auto bg-paper py-2" aria-label={t.app.tripSections}>
              <div className="flex w-max min-w-full gap-2" role="tablist">
                {tripTabs.map((tab) => (
                  <button
                    key={tab.value}
                    id={`trip-tab-${tab.value}`}
                    type="button"
                    className={`min-h-11 shrink-0 whitespace-nowrap rounded-xl border px-4 font-bold outline-none focus:ring-4 focus:ring-focus/30 ${
                      activeTripTab === tab.value
                        ? "border-accent-strong bg-surface text-accent-strong"
                        : "border-ink/15 bg-surface-subtle"
                    }`}
                    role="tab"
                    aria-controls={`trip-panel-${tab.value}`}
                    aria-selected={activeTripTab === tab.value}
                    tabIndex={activeTripTab === tab.value ? 0 : -1}
                    onClick={() => setActiveTripTab(tab.value)}
                    onKeyDown={(event) => {
                      const currentIndex = tripTabIds.indexOf(tab.value);
                      let nextIndex: number | null = null;
                      if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tripTabIds.length;
                      if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tripTabIds.length) % tripTabIds.length;
                      if (event.key === "Home") nextIndex = 0;
                      if (event.key === "End") nextIndex = tripTabIds.length - 1;
                      if (nextIndex === null) return;
                      event.preventDefault();
                      const nextTab = tripTabIds[nextIndex]!;
                      setActiveTripTab(nextTab);
                      document.getElementById(`trip-tab-${nextTab}`)?.focus();
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </nav>

            <div
              id="trip-panel-overview"
              role="tabpanel"
              aria-labelledby="trip-tab-overview"
              hidden={activeTripTab !== "overview"}
            >
              <TripWorkspace trip={selectedTrip} currentUser={user} onChanged={() => loadTrip(selectedTrip.id)}
                request={request} revision={placesRevision} onTravelChanged={async () => { placesChanged(); await loadTrip(selectedTrip.id); }} />
            </div>
            <div
              id="trip-panel-discovery"
              role="tabpanel"
              aria-labelledby="trip-tab-discovery"
              hidden={activeTripTab !== "discovery"}
            >
              <DiscoveryWorkspace
                trip={selectedTrip}
                request={request}
                placesRevision={placesRevision}
                onPlacesChanged={placesChanged}
              />
            </div>
            <div
              id="trip-panel-wishlist"
              role="tabpanel"
              aria-labelledby="trip-tab-wishlist"
              hidden={activeTripTab !== "wishlist"}
            >
              <TripPlaceWorkspace
                trip={selectedTrip}
                request={request}
                placesRevision={placesRevision}
                onPlacesChanged={placesChanged}
              />
            </div>
            <div id="trip-panel-lodging" role="tabpanel" aria-labelledby="trip-tab-lodging" hidden={activeTripTab !== "lodging"}
              className="rounded-card border border-ink/10 bg-surface p-5 shadow-card sm:p-8">
              <TravelWorkspace key={selectedTrip.id} trip={selectedTrip} type="lodging" request={request} revision={placesRevision}
                onChanged={async () => { placesChanged(); await loadTrip(selectedTrip.id); }} />
            </div>
            <div
              id="trip-panel-itinerary"
              role="tabpanel"
              aria-labelledby="trip-tab-itinerary"
              hidden={activeTripTab !== "itinerary"}
            >
              <TripSkeletonWorkspace
                trip={selectedTrip}
                request={request}
                onTripChanged={() => loadTrip(selectedTrip.id)}
                placesRevision={placesRevision}
                onPlacesChanged={placesChanged}
                recentChangesContainer={recentChangesContainer}
                onTravelEdit={(type) => {
                  const tab = type === "flight" ? "overview" : "lodging";
                  setActiveTripTab(tab);
                  document.getElementById(`trip-tab-${tab}`)?.focus();
                }}
              />
            </div>
            <div
              ref={setRecentChangesContainer}
              id="trip-panel-recent"
              role="tabpanel"
              aria-labelledby="trip-tab-recent"
              hidden={activeTripTab !== "recent"}
            />
          </div>
        ) : (
          <section className="grid min-h-72 place-items-center rounded-card border border-dashed border-ink/20 bg-surface/50 p-8 text-center text-muted-foreground">{t.app.chooseOrCreateTrip}</section>
        )}
      </div>
    </main>
  );
}
