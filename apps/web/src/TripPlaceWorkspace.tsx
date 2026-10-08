import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarCheck,
  CircleAlert,
  CircleCheck,
  CloudOff,
  Images,
  MapPinOff,
} from "lucide-react";

import type { TripDto } from "@along-the-way/contracts/private-trips";
import {
  parseProviderCandidatesResponse,
  parseTripPlaceListResponse,
  parseTripPlaceResponse,
  type ProviderPlaceCandidateDto,
  type TripPlaceDto,
} from "@along-the-way/contracts/trip-places";
import type { UpdateTripPlacePlanningInput } from "@along-the-way/contracts/trip-places";
import { ConflictPanel, useVersionConflict, type EditSnapshot } from "./ConflictPanel";
import { ApiRequestError } from "./api-error";
import type { PlaceType } from "@along-the-way/contracts/trip-skeleton";

import { googleMapsPlaceUrl } from "./google-maps";
import { useI18n, type Messages } from "./i18n";
import { VoteControl, VoteVoters } from "./VoteControl";

interface RequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}

interface TripPlaceWorkspaceProps {
  trip: TripDto;
  request<T>(url: string, options?: RequestOptions): Promise<T>;
  placesRevision: number;
  onPlacesChanged(): void;
}

function statusLabel(status: TripPlaceDto["status"], t: Messages["tripPlaces"]) {
  switch (status) {
    case "ready": return t.status.ready;
    case "needs-location": return t.status.needsLocation;
    case "possible-duplicate": return t.status.possibleDuplicate;
    case "provider-unavailable": return t.status.providerUnavailable;
    case "scheduled": return t.status.scheduled;
  }
}

const placeTypeValues: PlaceType[] = [
  "activity",
  "restaurant",
  "lodging",
  "station",
  "airport",
  "other",
];


function duplicateReason(reason: string, t: Messages["tripPlaces"]) {
  return reason.split(", ").map((part) => {
    if (part === "same normalized name") return t.duplicates.sameName;
    if (part === "same normalized address") return t.duplicates.sameAddress;
    if (part === "within 100 metres") return t.duplicates.withinHundredMetres;
    return part;
  }).join("、");
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
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
  const { locale, t: { tripPlaces: t } } = useI18n();
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
        setMessage(t.errors.noUniquePlace);
      }
    } catch (error) {
      setMessage(t.errors.discoveryPreserved(errorMessage(error, t.errors.requestFailed)));
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
      setMessage(t.errors.selectionPreserved(errorMessage(error, t.errors.requestFailed)));
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
      setMessage(t.errors.manualPreserved(errorMessage(error, t.errors.requestFailed)));
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
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-accent-strong">{t.add.eyebrow}</p>
            <h3 id="add-wishlist-place" className="font-display text-3xl text-ink-strong">{t.add.title}</h3>
          </div>
          <button className="min-h-11 rounded-lg border px-4 font-bold" onClick={close}>{t.add.close}</button>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-2" role="tablist" aria-label={t.add.methodLabel}>
          {([
            ["url", t.add.googleMapsLink],
            ["search", t.add.search],
            ["manual", t.add.manual],
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
            <label className="grid gap-1 font-semibold sm:col-span-2">{t.add.placeName}<input className="min-h-11 rounded-lg border px-3" name="name" required maxLength={200} /></label>
            <label className="grid gap-1 font-semibold">{t.add.placeType}<select className="min-h-11 rounded-lg border px-3" name="type">{placeTypeValues.map((value) => <option key={value} value={value}>{t.placeType[value]}</option>)}</select></label>
            <label className="grid gap-1 font-semibold">{t.add.addressIfKnown}<input className="min-h-11 rounded-lg border px-3" name="address" /></label>
            <label className="grid gap-1 font-semibold">{t.add.latitudeIfKnown}<input className="min-h-11 rounded-lg border px-3" name="latitude" type="number" min="-90" max="90" step="any" /></label>
            <label className="grid gap-1 font-semibold">{t.add.longitudeIfKnown}<input className="min-h-11 rounded-lg border px-3" name="longitude" type="number" min="-180" max="180" step="any" /></label>
            <label className="grid gap-1 font-semibold">{t.add.timeZoneIfKnown}<input className="min-h-11 rounded-lg border px-3" name="timeZone" placeholder={t.add.timeZonePlaceholder} /></label>
            <label className="grid gap-1 font-semibold">{t.add.sourceLinkIfAny}<input className="min-h-11 rounded-lg border px-3" name="sourceUrl" type="url" /></label>
            <label className="grid gap-1 font-semibold sm:col-span-2">{t.add.originalNote}<textarea className="min-h-24 rounded-lg border p-3" name="originalNote" /></label>
            <button className="min-h-12 rounded-xl bg-ink-strong px-5 font-bold text-on-dark sm:col-span-2" disabled={busy}>{busy ? t.add.adding : t.add.addManualPlace}</button>
          </form>
        ) : (
          <form className="mt-6 grid gap-4" onSubmit={discover}>
            {mode === "url" ? (
              <label className="grid gap-1 font-semibold">{t.add.googleMapsUrl}<input className="min-h-12 rounded-lg border px-3" type="url" required value={url} onChange={(event) => setUrl(event.target.value)} /></label>
            ) : (
              <label className="grid gap-1 font-semibold">{t.add.searchGoogleMaps}<input className="min-h-12 rounded-lg border px-3" required maxLength={300} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
            )}
            <label className="grid gap-1 font-semibold">{t.add.originalNote}<textarea className="min-h-20 rounded-lg border p-3" value={note} onChange={(event) => setNote(event.target.value)} /></label>
            <button className="min-h-12 rounded-xl bg-ink-strong px-5 font-bold text-on-dark" disabled={busy}>{busy ? t.add.checking : mode === "url" ? t.add.resolveLink : t.add.searchPlaces}</button>
          </form>
        )}

        {candidates.length > 0 ? (
          <section className="mt-6" aria-labelledby="provider-candidates">
            <h4 id="provider-candidates" className="font-display text-2xl">{t.add.confirmTitle}</h4>
            {resolvedUrl ? <p className="mt-1 break-all text-sm text-muted-foreground">{t.add.resolvedTo(resolvedUrl)}</p> : null}
            <p className="mt-1 text-sm text-muted-foreground">{t.add.resultsProvidedBy(attribution)}</p>
            <ul className="mt-3 grid gap-3">
              {candidates.map((candidate) => (
                <li key={candidate.providerPlaceId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink/10 p-4">
                  <span><strong className="block">{candidate.name}</strong><small className="text-muted-foreground">{candidate.address ?? t.add.addressUnavailable}・{t.add.observedAt(new Date(candidate.observedAt).toLocaleString(locale))}</small></span>
                  <button className="min-h-11 rounded-lg bg-accent px-4 font-bold text-ink-strong" disabled={busy} onClick={() => void confirm(candidate)}>{t.add.addThisPlace}</button>
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

type PlanningInput = Omit<UpdateTripPlacePlanningInput, "expectedVersion">;

function planningValues(place: TripPlaceDto): PlanningInput {
  return { durationMinutes: place.durationMinutes, budgetAmountMinor: place.budgetAmountMinor, budgetCurrency: place.budgetCurrency, notes: place.notes };
}

function PlanningEditor({ tripId, place, available, request, changed, editingChanged }: {
  tripId: string;
  place: TripPlaceDto;
  available: boolean;
  request: TripPlaceWorkspaceProps["request"];
  changed(): Promise<void>;
  editingChanged(editing: boolean): void;
}) {
  const { t: { tripPlaces: t } } = useI18n();
  const [message, setMessage] = useState("");
  const [base, setBase] = useState<EditSnapshot<PlanningInput>>({ input: planningValues(place), version: place.version });
  const [draft, setDraft] = useState(base.input);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const resolution = useVersionConflict<PlanningInput>();
  const retryKeys = useRef<RetryKeys>(new Map());
  const dirty = useRef(false);
  const conflict = useMemo(() => available ? resolution.conflict : {
    base, current: null, attempted: draft, latestChange: null,
  }, [available, resolution.conflict, base, draft]);
  useEffect(() => {
    if (!editing && !resolution.conflict && place.version > base.version) {
      const snapshot = { input: planningValues(place), version: place.version };
      setBase(snapshot);
      setDraft(snapshot.input);
    }
  }, [place, editing, resolution.conflict, base.version]);
  async function save(input = draft, version = base.version, conflictBase = resolution.conflictBaseVersion) {
    setMessage("");
    setBusy(true);
    const operation = `planning:${place.id}`;
    const payload = { ...input, expectedVersion: version };
    try {
      const response = await request<{ tripPlace: TripPlaceDto }>(`/api/trips/${tripId}/trip-places/${place.id}/planning`, {
        method: "PATCH",
        headers: { "Idempotency-Key": retryKey(retryKeys.current, operation, payload), ...(conflictBase ? { "Conflict-Base-Version": String(conflictBase) } : {}) },
        body: JSON.stringify(payload),
        parse: parseTripPlaceResponse,
      });
      clearRetryKey(retryKeys.current, operation);
      resolution.clear();
      setBase({ input: planningValues(response.tripPlace), version: response.tripPlace.version });
      setDraft(planningValues(response.tripPlace));
      dirty.current = false;
      setEditing(false);
      editingChanged(false);
      setMessage(t.planning.saved);
      await changed();
    } catch (error) {
      try {
        if (error instanceof ApiRequestError && error.code === "trip_place_not_found") {
          editingChanged(true);
          await changed();
          return;
        }
        if (await resolution.capture(error, base, input, async () => {
          const latest = parseTripPlaceListResponse(await request(`/api/trips/${tripId}/trip-places`)).tripPlaces.find((entry) => entry.id === place.id);
          return latest ? { input: planningValues(latest), version: latest.version } : null;
        })) { editingChanged(true); return; }
        setMessage(t.errors.editsPreserved(errorMessage(error, t.errors.requestFailed)));
      } catch (reason) {
        setMessage(t.errors.editsPreserved(errorMessage(reason, t.errors.requestFailed)));
      }
    } finally { setBusy(false); }
  }

  return <details open={available ? undefined : true} className="rounded-xl border border-ink/10 p-3" onToggle={(event) => {
    if (available && event.currentTarget.open && !editing && !conflict) {
      const snapshot = { input: planningValues(place), version: place.version };
      setBase(snapshot); setDraft(snapshot.input); setEditing(true);
    }
    if (!event.currentTarget.open && !dirty.current && !conflict) {
      setEditing(false);
      editingChanged(false);
    }
  }}>
    <summary className="cursor-pointer font-bold">{t.planning.summary}</summary>
    {conflict ? <ConflictPanel conflict={conflict} busy={busy}
      onAccept={() => {
        const current = conflict.current;
        if (current) { setBase(current); setDraft(current.input); }
        dirty.current = false;
        resolution.clear(); setEditing(false); editingChanged(false); setMessage(""); void changed();
      }}
      onReapply={() => void save(conflict.attempted, conflict.current!.version, conflict.base.version)}
      onEdit={() => { setBase(conflict.current!); resolution.resume(); setMessage(""); }}
    /> : null}
    <form hidden={Boolean(conflict)} className="mt-4 grid gap-4" onChange={() => { dirty.current = true; setEditing(true); editingChanged(true); }} onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 font-semibold">{t.planning.durationMinutes}<input className="min-h-11 rounded-lg border px-3" name="durationMinutes" type="number" min="1" value={draft.durationMinutes ?? ""} onChange={(event) => setDraft({ ...draft, durationMinutes: event.target.value === "" ? null : Number(event.target.value) })} placeholder={t.planning.unknown} /></label>
        <label className="grid gap-1 font-semibold">{t.planning.budgetMinorUnits}<input className="min-h-11 rounded-lg border px-3" name="budgetAmountMinor" type="number" min="0" value={draft.budgetAmountMinor ?? ""} onChange={(event) => setDraft({ ...draft, budgetAmountMinor: event.target.value === "" ? null : Number(event.target.value) })} placeholder={t.planning.unknown} /></label>
        <label className="grid gap-1 font-semibold">{t.planning.isoCurrency}<input className="min-h-11 rounded-lg border px-3 uppercase" name="budgetCurrency" maxLength={3} value={draft.budgetCurrency ?? ""} onChange={(event) => setDraft({ ...draft, budgetCurrency: event.target.value || null })} placeholder={t.planning.unknown} /></label>
        <label className="grid gap-1 font-semibold sm:col-span-2">{t.planning.sharedNote}<textarea className="min-h-20 rounded-lg border p-3" name="notes" value={draft.notes ?? ""} onChange={(event) => setDraft({ ...draft, notes: event.target.value || null })} /></label>
      </div>
      <button disabled={busy} className="min-h-11 rounded-lg bg-ink-strong px-4 font-bold text-on-dark">{t.planning.save}</button>
    </form>
    {message ? <p role="status">{message}</p> : null}
  </details>;
}

export function TripPlaceWorkspace({
  trip,
  request,
  placesRevision,
  onPlacesChanged,
}: TripPlaceWorkspaceProps) {
  const { locale, t: { tripPlaces: t } } = useI18n();
  const [readModel, setReadModel] = useState<{ current: TripPlaceDto[]; retained: TripPlaceDto[] }>({ current: [], retained: [] });
  const places = readModel.current;
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [voteDrafts, setVoteDrafts] = useState<Record<string, boolean>>({});
  const [failedVotes, setFailedVotes] = useState<Record<string, true>>({});
  const [pendingVotes, setPendingVotes] = useState<Record<string, true>>({});
  const pendingVoteIds = useRef(new Set<string>());
  const retryKeys = useRef<RetryKeys>(new Map());
  const editingPlaceIds = useRef(new Set<string>());
  const [expandedPlaces, setExpandedPlaces] = useState<Record<string, boolean>>({});

  const refreshPlaces = useCallback(async () => {
    const response = await request<unknown>(`/api/trips/${trip.id}/trip-places`);
    const current = parseTripPlaceListResponse(response).tripPlaces;
    const currentIds = new Set(current.map((place) => place.id));
    setReadModel((previous) => ({
      current,
      retained: [...previous.current, ...previous.retained].filter((place) => editingPlaceIds.current.has(place.id) && !currentIds.has(place.id)),
    }));
  }, [request, trip.id]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await refreshPlaces();
      setMessage("");
    } catch (error) {
      setMessage(errorMessage(error, t.errors.requestFailed));
    } finally {
      setLoading(false);
    }
  }, [refreshPlaces, t.errors.requestFailed]);

  useEffect(() => {
    void load();
  }, [load, placesRevision, trip.members.length]);

  async function changedPlaces() {
    await load();
    onPlacesChanged();
  }

  const placesById = useMemo(
    () => new Map(places.map((place) => [place.id, place])),
    [places],
  );
  const duplicateSuggestionsByPlace = useMemo(() => {
    const byPlace = new Map<string, TripPlaceDto["duplicateSuggestions"]>();
    function add(placeId: string, suggestion: TripPlaceDto["duplicateSuggestions"][number]) {
      const existing = byPlace.get(placeId) ?? [];
      if (!existing.some((entry) => entry.id === suggestion.id)) {
        byPlace.set(placeId, [...existing, suggestion]);
      }
    }
    for (const place of places) {
      for (const suggestion of place.duplicateSuggestions) {
        add(place.id, suggestion);
        if (placesById.has(suggestion.otherTripPlaceId)) {
          add(suggestion.otherTripPlaceId, { ...suggestion, otherTripPlaceId: place.id });
        }
      }
    }
    return byPlace;
  }, [places, placesById]);

  async function setVote(place: TripPlaceDto, voted: boolean) {
    if (pendingVoteIds.current.has(place.id)) return;
    pendingVoteIds.current.add(place.id);
    setPendingVotes((current) => ({ ...current, [place.id]: true }));
    const operation = `vote:${place.id}`;
    const payload = { voted };
    setVoteDrafts((current) => ({ ...current, [place.id]: voted }));
    setFailedVotes((current) => {
      const next = { ...current };
      delete next[place.id];
      return next;
    });
    try {
      await request(
        `/api/trips/${trip.id}/trip-places/${place.id}/vote`,
        {
          method: "PUT",
          headers: { "Idempotency-Key": retryKey(retryKeys.current, operation, payload) },
          body: JSON.stringify(payload),
          parse: parseTripPlaceResponse,
        },
      );
      await refreshPlaces();
      clearRetryKey(retryKeys.current, operation);
      setVoteDrafts((current) => {
        const next = { ...current };
        delete next[place.id];
        return next;
      });
      setMessage("");
      setFailedVotes((current) => {
        const next = { ...current };
        delete next[place.id];
        return next;
      });
      onPlacesChanged();
    } catch (error) {
      if (errorCode(error) === "conflict" || errorCode(error) === "voting_unavailable") {
        try {
          await refreshPlaces();
        } catch {
          // Keep the original mutation error actionable.
        }
      }
      setMessage(errorMessage(error, t.errors.requestFailed));
      setFailedVotes((current) => ({ ...current, [place.id]: true }));
    } finally {
      pendingVoteIds.current.delete(place.id);
      setPendingVotes((current) => {
        const next = { ...current };
        delete next[place.id];
        return next;
      });
    }
  }

  async function remove(place: TripPlaceDto) {
    if (!window.confirm(t.workspace.confirmRemove(place.name))) return;
    const operation = `remove:${place.id}`;
    const payload = { expectedVersion: place.version };
    try {
      await request(`/api/trips/${trip.id}/trip-places/${place.id}/remove`, {
        method: "POST",
        headers: { "Idempotency-Key": retryKey(retryKeys.current, operation, payload) },
        body: JSON.stringify(payload),
      });
      clearRetryKey(retryKeys.current, operation);
      editingPlaceIds.current.delete(place.id);
      await load();
      onPlacesChanged();
    } catch (error) {
      setMessage(errorMessage(error, t.errors.requestFailed));
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
      setMessage(errorMessage(error, t.errors.requestFailed));
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
      setMessage(errorMessage(error, t.errors.requestFailed));
    }
  }

  const highestVoteCount = places.reduce((highest, place) => Math.max(highest, place.voteCount), 0);
  const listedPlaces = [...places, ...readModel.retained];
  const showVotes = places.some((place) => place.votingAvailable);
  const placeNameCounts = new Map<string, number>();
  for (const place of listedPlaces) {
    placeNameCounts.set(place.name, (placeNameCounts.get(place.name) ?? 0) + 1);
  }

  return (
    <section className="rounded-card border border-ink/10 bg-surface p-5 shadow-card sm:p-8" aria-labelledby="shared-wishlist-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-accent-strong">{t.workspace.eyebrow}</p>
          <h2 id="shared-wishlist-heading" className="font-display text-3xl text-ink-strong sm:text-4xl">{t.workspace.title}</h2>
          <p className="mt-2 max-w-3xl text-muted-foreground">{t.workspace.description}</p>
        </div>
        <button className="min-h-12 rounded-xl bg-accent px-5 font-bold text-ink-strong" onClick={() => setAdding(true)}>{t.workspace.addPlace}</button>
      </div>

      {message ? <p className="mt-4 rounded-xl bg-surface-subtle p-4" role="alert">{message}</p> : null}
      {/* A reload keeps the list in place; an extra line above it would push the page down. */}
      {loading && places.length === 0 ? <p className="mt-6" role="status">{t.workspace.loading}</p> : null}
      {!loading && places.length === 0 && readModel.retained.length === 0 ? <p className="mt-6 rounded-xl border border-dashed border-ink/20 p-6 text-center text-muted-foreground">{t.workspace.empty}</p> : null}

      {listedPlaces.length > 0 ? (
        <div className="mt-6 overflow-hidden rounded-panel border border-ink/10">
          <table className="block w-full border-separate border-spacing-0 text-left xl:table" aria-label={t.workspace.tableLabel}>
            <thead className="table w-full table-fixed bg-surface-subtle text-sm xl:table-header-group">
              <tr>
                <th className="px-3 py-3 font-bold xl:min-w-64 xl:px-4" scope="col">{t.workspace.columns.place}</th>
                <th className="hidden px-3 py-3 font-bold xl:table-cell xl:w-44" scope="col">{t.workspace.columns.type}</th>
                <th className="hidden px-3 py-3 font-bold xl:table-cell xl:w-40" scope="col">{t.workspace.columns.planned}</th>
                {showVotes ? <th className="w-0 p-0 xl:w-48 xl:px-3 xl:py-3" scope="col"><span className="sr-only xl:not-sr-only">{t.workspace.columns.votes}</span></th> : null}
                <th className="w-20 px-2 py-3 font-bold xl:w-24 xl:px-3" scope="col"><span className="sr-only">{t.workspace.columns.more}</span></th>
              </tr>
            </thead>
            {listedPlaces.map((place) => {
              const available = placesById.has(place.id);
              const voteDraft = voteDrafts[place.id];
              const tint = place.votingAvailable && place.voteCount > 0
                ? place.voteCount === highestVoteCount && highestVoteCount >= 2 ? "bg-accent/20" : "bg-accent/10"
                : "bg-surface-subtle";
              const typeLabel = t.placeType[place.type];
              const factsLabel = place.factsSource === "provider"
                ? place.providerAttribution ?? t.workspace.providerFacts
                : place.provider === "google"
                  ? t.workspace.memberFactsWithGoogle
                  : t.workspace.manualEntry;
              const assignedDate = place.assignedDayId
                ? trip.days.find((day) => day.id === place.assignedDayId)?.date ?? t.workspace.unavailableTripDay
                : null;
              const plannedLabel = assignedDate
                ? assignedDate
                : place.status === "scheduled" ? t.status.scheduled : t.workspace.notPlanned;
              const duplicateSuggestions = duplicateSuggestionsByPlace.get(place.id) ?? [];
              const actionStatus = duplicateSuggestions.length > 0 ? "possible-duplicate" : place.status;
              const needsAction = actionStatus === "needs-location"
                || actionStatus === "possible-duplicate"
                || actionStatus === "provider-unavailable";
              const expanded = !available || (expandedPlaces[place.id] ?? false);
              const detailsId = `wishlist-place-${place.id}-details`;
              const repeatedName = (placeNameCounts.get(place.name) ?? 0) > 1;
              const rowLabel = repeatedName
                ? t.workspace.placeAtAddress(place.name, place.address ?? t.workspace.unknownAddress)
                : place.name;
              return (
                <tbody key={place.id} data-wishlist-place={place.name} className="block w-full xl:table-row-group">
                  <tr aria-label={rowLabel} className={`grid w-full grid-cols-[minmax(0,1fr)_5rem] ${tint} xl:table-row`}>
                    <th className="col-span-2 col-start-1 row-start-1 py-3 pl-3 pr-24 align-top xl:table-cell xl:min-w-64 xl:px-4 xl:py-4" scope="row">
                      <span className="text-xl font-semibold text-ink-strong">{place.name}</span>
                      {repeatedName ? <span className="mt-1 block text-sm font-normal text-muted-foreground">{place.address ?? t.workspace.unknownAddress}</span> : null}
                      {available && needsAction ? (
                        <span className="mt-1 flex w-fit items-center gap-1 rounded-full border border-ink/15 bg-surface px-2 py-1 text-xs font-bold">
                          <StatusIcon status={actionStatus} />{statusLabel(actionStatus, t)}
                        </span>
                      ) : null}
                    </th>
                    <td className="hidden px-3 py-4 align-top xl:table-cell">{typeLabel}</td>
                    <td className="hidden px-3 py-4 align-top font-semibold tabular-nums xl:table-cell">{available ? plannedLabel : null}</td>
                    {showVotes ? (
                      <td className={`col-span-2 col-start-1 row-start-2 align-top xl:table-cell xl:px-3 xl:py-2 ${available && place.votingAvailable ? "px-3 pb-3" : "p-0 xl:p-2"}`}>
                        {available && place.votingAvailable ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <VoteControl compact name={place.name} voters={place.voters} voteCount={place.voteCount} ownVote={place.ownVote} votingAvailable disabled={Boolean(pendingVotes[place.id])} onChange={(voted) => void setVote(place, voted)} />
                            {failedVotes[place.id] && voteDraft !== undefined ? <button className="min-h-11 whitespace-nowrap rounded-lg border px-3 font-bold" disabled={pendingVotes[place.id]} onClick={() => void setVote(place, voteDraft)}>{t.vote.retry}</button> : null}
                          </div>
                        ) : null}
                      </td>
                    ) : null}
                    <td className="col-start-2 row-span-2 row-start-1 px-2 py-2 align-top xl:table-cell xl:px-3">
                      {available ? (
                        <button
                          type="button"
                          className="min-h-11 whitespace-nowrap rounded-lg border bg-surface px-3 font-bold"
                          aria-expanded={expanded}
                          aria-controls={detailsId}
                          onClick={() => setExpandedPlaces((current) => ({ ...current, [place.id]: !expanded }))}
                        >
                          {t.workspace.columns.more}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                  <tr id={detailsId} hidden={!expanded} className="block w-full bg-surface xl:table-row">
                    <td className="block w-full border-t border-ink/10 p-4 xl:table-cell xl:p-5" colSpan={showVotes ? 5 : 4}>
                      <div className="grid gap-4">
                        <dl className="grid grid-cols-2 gap-3 xl:hidden">
                          <div><dt className="text-sm font-bold">{t.workspace.columns.type}</dt><dd>{typeLabel}</dd></div>
                          {available ? <div><dt className="text-sm font-bold">{t.workspace.columns.planned}</dt><dd className="tabular-nums">{plannedLabel}</dd></div> : null}
                        </dl>
                        <div>
                          <p className="text-sm text-muted-foreground">{t.workspace.factsSource(factsLabel)}{place.aiProposalId ? `・${t.workspace.aiProposal}` : ""}</p>
                          <p className="mt-1 text-sm text-muted-foreground">{place.address ?? t.workspace.unknownAddress}</p>
                        </div>
                        {place.providerObservedAt ? <p className="text-sm text-muted-foreground">{t.workspace.providerObserved(new Date(place.providerObservedAt).toLocaleString(locale))}{place.providerFactsExpired ? `・${t.workspace.expiredFacts}` : ""}</p> : null}
                        {place.provider === "google" && place.providerPlaceId ? <a className="inline-flex min-h-11 w-fit items-center gap-2 rounded-lg border bg-surface px-3 font-bold" href={googleMapsPlaceUrl(place.name, place.providerPlaceId)} target="_blank" rel="noreferrer"><Images aria-hidden="true" className="size-4" />{t.workspace.viewPhotos}</a> : null}
                        {place.sourceUrl ? <a className="w-fit break-all text-sm font-bold text-accent-strong underline" href={place.sourceUrl} rel="noreferrer" target="_blank">{t.workspace.openOriginalSource}</a> : null}
                        {place.notes ? <p className="whitespace-pre-wrap break-words text-sm">{place.notes}</p> : null}
                        {available && place.votingAvailable ? <VoteVoters voters={place.voters} /> : null}
                        {available ? duplicateSuggestions.map((suggestion) => {
                          const other = placesById.get(suggestion.otherTripPlaceId);
                          return (
                            <section key={suggestion.id} className="rounded-xl border border-accent-strong bg-surface p-3" aria-label={t.duplicates.comparisonLabel}>
                              <strong className="block">{t.duplicates.compare}</strong>
                              <p className="mt-1 text-sm">{t.duplicates.reason(duplicateReason(suggestion.reason, t))}</p>
                              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                {([
                                  [t.duplicates.thisOption, place],
                                  [t.duplicates.otherOption, other],
                                ] as const).map(([label, candidate]) => (
                                  <section key={label} className="rounded-lg border border-ink/10 p-3" aria-label={label}>
                                    <span className="text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
                                    {candidate ? (
                                      <>
                                        <h5 className="text-xl font-semibold">{candidate.name}</h5>
                                        <p className="text-sm">{t.placeType[candidate.type]}・{candidate.address ?? t.workspace.unknownAddress}</p>
                                        <p className="mt-1 text-sm text-muted-foreground">
                                          {candidate.factsSource === "provider" ? t.duplicates.providerFacts : t.duplicates.memberFacts}
                                        </p>
                                        {candidate.notes ? <p className="mt-1 whitespace-pre-wrap break-words text-sm">{candidate.notes}</p> : null}
                                        {candidate.sourceUrl ? <a className="mt-1 block break-all text-sm underline" href={candidate.sourceUrl} rel="noreferrer" target="_blank">{t.workspace.openOriginalSource}</a> : null}
                                      </>
                                    ) : <p className="mt-1 text-sm text-muted-foreground">{t.duplicates.unavailable}</p>}
                                  </section>
                                ))}
                              </div>
                              <div className="mt-3 flex flex-wrap gap-2"><button className="min-h-11 rounded-lg bg-accent px-3 font-bold text-ink-strong" disabled={!other} onClick={() => void merge(place, suggestion.otherTripPlaceId)}>{t.duplicates.merge}</button><button className="min-h-11 rounded-lg border px-3 font-bold" onClick={() => void keepSeparate(suggestion.id)}>{t.duplicates.keepSeparate}</button></div>
                            </section>
                          );
                        }) : null}
                        <PlanningEditor tripId={trip.id} place={place} available={available} request={request} changed={changedPlaces}
                          editingChanged={(editing) => {
                            if (editing) editingPlaceIds.current.add(place.id);
                            else {
                              editingPlaceIds.current.delete(place.id);
                              setReadModel((current) => ({ ...current, retained: current.retained.filter((entry) => entry.id !== place.id) }));
                            }
                          }} />
                        {available ? <button className="min-h-11 w-fit rounded-lg border px-3 text-sm font-bold" onClick={() => void remove(place)}>{t.workspace.remove}</button> : null}
                      </div>
                    </td>
                  </tr>
                </tbody>
              );
            })}
          </table>
        </div>
      ) : null}
      {adding ? <AddPlacePanel tripId={trip.id} request={request} close={() => setAdding(false)} changed={changedPlaces} /> : null}
    </section>
  );
}
