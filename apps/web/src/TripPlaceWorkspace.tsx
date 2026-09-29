import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarCheck,
  CircleAlert,
  CircleCheck,
  CloudOff,
  MapPinOff,
} from "lucide-react";

import type { TripDto } from "@along-the-way/contracts/private-trips";
import {
  parseProviderCandidatesResponse,
  parseTripPlaceListResponse,
  parseTripPlaceResponse,
  type PreferenceLevel,
  type ProviderPlaceCandidateDto,
  type TripPlaceDto,
} from "@along-the-way/contracts/trip-places";
import type { PlaceType } from "@along-the-way/contracts/trip-skeleton";

interface RequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}

interface TripPlaceWorkspaceProps {
  trip: TripDto;
  request<T>(url: string, options?: RequestOptions): Promise<T>;
  placesRevision: number;
  onPlacesChanged(): void;
}

const statusLabels: Record<TripPlaceDto["status"], string> = {
  ready: "Ready for planning",
  "needs-location": "Location needed",
  "possible-duplicate": "Possible duplicate",
  "provider-unavailable": "Provider unavailable",
  scheduled: "Already scheduled",
};

const preferenceLabels: Record<PreferenceLevel, string> = {
  must: "Must go",
  want: "Want to go",
  optional: "Optional",
  neutral: "Neutral",
  dislike: "Prefer not to go",
};

const placeTypes: Array<{ value: PlaceType; label: string }> = [
  { value: "activity", label: "Activity or sight" },
  { value: "restaurant", label: "Restaurant or cafe" },
  { value: "lodging", label: "Lodging" },
  { value: "station", label: "Station" },
  { value: "airport", label: "Airport" },
  { value: "other", label: "Other" },
];

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unable to complete that request";
}

type RetryKeys = Map<string, { fingerprint: string; key: string }>;

function retryKey(store: RetryKeys, operation: string, payload: unknown) {
  const fingerprint = JSON.stringify(payload);
  const existing = store.get(operation);
  if (existing?.fingerprint === fingerprint) return existing.key;
  const key = crypto.randomUUID();
  store.set(operation, { fingerprint, key });
  return key;
}

function clearRetryKey(store: RetryKeys, operation: string) {
  store.delete(operation);
}

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}
function StatusIcon({ status }: { status: TripPlaceDto["status"] }) {
  const Icon = status === "scheduled"
    ? CalendarCheck
    : status === "possible-duplicate"
      ? CircleAlert
      : status === "needs-location"
        ? MapPinOff
        : status === "provider-unavailable"
          ? CloudOff
          : CircleCheck;
  return <Icon aria-hidden="true" className="size-4 shrink-0" />;
}

function nullableNumber(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function AddPlacePanel({
  tripId,
  request,
  close,
  changed,
}: {
  tripId: string;
  request: TripPlaceWorkspaceProps["request"];
  close(): void;
  changed(): Promise<void>;
}) {
  const [mode, setMode] = useState<"url" | "search" | "manual">("url");
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [candidates, setCandidates] = useState<ProviderPlaceCandidateDto[]>([]);
  const [attribution, setAttribution] = useState("");
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const retryKeys = useRef<RetryKeys>(new Map());

  async function discover(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const response = mode === "url"
        ? await request<unknown>(`/api/trips/${tripId}/trip-places/resolve-url`, {
            method: "POST",
            body: JSON.stringify({ url }),
          })
        : await request<unknown>(`/api/trips/${tripId}/trip-places/search`, {
            method: "POST",
            body: JSON.stringify({ query }),
          });
      const parsed = parseProviderCandidatesResponse(response);
      setCandidates(parsed.candidates);
      setAttribution(parsed.attribution);
      setResolvedUrl(parsed.resolvedUrl ?? null);
      if (parsed.candidates.length === 0) {
        setMessage("No unique place was confirmed. Try another search or add it manually.");
      }
    } catch (error) {
      setMessage(`${errorMessage(error)} Your URL, search, and note are still here.`);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(candidate: ProviderPlaceCandidateDto) {
    setBusy(true);
    setMessage("");
    const operation = `confirm:${candidate.providerPlaceId}`;
    const payload = {
      method: mode === "url" ? "google-maps-url" : "search",
      providerPlaceId: candidate.providerPlaceId,
      sourceUrl: mode === "url" ? url : candidate.sourceUrl,
      originalNote: note || null,
    };
    try {
      await request(`/api/trips/${tripId}/trip-places`, {
        method: "POST",
        headers: { "Idempotency-Key": retryKey(retryKeys.current, operation, payload) },
        body: JSON.stringify(payload),
        parse: parseTripPlaceResponse,
      });
      clearRetryKey(retryKeys.current, operation);
      await changed();
      close();
    } catch (error) {
      setMessage(`${errorMessage(error)} Your selection and note are still here.`);
    } finally {
      setBusy(false);
    }
  }

  async function addManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setMessage("");
    const operation = "add-manual";
    const payload = {
      method: "manual",
      name: data.get("name"),
      type: data.get("type"),
      address: data.get("address") || null,
      latitude: nullableNumber(data.get("latitude")),
      longitude: nullableNumber(data.get("longitude")),
      timeZone: data.get("timeZone") || null,
      sourceUrl: data.get("sourceUrl") || null,
      originalNote: data.get("originalNote") || null,
    };
    try {
      await request(`/api/trips/${tripId}/trip-places`, {
        method: "POST",
        headers: { "Idempotency-Key": retryKey(retryKeys.current, operation, payload) },
        body: JSON.stringify(payload),
        parse: parseTripPlaceResponse,
      });
      clearRetryKey(retryKeys.current, operation);
      await changed();
      close();
    } catch (error) {
      setMessage(`${errorMessage(error)} Your manual place details are still here.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-ink-strong/45 p-3" role="presentation">
      <section
        aria-labelledby="add-wishlist-place"
        aria-modal="true"
        className="my-auto w-full max-w-3xl rounded-card bg-surface p-5 shadow-feedback sm:p-7"
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-accent-strong">Shared wishlist</p>
            <h3 id="add-wishlist-place" className="font-display text-3xl text-ink-strong">Add a place</h3>
          </div>
          <button className="min-h-11 rounded-lg border px-4 font-bold" onClick={close}>Close</button>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-2" role="tablist" aria-label="Place intake method">
          {([
            ["url", "Google Maps link"],
            ["search", "Search"],
            ["manual", "Manual"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              className={`min-h-12 rounded-xl border px-3 font-bold ${mode === value ? "border-accent-strong bg-surface-subtle text-accent-strong" : "border-ink/15"}`}
              role="tab"
              aria-selected={mode === value}
              onClick={() => {
                setMode(value);
                setCandidates([]);
                setMessage("");
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "manual" ? (
          <form className="mt-6 grid gap-4 sm:grid-cols-2" onSubmit={addManual}>
            <label className="grid gap-1 font-semibold sm:col-span-2">Place name<input className="min-h-11 rounded-lg border px-3" name="name" required maxLength={200} /></label>
            <label className="grid gap-1 font-semibold">Place type<select className="min-h-11 rounded-lg border px-3" name="type">{placeTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
            <label className="grid gap-1 font-semibold">Address, if known<input className="min-h-11 rounded-lg border px-3" name="address" /></label>
            <label className="grid gap-1 font-semibold">Latitude, if known<input className="min-h-11 rounded-lg border px-3" name="latitude" type="number" min="-90" max="90" step="any" /></label>
            <label className="grid gap-1 font-semibold">Longitude, if known<input className="min-h-11 rounded-lg border px-3" name="longitude" type="number" min="-180" max="180" step="any" /></label>
            <label className="grid gap-1 font-semibold">IANA time zone, if known<input className="min-h-11 rounded-lg border px-3" name="timeZone" placeholder="Asia/Tokyo" /></label>
            <label className="grid gap-1 font-semibold">Source link, if any<input className="min-h-11 rounded-lg border px-3" name="sourceUrl" type="url" /></label>
            <label className="grid gap-1 font-semibold sm:col-span-2">Your original note<textarea className="min-h-24 rounded-lg border p-3" name="originalNote" /></label>
            <button className="min-h-12 rounded-xl bg-ink-strong px-5 font-bold text-on-dark sm:col-span-2" disabled={busy}>{busy ? "Adding…" : "Add manual place"}</button>
          </form>
        ) : (
          <form className="mt-6 grid gap-4" onSubmit={discover}>
            {mode === "url" ? (
              <label className="grid gap-1 font-semibold">Google Maps full or maps.app.goo.gl link<input className="min-h-12 rounded-lg border px-3" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} /></label>
            ) : (
              <label className="grid gap-1 font-semibold">Search Google Maps<input className="min-h-12 rounded-lg border px-3" required maxLength={300} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
            )}
            <label className="grid gap-1 font-semibold">Your original note<textarea className="min-h-20 rounded-lg border p-3" value={note} onChange={(event) => setNote(event.target.value)} /></label>
            <button className="min-h-12 rounded-xl bg-ink-strong px-5 font-bold text-on-dark" disabled={busy}>{busy ? "Checking…" : mode === "url" ? "Resolve link" : "Search places"}</button>
          </form>
        )}

        {candidates.length > 0 ? (
          <section className="mt-6" aria-labelledby="provider-candidates">
            <h4 id="provider-candidates" className="font-display text-2xl">Confirm the place</h4>
            {resolvedUrl ? <p className="mt-1 break-all text-sm text-muted-foreground">Resolved securely to {resolvedUrl}</p> : null}
            <p className="mt-1 text-sm text-muted-foreground">Results provided by {attribution}. Select one; similar names are never guessed automatically.</p>
            <ul className="mt-3 grid gap-3">
              {candidates.map((candidate) => (
                <li key={candidate.providerPlaceId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink/10 p-4">
                  <span><strong className="block">{candidate.name}</strong><small className="text-muted-foreground">{candidate.address ?? "Address unavailable"} · observed {new Date(candidate.observedAt).toLocaleString()}</small></span>
                  <button className="min-h-11 rounded-lg bg-accent px-4 font-bold text-ink-strong" disabled={busy} onClick={() => void confirm(candidate)}>Add this place</button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {message ? <p className="mt-5 rounded-xl bg-surface-subtle p-4" role="alert">{message}</p> : null}
      </section>
    </div>
  );
}

function PlanningEditor({
  trip,
  place,
  request,
  changed,
}: {
  trip: TripDto;
  place: TripPlaceDto;
  request: TripPlaceWorkspaceProps["request"];
  changed(): Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const retryKeys = useRef<RetryKeys>(new Map());
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setMessage("");
    const operation = `planning:${place.id}`;
    const payload = {
      expectedVersion: place.version,
      durationMinutes: nullableNumber(data.get("durationMinutes")),
      desiredDayIds: data.getAll("desiredDayIds"),
      excludedDayIds: data.getAll("excludedDayIds"),
      budgetAmountMinor: nullableNumber(data.get("budgetAmountMinor")),
      budgetCurrency: data.get("budgetCurrency") || null,
      notes: data.get("notes") || null,
    };
    try {
      await request(`/api/trips/${trip.id}/trip-places/${place.id}/planning`, {
        method: "PATCH",
        headers: { "Idempotency-Key": retryKey(retryKeys.current, operation, payload) },
        body: JSON.stringify(payload),
        parse: parseTripPlaceResponse,
      });
      clearRetryKey(retryKeys.current, operation);
      setMessage("Planning facts saved.");
      await changed();
    } catch (error) {
      setMessage(`${errorMessage(error)} Your edits remain in the form.`);
    }
  }

  return (
    <details className="rounded-xl border border-ink/10 p-3">
      <summary className="cursor-pointer font-bold">Duration, dates, budget, and notes</summary>
      <form key={place.version} className="mt-4 grid gap-4" onSubmit={save}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 font-semibold">Duration in minutes<input className="min-h-11 rounded-lg border px-3" name="durationMinutes" type="number" min="1" defaultValue={place.durationMinutes ?? ""} placeholder="Unknown" /></label>
          <label className="grid gap-1 font-semibold">Budget in minor units<input className="min-h-11 rounded-lg border px-3" name="budgetAmountMinor" type="number" min="0" defaultValue={place.budgetAmountMinor ?? ""} placeholder="Unknown" /></label>
          <label className="grid gap-1 font-semibold">ISO currency<input className="min-h-11 rounded-lg border px-3 uppercase" name="budgetCurrency" maxLength={3} defaultValue={place.budgetCurrency ?? ""} placeholder="Unknown" /></label>
          <label className="grid gap-1 font-semibold sm:col-span-2">Shared planning note<textarea className="min-h-20 rounded-lg border p-3" name="notes" defaultValue={place.notes ?? ""} /></label>
        </div>
        <fieldset className="grid gap-2"><legend className="font-bold">Preferred days</legend>{trip.days.map((day) => <label key={day.id} className="flex min-h-10 items-center gap-2"><input type="checkbox" name="desiredDayIds" value={day.id} defaultChecked={place.desiredDayIds.includes(day.id)} />{day.date}</label>)}</fieldset>
        <fieldset className="grid gap-2"><legend className="font-bold">Excluded days</legend>{trip.days.map((day) => <label key={day.id} className="flex min-h-10 items-center gap-2"><input type="checkbox" name="excludedDayIds" value={day.id} defaultChecked={place.excludedDayIds.includes(day.id)} />{day.date}</label>)}</fieldset>
        <button className="min-h-11 rounded-lg bg-ink-strong px-4 font-bold text-on-dark">Save planning facts</button>
        {message ? <p role="status">{message}</p> : null}
      </form>
    </details>
  );
}

export function TripPlaceWorkspace({
  trip,
  request,
  placesRevision,
  onPlacesChanged,
}: TripPlaceWorkspaceProps) {
  const [places, setPlaces] = useState<TripPlaceDto[]>([]);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [preferenceDrafts, setPreferenceDrafts] = useState<Record<string, PreferenceLevel>>({});
  const [failedPreferences, setFailedPreferences] = useState<Record<string, true>>({});
  const [pendingPreferences, setPendingPreferences] = useState<Record<string, true>>({});
  const pendingPreferenceIds = useRef(new Set<string>());
  const retryKeys = useRef<RetryKeys>(new Map());

  const refreshPlaces = useCallback(async () => {
    const response = await request<unknown>(`/api/trips/${trip.id}/trip-places`);
    setPlaces(parseTripPlaceListResponse(response).tripPlaces);
  }, [request, trip.id]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await refreshPlaces();
      setMessage("");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [refreshPlaces]);

  useEffect(() => {
    void load();
  }, [load, placesRevision]);

  async function changedPlaces() {
    await load();
    onPlacesChanged();
  }

  const placesById = useMemo(
    () => new Map(places.map((place) => [place.id, place])),
    [places],
  );

  async function setPreference(place: TripPlaceDto, level: PreferenceLevel) {
    if (pendingPreferenceIds.current.has(place.id)) return;
    pendingPreferenceIds.current.add(place.id);
    setPendingPreferences((current) => ({ ...current, [place.id]: true }));
    const own = place.preferences.find((preference) => preference.isOwn);
    const operation = `preference:${place.id}`;
    const payload = { level, expectedVersion: own?.version ?? null };
    setPreferenceDrafts((current) => ({ ...current, [place.id]: level }));
    setFailedPreferences((current) => {
      const next = { ...current };
      delete next[place.id];
      return next;
    });
    try {
      const response = await request<{ tripPlace: TripPlaceDto }>(
        `/api/trips/${trip.id}/trip-places/${place.id}/preference`,
        {
          method: "PUT",
          headers: { "Idempotency-Key": retryKey(retryKeys.current, operation, payload) },
          body: JSON.stringify(payload),
          parse: parseTripPlaceResponse,
        },
      );
      clearRetryKey(retryKeys.current, operation);
      setPlaces((current) => current.map((candidate) =>
        candidate.id === response.tripPlace.id ? response.tripPlace : candidate
      ));
      setPreferenceDrafts((current) => {
        const next = { ...current };
        delete next[place.id];
        return next;
      });
      setMessage("");
      setFailedPreferences((current) => {
        const next = { ...current };
        delete next[place.id];
        return next;
      });
    } catch (error) {
      if (errorCode(error) === "conflict") {
        try {
          await refreshPlaces();
        } catch {
          // The original conflict remains the actionable error.
        }
      }
      setMessage(errorMessage(error));
      setFailedPreferences((current) => ({ ...current, [place.id]: true }));
    } finally {
      pendingPreferenceIds.current.delete(place.id);
      setPendingPreferences((current) => {
        const next = { ...current };
        delete next[place.id];
        return next;
      });
    }
  }

  async function withdraw(place: TripPlaceDto, contributionId: string) {
    const operation = `withdraw:${contributionId}`;
    try {
      await request(`/api/trips/${trip.id}/trip-places/${place.id}/contributions/${contributionId}/withdraw`, {
        method: "POST",
        headers: { "Idempotency-Key": retryKey(retryKeys.current, operation, {}) },
      });
      clearRetryKey(retryKeys.current, operation);
      await load();
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function merge(source: TripPlaceDto, targetId: string) {
    const target = places.find((place) => place.id === targetId);
    if (!target) return;
    const operation = `merge:${source.id}:${target.id}`;
    const payload = {
      targetTripPlaceId: target.id,
      expectedSourceVersion: source.version,
      expectedTargetVersion: target.version,
    };
    try {
      await request(`/api/trips/${trip.id}/trip-places/${source.id}/merge`, {
        method: "POST",
        headers: { "Idempotency-Key": retryKey(retryKeys.current, operation, payload) },
        body: JSON.stringify(payload),
        parse: parseTripPlaceResponse,
      });
      clearRetryKey(retryKeys.current, operation);
      await load();
      onPlacesChanged();
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function keepSeparate(suggestionId: string) {
    const operation = `keep-separate:${suggestionId}`;
    try {
      await request(`/api/trips/${trip.id}/trip-places/duplicates/${suggestionId}/keep-separate`, {
        method: "POST",
        headers: { "Idempotency-Key": retryKey(retryKeys.current, operation, {}) },
      });
      clearRetryKey(retryKeys.current, operation);
      await load();
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  return (
    <section className="rounded-card border border-ink/10 bg-surface p-5 shadow-card sm:p-8" aria-labelledby="shared-wishlist-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-accent-strong">Plan together</p>
          <h2 id="shared-wishlist-heading" className="font-display text-3xl text-ink-strong sm:text-4xl">Shared place wishlist</h2>
          <p className="mt-2 max-w-3xl text-muted-foreground">Collect links, searches, and private places. Every member keeps an independent preference; conflicts stay visible.</p>
        </div>
        <button className="min-h-12 rounded-xl bg-accent px-5 font-bold text-ink-strong" onClick={() => setAdding(true)}>Add wishlist place</button>
      </div>

      {message ? <p className="mt-4 rounded-xl bg-surface-subtle p-4" role="alert">{message}</p> : null}
      {loading ? <p className="mt-6" role="status">Loading shared wishlist…</p> : null}
      {!loading && places.length === 0 ? <p className="mt-6 rounded-xl border border-dashed border-ink/20 p-6 text-center text-muted-foreground">No wishlist places yet. Add a Google Maps link, search, or manual place.</p> : null}

      <div className="mt-6 grid gap-5 xl:grid-cols-2">
        {places.map((place) => {
          const ownPreference = place.preferences.find((preference) => preference.isOwn);
          const preferenceDraft = preferenceDrafts[place.id];
          const factsLabel = place.factsSource === "provider"
            ? `${place.type} · ${place.providerAttribution ?? "Provider facts"}`
            : place.provider === "google"
              ? `${place.type} · Member-provided facts · Google identity retained for matching`
              : `${place.type} · Manual entry`;
          return (
            <article aria-label={`${place.name} at ${place.address ?? "unknown address"}`} key={place.id} className="grid content-start gap-4 rounded-panel border border-ink/10 bg-surface-subtle p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.12em] text-accent-strong">{factsLabel}{place.aiProposalId ? " · AI proposal" : ""}</p>
                  <h3 className="font-display text-2xl text-ink-strong">{place.name}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{place.address ?? "Address unknown"}</p>
                </div>
                <span className="flex items-center gap-2 rounded-full border border-ink/15 bg-surface px-3 py-1 text-sm font-bold"><StatusIcon status={place.status} />{statusLabels[place.status]}</span>
              </div>
              {place.providerObservedAt ? <p className="text-sm text-muted-foreground">Provider facts observed {new Date(place.providerObservedAt).toLocaleString()}{place.providerFactsExpired ? " · expired; not presented as current" : ""}</p> : null}
              {place.preferenceConflict ? <p className="rounded-xl border border-accent-strong bg-surface p-3 font-bold text-accent-strong" role="status">Preference conflict: at least one member marked Must go and another marked Prefer not to go. Both opinions are preserved.</p> : null}

              <section aria-label={`Member preferences for ${place.name}`}>
                <h4 className="font-bold">Member preferences</h4>
                <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                  {place.preferences.map((preference) => (
                    <li key={preference.memberUserId} className="rounded-lg bg-surface p-3">
                      <strong className="block">{preference.memberDisplayName ?? preference.memberEmail}{preference.isOwn ? " · you" : ""}</strong>
                      <span className="text-sm">{preference.level ? preferenceLabels[preference.level] : "No preference yet"}</span>
                    </li>
                  ))}
                </ul>
                <label className="mt-3 grid gap-1 font-semibold">Your preference<select className="min-h-11 rounded-lg border bg-surface px-3" disabled={pendingPreferences[place.id]} value={preferenceDraft ?? ownPreference?.level ?? ""} onChange={(event) => { if (event.target.value) void setPreference(place, event.target.value as PreferenceLevel); }}><option value="">No preference yet</option>{Object.entries(preferenceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                {failedPreferences[place.id] && preferenceDraft ? <button className="mt-2 min-h-10 rounded-lg border px-3 font-bold" disabled={pendingPreferences[place.id]} onClick={() => void setPreference(place, preferenceDraft)}>Retry preference</button> : null}
              </section>

              <section aria-label={`Contributions for ${place.name}`}>
                <h4 className="font-bold">Added by and original notes</h4>
                <ul className="mt-2 grid gap-2">
                  {place.contributions.map((contribution) => (
                    <li key={contribution.id} className={`rounded-lg bg-surface p-3 ${contribution.withdrawnAt ? "opacity-60" : ""}`}>
                      <div className="flex flex-wrap items-start justify-between gap-2"><span><strong>{contribution.memberDisplayName ?? contribution.memberEmail}</strong> · {contribution.intakeMethod}{contribution.withdrawnAt ? " · withdrawn" : ""}</span>{contribution.isOwn && !contribution.withdrawnAt ? <button className="min-h-9 rounded-lg border px-3 text-sm font-bold" onClick={() => void withdraw(place, contribution.id)}>Withdraw mine</button> : null}</div>
                      <p className="mt-1 whitespace-pre-wrap text-sm">{contribution.originalNote ?? "No original note"}</p>
                      {contribution.sourceUrl ? <a className="mt-1 block break-all text-sm font-bold text-accent-strong underline" href={contribution.sourceUrl} rel="noreferrer" target="_blank">Open original source</a> : null}
                    </li>
                  ))}
                </ul>
              </section>
              {place.duplicateSuggestions.filter((suggestion) =>
                place.id < suggestion.otherTripPlaceId
              ).map((suggestion) => {
                const other = placesById.get(suggestion.otherTripPlaceId);
                return (
                  <section key={suggestion.id} className="rounded-xl border border-accent-strong bg-surface p-3" aria-label="Possible duplicate comparison">
                    <strong className="block">Compare both options before deciding</strong>
                    <p className="mt-1 text-sm">Suggested only because: {suggestion.reason}. It was not merged automatically.</p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      {([
                        ["This option", place],
                        ["Other option", other],
                      ] as const).map(([label, candidate]) => (
                        <div key={label} className="rounded-lg border border-ink/10 p-3">
                          <span className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
                          {candidate ? (
                            <>
                              <h5 className="font-display text-xl">{candidate.name}</h5>
                              <p className="text-sm">{candidate.type} · {candidate.address ?? "Address unknown"}</p>
                              <p className="mt-1 text-sm text-muted-foreground">
                                {candidate.factsSource === "provider" ? "Provider facts" : "Member-provided facts"}
                                {" · "}
                                {candidate.contributions.filter((entry) => !entry.withdrawnAt).map((entry) =>
                                  entry.memberDisplayName ?? entry.memberEmail
                                ).join(", ") || "No active contributor"}
                              </p>
                              <p className="mt-1 text-sm">
                                {candidate.contributions.filter((entry) => !entry.withdrawnAt).map((entry) =>
                                  entry.originalNote ?? entry.sourceUrl ?? "No source note"
                                ).join(" · ") || "No active source note"}
                              </p>
                            </>
                          ) : <p className="mt-1 text-sm text-muted-foreground">This option is no longer available.</p>}
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2"><button className="min-h-10 rounded-lg bg-accent px-3 font-bold" disabled={!other} onClick={() => void merge(place, suggestion.otherTripPlaceId)}>Merge these options</button><button className="min-h-10 rounded-lg border px-3 font-bold" onClick={() => void keepSeparate(suggestion.id)}>Keep separate options</button></div>
                  </section>
                );
              })}

              <PlanningEditor trip={trip} place={place} request={request} changed={changedPlaces} />
            </article>
          );
        })}
      </div>
      {adding ? <AddPlacePanel tripId={trip.id} request={request} close={() => setAdding(false)} changed={changedPlaces} /> : null}
    </section>
  );
}
