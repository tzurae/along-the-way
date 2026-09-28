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
import { countryOptions } from "@along-the-way/contracts/countries";

import { CreateTripDialog } from "./CreateTripDialog";
import { TripSkeletonWorkspace } from "./TripSkeletonWorkspace";

const countryNames = new Map(
  countryOptions("zh-Hant").map((country) => [
    country.code,
    `${country.flag} ${country.localizedName} (${country.code})`,
  ]),
);

function countryStopLabel(countryCode: string) {
  return countryNames.get(countryCode) ?? countryCode;
}

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
    super(
      [
        message,
        currentVersion === undefined ? "" : `Current version: ${currentVersion}.`,
        correlationId ? `Reference: ${correlationId}` : "",
      ].filter(Boolean).join(" "),
    );
  }
}

async function requestJson<T>(url: string, options: RequestOptions = {}) {
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
      throw new Error("Unable to complete that request");
    }
    throw new ApiRequestError(
      parsed.error.code,
      parsed.error.message,
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
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState(initialMessage);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const response = await requestJson<{ message: string }>(
        "/api/auth/magic-links",
        {
          method: "POST",
          body: JSON.stringify({
            email,
            ...(pendingInviteToken ? { inviteToken: pendingInviteToken } : {}),
          }),
        },
      );
      setMessage(response.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to request a link");
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
          Plan a private trip together
        </h1>
        <p className="mt-4 text-muted-foreground">
          Sign in with the email your family uses for this trip. No password or
          public registration.
        </p>
        <form className="mt-8 grid gap-4" onSubmit={submit}>
          <label className="grid gap-2 font-semibold">
            Email
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
            {submitting ? "Sending…" : "Email me a sign-in link"}
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
}

function TripWorkspace({ trip, currentUser, onChanged }: TripWorkspaceProps) {
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
      setMessage(`Invitation sent to ${response.invite.email}`);
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to invite member");
    }
  }

  async function removeMember(userId: string) {
    const identity = `remove-member:${userId}`;
    await requestJson(`/api/trips/${trip.id}/members/${userId}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": actionKey(identity) },
    });
    actionKeys.current.delete(identity);
    await onChanged();
  }

  async function revokeInvite(inviteId: string) {
    const identity = `revoke-invite:${inviteId}`;
    await requestJson(`/api/trips/${trip.id}/invites/${inviteId}`, {
      method: "DELETE",
      headers: { "Idempotency-Key": actionKey(identity) },
    });
    actionKeys.current.delete(identity);
    await onChanged();
  }

  return (
    <section className="rounded-card border border-ink/10 bg-surface p-5 shadow-card sm:p-8">
      <p className="text-xs font-bold uppercase tracking-[0.14em] text-accent-strong">
        {trip.role} · version {trip.version}
      </p>
      <h2 className="mt-2 font-display text-3xl text-ink-strong sm:text-4xl">{trip.name}</h2>
      <p className="mt-2 text-muted-foreground">
        {trip.startDate} – {trip.endDate}
        {trip.defaultCurrency ? ` · Default currency ${trip.defaultCurrency}` : " · No inferred default currency"}
      </p>
      <section className="mt-5" aria-labelledby="trip-country-route">
        <h3 id="trip-country-route" className="font-semibold">Country route</h3>
        {trip.countryStops.length > 0 ? (
          <ol className="mt-2 grid gap-2">
            {trip.countryStops.map((stop) => (
              <li key={stop.id} className="flex items-center justify-between gap-3 rounded-xl bg-surface-subtle px-4 py-3">
                <span><strong className="mr-3">{stop.position + 1}.</strong>{countryStopLabel(stop.countryCode)}</span>
                <small className="text-muted-foreground">{stop.timeZone ?? "Time zone not inferred"}</small>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 rounded-xl bg-surface-subtle p-4 text-muted-foreground">Country route not set for this legacy trip.</p>
        )}
      </section>
      <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-ink/10 sm:max-w-sm">
        <div className="bg-surface-subtle p-4"><strong className="block text-2xl">{trip.memberCount}</strong> members</div>
        <div className="bg-surface-subtle p-4"><strong className="block text-2xl">{trip.dayCount}</strong> days</div>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_0.9fr]">
        <div>
          <h3 className="font-display text-2xl">Members</h3>
          <ul className="mt-3 grid gap-3">
            {trip.members.map((member) => (
              <li key={member.userId} className="flex min-h-14 items-center justify-between gap-3 rounded-xl bg-surface-subtle px-4 py-3">
                <span><strong className="block">{member.displayName ?? member.email}</strong><small className="text-muted-foreground">{member.role}{member.userId === currentUser.id ? " · you" : ""}</small></span>
                {trip.role === "owner" && member.role === "editor" ? (
                  <button className="min-h-10 rounded-lg border border-accent-strong px-3 text-sm font-bold text-accent-strong" onClick={() => void removeMember(member.userId)}>
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="font-display text-2xl">Pending invitations</h3>
          <ul className="mt-3 grid gap-3">
            {trip.invites.filter((invite) => invite.status === "pending").map((invite) => (
              <li key={invite.id} className="flex min-h-14 items-center justify-between gap-3 rounded-xl bg-surface-subtle px-4 py-3">
                <span>{invite.email}</span>
                {trip.role === "owner" ? (
                  <button className="min-h-10 rounded-lg border px-3 text-sm font-bold" onClick={() => void revokeInvite(invite.id)}>Revoke</button>
                ) : null}
              </li>
            ))}
            {trip.invites.every((invite) => invite.status !== "pending") ? <li className="text-muted-foreground">No pending invitations.</li> : null}
          </ul>
          {trip.role === "owner" ? (
            <form className="mt-5 grid gap-3" onSubmit={inviteMember}>
              <label className="grid gap-1 font-semibold">
                Invite editor by email
                <input className="min-h-11 rounded-lg border px-3" type="email" required value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} />
              </label>
              <button className="min-h-11 rounded-xl bg-ink-strong px-4 font-bold text-white">Send invitation</button>
            </form>
          ) : null}
          {message ? <p className="mt-3" role="status">{message}</p> : null}
        </div>
      </div>
    </section>
  );
}

export function App() {
  const [user, setUser] = useState<UserDto | null | undefined>(undefined);
  const [trips, setTrips] = useState<TripSummaryDto[]>([]);
  const [selectedTrip, setSelectedTrip] = useState<TripDto | null>(null);
  const [error, setError] = useState("");
  const [accepting, setAccepting] = useState(false);
  const inviteKey = useRef<string | null>(null);
  const createTripKey = useRef<string | null>(null);
  const [signInError, setSignInError] = useState("");

  const refreshTrips = useCallback(async () => {
    const response = await requestJson<{ trips: TripSummaryDto[] }>("/api/trips", {
      parse: (value) => parseTripListResponse(value),
    });
    setTrips(response.trips);
    return response.trips;
  }, []);

  const loadTrip = useCallback(async (tripId: string) => {
    const response = await requestJson<{ trip: TripDto }>(`/api/trips/${tripId}`, {
      parse: (value) => parseTripResponse(value),
    });
    setSelectedTrip(response.trip);
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const magicToken = tokenParameter("magicToken");
        if (magicToken) {
          await requestJson("/api/auth/magic-links/consume", {
            method: "POST",
            body: JSON.stringify({ token: magicToken }),
            parse: (value) => parseSessionResponse(value),
          });
          removeTokenFragment("magicToken");
        }
        const session = await requestJson<{ user: UserDto }>("/api/session", {
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
              `${reason.message} Enter your email below to request a new sign-in link.`,
            );
            removeTokenFragment("magicToken");
          }
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [loadTrip, refreshTrips]);

  async function acceptInvitation() {
    const token = tokenParameter("inviteToken");
    if (!token) return;
    setAccepting(true);
    setError("");
    inviteKey.current ??= crypto.randomUUID();
    try {
      const response = await requestJson<{ trip: TripDto }>("/api/invites/accept", {
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
      setError(reason instanceof Error ? reason.message : "Unable to accept invitation");
    } finally {
      setAccepting(false);
    }
  }

  async function createTrip(input: CreateTripInput) {
    createTripKey.current ??= crypto.randomUUID();
    const response = await requestJson<{ trip: TripDto }>("/api/trips", {
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
    await requestJson("/api/logout", { method: "POST" });
    setUser(null);
    setTrips([]);
    setSelectedTrip(null);
  }

  if (user === undefined) {
    return <main className="grid min-h-screen place-items-center" role="status">Opening your trips…</main>;
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

  return (
    <main className="mx-auto min-h-screen w-[min(100%-1.25rem,96rem)] py-5 sm:py-8">
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-panel bg-surface/90 px-5 py-4 shadow-feedback">
        <div><p className="text-xs font-bold tracking-[0.14em] text-accent-strong">ALONG THE WAY</p><p className="text-sm text-muted-foreground">Signed in as {user.email}</p></div>
        <button className="min-h-10 rounded-lg border px-4 font-bold" onClick={() => void logout()}>Sign out</button>
      </header>

      {inviteToken ? (
        <section className="my-5 flex flex-wrap items-center justify-between gap-3 rounded-panel bg-ink-strong p-5 text-on-dark">
          <div><strong className="block text-lg">You have a trip invitation</strong><span>Accept it with this signed-in email.</span></div>
          <button className="min-h-11 rounded-xl bg-accent px-5 font-bold" disabled={accepting} onClick={() => void acceptInvitation()}>{accepting ? "Accepting…" : "Accept invitation"}</button>
        </section>
      ) : null}
      {error ? <p className="my-4 rounded-xl bg-surface p-4 text-accent-strong" role="alert">{error}</p> : null}

      <div className="my-6 grid gap-5 lg:grid-cols-[17rem_1fr]">
        <aside className="grid content-start gap-4">
          <CreateTripDialog createTrip={createTrip} />
          <nav aria-label="Trips" className="grid gap-2">
            {trips.map((trip) => (
              <button key={trip.id} className={`min-h-14 rounded-xl border px-4 py-3 text-left outline-none focus:ring-4 focus:ring-focus/30 ${selectedTrip?.id === trip.id ? "border-accent-strong bg-surface" : "border-ink/10 bg-surface/70"}`} onClick={() => void loadTrip(trip.id)}>
                <strong className="block">{trip.name}</strong><small className="text-muted-foreground">{trip.memberCount} members · {trip.dayCount} days</small>
              </button>
            ))}
            {trips.length === 0 ? <p className="rounded-xl bg-surface/70 p-4 text-muted-foreground">Create your first private trip.</p> : null}
          </nav>
        </aside>
        {selectedTrip ? (
          <div className="grid gap-5">
            <TripWorkspace trip={selectedTrip} currentUser={user} onChanged={() => loadTrip(selectedTrip.id)} />
            <TripSkeletonWorkspace
              trip={selectedTrip}
              request={requestJson}
              onTripChanged={() => loadTrip(selectedTrip.id)}
            />
          </div>
        ) : (
          <section className="grid min-h-72 place-items-center rounded-card border border-dashed border-ink/20 bg-surface/50 p-8 text-center text-muted-foreground">Choose or create a trip.</section>
        )}
      </div>
    </main>
  );
}
