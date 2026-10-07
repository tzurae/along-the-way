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
import { parseTripSkeletonResponse, type TripSkeletonResponse } from "@along-the-way/contracts/trip-skeleton";
import { parseTripPlaceListResponse, type TripPlaceListResponse } from "@along-the-way/contracts/trip-places";
import { TodayWorkspace } from "./TodayWorkspace";
import { createTodayModel, tripClock } from "./today-model";
import { TodaySnapshotStore, TODAY_SCHEMA_VERSION, type TodaySnapshot } from "./today-snapshot";
import { readTripLocation, writeTripLocation, tripTabIds, type TripTab } from "./trip-location";


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
    readonly status?: number,
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
  const value = response.status === 204 ? null : await response.json().catch(() => {
    throw new ApiRequestError("unknown", messages.unknown, undefined, undefined, response.status);
  });
  if (!response.ok) {
    let parsed;
    try {
      parsed = parseApiError(value);
    } catch {
      throw new ApiRequestError("unknown", messages.unknown, undefined, undefined, response.status);
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
      response.status,
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
    await request(`/api/trips/${trip.id}/members/${userId}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": actionKey(identity) },
    });
    actionKeys.current.delete(identity);
    await onChanged();
  }

  async function revokeInvite(inviteId: string) {
    const identity = `revoke-invite:${inviteId}`;
    await request(`/api/trips/${trip.id}/invites/${inviteId}`, {
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
    try { return await requestJson<T>(t.errors, url, options); }
    catch (reason) {
      if (reason instanceof ApiRequestError && (reason.status === 401 || (tripRead && [403, 404].includes(reason.status ?? 0)))) {
        const owner = accountId.current ?? store?.lastAccount();
        const tripId = tripRead?.[1];
        if (owner && tripId) store?.clearTrip(owner, tripId);
        if (owner && reason.status === 401) store?.clearAccount(owner);
        window.dispatchEvent(new CustomEvent("today-access-denied", { detail: { tripId, status: reason.status } }));
      } else if (coreRead && (!(reason instanceof ApiRequestError) || (reason.status ?? 0) >= 500)) {
        window.dispatchEvent(new Event("today-api-unavailable"));
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
  const [signInError, setSignInError] = useState("");
  const [placesRevision, setPlacesRevision] = useState(0);
  const [syncRevision, setSyncRevision] = useState(0);
  const workspaceRevision = placesRevision + syncRevision;
  const placesChanged = useCallback(() => {
    setPlacesRevision((revision) => revision + 1);
  }, []);
  const [activeTripTab, setActiveTripTab] = useState<TripTab>(() => readTripLocation().tab ?? "overview");
  const [recentChangesContainer, setRecentChangesContainer] = useState<HTMLDivElement | null>(null);



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
      setTrips(response.trips);
    }
    return response.trips;
  }, [request, store]);

  const loadTrip = useCallback(async (tripId: string) => {
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
    const tab = location.trip === tripId && location.tab ? location.tab : clock.today ? "today" : "overview";
    const date = location.trip === tripId && model.days.some((day) => day.date === location.day) ? location.day : (clock.today ?? (clock.phase === "after" ? model.days.at(-1) : model.days[0]))?.date ?? null;
    setActiveTripTab(tab);
    setSelectedDate(date);
    writeTripLocation(tripId, tab, date, true);
    setSelectedTrip(response.trip);
    readOnly.current = false;
    setOffline(false);
    setError("");
  }, [request, store, t.today.unavailable]);

  const restoreSnapshot = useCallback(() => {
    if (signedOut.current || store?.isLocallySignedOut()) return false;
    const owner = accountId.current ?? store?.lastAccount();
    if (!owner) return false;
    const location = readTripLocation();
    const snapshot = location.trip ? store?.read(owner, location.trip) : store?.forAccount(owner)[0];
    readOnly.current = true;
    setOffline(true);
    if (!snapshot) { setTodaySnapshot(null); setSelectedTrip(null); setTrips([]); return false; }
    accountId.current = owner;
    ++loadSequence.current;
    setTodaySnapshot(snapshot);
    setSelectedTrip(null);
    setTrips([]);
    setActiveTripTab("today");
    setSelectedDate(location.day);
    writeTripLocation(snapshot.model.tripId, "today", location.day, true);
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
        setTodaySnapshot(null); setSelectedTrip(null); setTrips([]);
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
    setActiveTripTab(tab);
    const location = readTripLocation();
    if (location.trip) writeTripLocation(location.trip, tab, location.day);
  }, []);
  const selectDay = useCallback((date: string, replace = false) => {
    setSelectedDate(date);
    const location = readTripLocation();
    if (location.trip) writeTripLocation(location.trip, location.tab ?? "today", date, replace);
  }, []);

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
      setActiveTripTab(location.tab ?? "overview");
      setSelectedDate(location.day);
      if (readOnly.current) restoreSnapshot();
      else if (location.trip) void loadTrip(location.trip).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t.today.unavailable));
    };
    window.addEventListener("offline", unavailable);
    window.addEventListener("online", online);
    window.addEventListener("today-api-unavailable", unavailable);
    window.addEventListener("today-access-denied", denied);
    window.addEventListener("popstate", navigate);
    return () => {
      window.removeEventListener("offline", unavailable); window.removeEventListener("online", online);
      window.removeEventListener("today-api-unavailable", unavailable); window.removeEventListener("today-access-denied", denied);
      window.removeEventListener("popstate", navigate);
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
    if (placesRevision > 0 && selectedTrip && !readOnly.current) void loadTrip(selectedTrip.id).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t.today.unavailable));
  }, [placesRevision, loadTrip, selectedTrip?.id, t.today.unavailable]);

  useEffect(() => {
    let active = true;
    const epoch = sessionEpoch.current;
    void (async () => {
      try {
        const magicToken = tokenParameter("magicToken");
        if (!magicToken && store?.isLocallySignedOut()) { setUser(null); return; }
        if (magicToken) {
          await request("/api/auth/magic-links/consume", {
            method: "POST",
            body: JSON.stringify({ token: magicToken }),
            parse: (value) => parseSessionResponse(value),
          });
          removeTokenFragment("magicToken");
        }
        if (magicToken) store?.setLocallySignedOut(false);
        const session = await request<{ user: UserDto }>("/api/session", {
          parse: (value) => parseSessionResponse(value),
        });
        if (!active || epoch !== sessionEpoch.current) return;
        const previousAccount = accountId.current ?? store?.lastAccount();
        if (previousAccount && previousAccount !== session.user.id) store?.clearAccount(previousAccount);
        accountId.current = session.user.id;
        setUser(session.user);
        const available = await refreshTrips();
        if (!active || epoch !== sessionEpoch.current) return;
        const tripId = readTripLocation().trip ?? available[0]?.id;
        if (tripId) await loadTrip(tripId);
      } catch (reason) {
        if (active) {
          if (!(reason instanceof ApiRequestError) || (reason.status ?? 0) >= 500) {
            if (restoreSnapshot()) return;
          }
          if (accountId.current && reason instanceof ApiRequestError && [403, 404].includes(reason.status ?? 0)) {
            setError(reason.message);
            return;
          }
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
  }, [loadTrip, refreshTrips, request, restoreSnapshot, store, t.app.requestNewMagicLink]);

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
  }

  async function logout() {
    ++sessionEpoch.current;
    signedOut.current = true;
    store?.setLocallySignedOut(true);
    const owner = accountId.current ?? store?.lastAccount();
    if (owner) store?.clearAccount(owner);
    accountId.current = null;
    ++loadSequence.current;
    setTodaySnapshot(null);
    setUser(null);
    setTrips([]);
    setSelectedTrip(null);
    setOffline(false);
    const wasOffline = readOnly.current || !navigator.onLine;
    readOnly.current = false;
    if (!wasOffline) await request("/api/logout", { method: "POST" }).catch(() => {});
  }

  if (offline) {
    return <main className="mx-auto min-h-screen w-[min(100%-1.25rem,58rem)] py-5">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3"><h1 className="text-xl font-bold">{todaySnapshot?.model.tripName ?? t.today.title}</h1><button className="min-h-11 rounded-lg border px-4 font-bold" onClick={() => void logout()}>{t.app.signOut}</button></header>
      <p className="mb-4 text-sm">{t.today.offlineAccount}</p>
      {error ? <p className="mb-4" role="alert">{error}</p> : null}
      {todaySnapshot ? <>
        <nav aria-label={t.today.savedTrips} className="mb-4 flex flex-wrap gap-2">{store?.forAccount(todaySnapshot.accountId).map((snapshot) => <button className="min-h-11 rounded-lg border px-3" key={snapshot.model.tripId} onClick={() => {
          writeTripLocation(snapshot.model.tripId, "today", null); restoreSnapshot();
        }}>{snapshot.model.tripName}</button>)}</nav>
        <TodayWorkspace model={todaySnapshot.model} fetchedAt={todaySnapshot.fetchedAt} selectedDate={selectedDate} onDayChanged={selectDay} offline retry={() => void reconnect()} retrying={retrying} />
      </> : <section><p role="status">{t.today.noSnapshot}</p><button className="mt-4 min-h-11 rounded-lg border px-4" onClick={() => void reconnect()} disabled={retrying}>{t.today.retry}</button></section>}
    </main>;
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
    { value: "today", label: t.today.title },
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
              <button key={trip.id} className={`min-h-14 rounded-xl border px-4 py-3 text-left outline-none focus:ring-4 focus:ring-focus/30 ${selectedTrip?.id === trip.id ? "border-accent-strong bg-surface" : "border-ink/10 bg-surface/70"}`} onClick={() => {
                writeTripLocation(trip.id, "overview", null);
                const url = new URL(window.location.href); url.searchParams.delete("tab"); window.history.replaceState({}, "", url);
                void loadTrip(trip.id).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t.today.unavailable));
              }}>
                <strong className="block">{trip.name}</strong><small className="text-muted-foreground">{t.app.tripSummary(trip.memberCount, trip.dayCount)}</small>
              </button>
            ))}
            {trips.length === 0 ? <p className="rounded-xl bg-surface/70 p-4 text-muted-foreground">{t.app.createFirstTrip}</p> : null}
          </nav>
        </aside>
        {selectedTrip ? (
          <div className="grid min-w-0 gap-5">
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

            <nav className="sticky top-0 z-40 bg-paper py-2" aria-label={t.app.tripSections}>
              <div className="flex min-w-0 flex-wrap gap-2" role="tablist">
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
                    onClick={() => selectTab(tab.value)}
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
                      selectTab(nextTab);
                      document.getElementById(`trip-tab-${nextTab}`)?.focus();
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </nav>

            <div id="trip-panel-today" role="tabpanel" aria-labelledby="trip-tab-today" hidden={activeTripTab !== "today"}>
              {todaySnapshot ? <TodayWorkspace key={todaySnapshot.model.tripId} model={todaySnapshot.model} fetchedAt={todaySnapshot.fetchedAt} selectedDate={selectedDate} onDayChanged={selectDay} retry={() => void reconnect()} retrying={retrying} persisted={persisted} /> : <p role="status">{t.today.unavailable}</p>}
            </div>
            <div
              id="trip-panel-overview"
              role="tabpanel"
              aria-labelledby="trip-tab-overview"
              hidden={activeTripTab !== "overview"}
            >
              <TripWorkspace trip={selectedTrip} currentUser={user} onChanged={() => loadTrip(selectedTrip.id)}
                request={request} revision={workspaceRevision} onTravelChanged={async () => { placesChanged(); await loadTrip(selectedTrip.id); }} />
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
                placesRevision={workspaceRevision}
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
                placesRevision={workspaceRevision}
                onPlacesChanged={placesChanged}
              />
            </div>
            <div id="trip-panel-lodging" role="tabpanel" aria-labelledby="trip-tab-lodging" hidden={activeTripTab !== "lodging"}
              className="rounded-card border border-ink/10 bg-surface p-5 shadow-card sm:p-8">
              <TravelWorkspace key={selectedTrip.id} trip={selectedTrip} type="lodging" request={request} revision={workspaceRevision}
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
                placesRevision={workspaceRevision}
                onPlacesChanged={placesChanged}
                recentChangesContainer={recentChangesContainer}
                onTravelEdit={(type) => {
                  const tab = type === "flight" ? "overview" : "lodging";
                  selectTab(tab);
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
