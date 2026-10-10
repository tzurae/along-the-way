import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarCheck,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CloudOff,
  Images,
  MapPin,
  MapPinOff,
  Pencil,
  Plus,
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
import { PlaceDetailContent } from "./PlaceDetailContent";
import { PlacePhotoCredit, PlaceThumbnail, usePlacePreviews } from "./PlaceThumbnail";
import { PlaceDetailSheet } from "./PlaceDetailSheet";
import { NativeSelect } from "./components/ui/native-select";
import "./pocket-discovery.css";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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

function itineraryMembershipLabel(
  place: TripPlaceDto,
  t: Messages["tripPlaces"],
) {
  return place.selectedForItinerary
    ? t.workspace.selectedForItinerary
    : t.workspace.pocketCandidate;
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
  return <Icon aria-hidden="true" className="size-3.5 shrink-0" />;
}

function nullableNumber(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

interface ManualPlaceDraft {
  name: string;
  type: PlaceType;
  address: string;
  latitude: string;
  longitude: string;
  timeZone: string;
  sourceUrl: string;
}

const emptyManualPlaceDraft: ManualPlaceDraft = {
  name: "",
  type: "activity",
  address: "",
  latitude: "",
  longitude: "",
  timeZone: "",
  sourceUrl: "",
};


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
  const [mode, setMode] = useState<"url" | "search" | "manual">("search");
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [manualDraft, setManualDraft] = useState<ManualPlaceDraft>(emptyManualPlaceDraft);
  const [coordinateError, setCoordinateError] = useState("");
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
    const hasLatitude = manualDraft.latitude.trim() !== "";
    const hasLongitude = manualDraft.longitude.trim() !== "";
    if (hasLatitude !== hasLongitude) {
      setCoordinateError(t.add.coordinatesBothRequired);
      return;
    }
    setCoordinateError("");
    setBusy(true);
    setMessage("");
    const operation = "add-manual";
    const payload = {
      method: "manual",
      name: manualDraft.name,
      type: manualDraft.type,
      address: manualDraft.address.trim() || null,
      latitude: nullableNumber(manualDraft.latitude),
      longitude: nullableNumber(manualDraft.longitude),
      timeZone: manualDraft.timeZone.trim() || null,
      sourceUrl: manualDraft.sourceUrl.trim() || null,
      originalNote: note.trim() || null,
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
      const safeMessage = error instanceof ApiRequestError && error.code === "validation_error"
        ? t.errors.requestFailed
        : errorMessage(error, t.errors.requestFailed);
      setMessage(t.errors.manualPreserved(safeMessage));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PlaceDetailSheet open appearance="workspace" title={t.add.title} description={t.add.description} onClose={close}>
      <div className="pd-tabs" role="tablist" aria-label={t.add.methodLabel}>
        {([
          ["search", t.add.search],
          ["url", t.add.googleMapsLink],
          ["manual", t.add.manual],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            disabled={busy}
            onClick={() => {
              // Mode drafts persist; lookup results and errors belong only to the mode that produced them.
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
        <form key="manual" className="pd-form" onSubmit={addManual}>
          <p className="pd-add-intro">適合加入住家、朋友推薦，或暫時在地圖上找不到的地點。</p>
          <label>{t.add.placeName}<input name="name" required maxLength={200} value={manualDraft.name} onChange={(event) => setManualDraft({ ...manualDraft, name: event.target.value })} /></label>
          <label>{t.add.placeType}<NativeSelect name="type" value={manualDraft.type} onChange={(event) => setManualDraft({ ...manualDraft, type: event.target.value as PlaceType })}>{placeTypeValues.map((value) => <option key={value} value={value}>{t.placeType[value]}</option>)}</NativeSelect></label>
          <label>{t.add.originalNote}<textarea name="originalNote" value={note} maxLength={200} rows={2} placeholder={t.add.reasonPlaceholder} onChange={(event) => setNote(event.target.value)} /><span className="pd-field-help">{t.add.reasonHelp}</span></label>
          <details>
            <summary className="cursor-pointer font-bold">{t.add.locationAndSource}</summary>
            <div className="pd-form mt-3">
              <label>{t.add.addressIfKnown}<input name="address" value={manualDraft.address} onChange={(event) => setManualDraft({ ...manualDraft, address: event.target.value })} /></label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label>{t.add.latitudeIfKnown}<input name="latitude" type="number" min="-90" max="90" step="any" value={manualDraft.latitude} aria-invalid={coordinateError ? true : undefined} aria-describedby={coordinateError ? "manual-coordinate-error" : undefined} onChange={(event) => { setManualDraft({ ...manualDraft, latitude: event.target.value }); setCoordinateError(""); }} /></label>
                <label>{t.add.longitudeIfKnown}<input name="longitude" type="number" min="-180" max="180" step="any" value={manualDraft.longitude} aria-invalid={coordinateError ? true : undefined} aria-describedby={coordinateError ? "manual-coordinate-error" : undefined} onChange={(event) => { setManualDraft({ ...manualDraft, longitude: event.target.value }); setCoordinateError(""); }} /></label>
              </div>
              {coordinateError ? <p id="manual-coordinate-error" className="pd-field-error" role="alert">{coordinateError}</p> : null}
              <label>{t.add.timeZoneIfKnown}<input name="timeZone" placeholder={t.add.timeZonePlaceholder} value={manualDraft.timeZone} onChange={(event) => setManualDraft({ ...manualDraft, timeZone: event.target.value })} /></label>
              <label>{t.add.sourceLinkIfAny}<input name="sourceUrl" type="url" value={manualDraft.sourceUrl} onChange={(event) => setManualDraft({ ...manualDraft, sourceUrl: event.target.value })} /></label>
            </div>
          </details>
          <button className="pd-primary" disabled={busy}><Plus aria-hidden="true" className="size-4" />{busy ? t.add.adding : t.add.addManualPlace}</button>
        </form>
      ) : (
        <form key={mode} className="pd-form" onSubmit={discover}>
          <p className="pd-add-intro">{mode === "url" ? "貼上 Google Maps 分享連結，確認找到的地點後再加入。" : "用地點名稱或地區搜尋，再選擇正確的結果。"}</p>
          {mode === "url" ? (
            <label>{t.add.googleMapsUrl}<input type="url" required value={url} onChange={(event) => setUrl(event.target.value)} /></label>
          ) : (
            <label>{t.add.searchGoogleMaps}<input required maxLength={300} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          )}
          <label>{t.add.originalNote}<textarea value={note} maxLength={200} rows={2} placeholder={t.add.reasonPlaceholder} onChange={(event) => setNote(event.target.value)} /><span className="pd-field-help">{t.add.reasonHelp}</span></label>
          <button className="pd-primary" disabled={busy}>{busy ? t.add.checking : mode === "url" ? t.add.resolveLink : t.add.searchPlaces}</button>
        </form>
      )}

      {candidates.length > 0 ? (
        <section className="mt-5" aria-labelledby="provider-candidates">
          <h3 id="provider-candidates" className="pd-section-title">{t.add.confirmTitle}</h3>
          {resolvedUrl ? <p className="pd-add-intro break-all">{t.add.resolvedTo(resolvedUrl)}</p> : null}
          <p className="pd-add-intro">{t.add.resultsProvidedBy(attribution)}</p>
          <ul className="pd-result-list">
            {candidates.map((candidate) => (
              <li key={candidate.providerPlaceId}>
                <span><strong>{candidate.name}</strong><small>{candidate.address ?? t.add.addressUnavailable}・{t.add.observedAt(new Date(candidate.observedAt).toLocaleString(locale))}</small></span>
                <button className="pd-primary pd-accent" disabled={busy} onClick={() => void confirm(candidate)}>{t.add.addThisPlace}</button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {message ? <p className="pd-notice mt-4" role="alert">{message}</p> : null}
    </PlaceDetailSheet>
  );
}

type PlanningInput = Pick<UpdateTripPlacePlanningInput, "durationMinutes" | "budgetAmountMinor" | "budgetCurrency" | "notes">;

function planningValues(place: TripPlaceDto): PlanningInput {
  return {
    durationMinutes: place.durationMinutes,
    budgetAmountMinor: place.budgetAmountMinor,
    budgetCurrency: place.budgetCurrency,
    notes: place.notes,
  };
}

function PlanningEditors({ trip, place, available, request, changed, editingChanged }: {
  trip: TripDto;
  place: TripPlaceDto;
  available: boolean;
  request: TripPlaceWorkspaceProps["request"];
  changed(): Promise<void>;
  editingChanged(editing: boolean): void;
}) {
  const { t: { tripPlaces: t } } = useI18n();
  const [base, setBase] = useState<EditSnapshot<PlanningInput>>({ input: planningValues(place), version: place.version });
  const [draft, setDraft] = useState(base.input);
  const [reasonEditing, setReasonEditing] = useState(false);
  const [planningDirty, setPlanningDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reasonMessage, setReasonMessage] = useState("");
  const [planningMessage, setPlanningMessage] = useState("");
  const [conflictOwner, setConflictOwner] = useState<"reason" | "planning" | null>(null);
  const resolution = useVersionConflict<PlanningInput>();
  const retryKeys = useRef<RetryKeys>(new Map());
  const conflict = useMemo(() => available ? resolution.conflict : {
    base, current: null, attempted: draft, latestChange: null,
  }, [available, resolution.conflict, base, draft]);

  useEffect(() => {
    if (!reasonEditing && !planningDirty && !resolution.conflict && place.version > base.version) {
      const snapshot = { input: planningValues(place), version: place.version };
      setBase(snapshot);
      setDraft(snapshot.input);
    }
  }, [place, reasonEditing, planningDirty, resolution.conflict, base.version]);

  function finishOwnerEdit(owner: "reason" | "planning", next = base) {
    if (next !== base) setBase(next);
    setDraft((current) => {
      if (owner === "reason") {
        return planningDirty
          ? { ...current, notes: next.input.notes }
          : next.input;
      }
      return reasonEditing
        ? { ...next.input, notes: current.notes }
        : next.input;
    });
    if (owner === "reason") setReasonEditing(false);
    else setPlanningDirty(false);
    setConflictOwner(null);
    editingChanged(owner === "reason" ? planningDirty : reasonEditing);
  }

  function inputForOwner(owner: "reason" | "planning") {
    if (owner === "reason") {
      return { ...base.input, notes: draft.notes?.trim() || null };
    }
    return {
      ...base.input,
      durationMinutes: draft.durationMinutes,
      budgetAmountMinor: draft.budgetAmountMinor,
      budgetCurrency: draft.budgetCurrency,
    };
  }

  async function save(owner: "reason" | "planning", attempted?: PlanningInput, version = base.version, conflictBase = resolution.conflictBaseVersion) {
    const normalized = attempted ?? inputForOwner(owner);
    const setOwnerMessage = owner === "reason" ? setReasonMessage : setPlanningMessage;
    setOwnerMessage("");
    setBusy(true);
    setConflictOwner(owner);
    const operation = `planning:${place.id}`;
    const payload = { ...normalized, expectedVersion: version };
    try {
      const response = await request<{ tripPlace: TripPlaceDto }>(`/api/trips/${trip.id}/trip-places/${place.id}/planning`, {
        method: "PATCH",
        headers: { "Idempotency-Key": retryKey(retryKeys.current, operation, payload), ...(conflictBase ? { "Conflict-Base-Version": String(conflictBase) } : {}) },
        body: JSON.stringify(payload),
        parse: parseTripPlaceResponse,
      });
      clearRetryKey(retryKeys.current, operation);
      resolution.clear();
      finishOwnerEdit(owner, { input: planningValues(response.tripPlace), version: response.tripPlace.version });
      if (owner === "planning") setPlanningMessage(t.planning.saved);
      await changed();
    } catch (error) {
      try {
        if (error instanceof ApiRequestError && error.code === "trip_place_not_found") {
          editingChanged(true);
          await changed();
          return;
        }
        if (await resolution.capture(error, base, normalized, async () => {
          const latest = parseTripPlaceListResponse(await request(`/api/trips/${trip.id}/trip-places`)).tripPlaces.find((entry) => entry.id === place.id);
          return latest ? { input: planningValues(latest), version: latest.version } : null;
        })) {
          editingChanged(true);
          return;
        }
        setOwnerMessage(t.errors.editsPreserved(errorMessage(error, t.errors.requestFailed)));
      } catch (reason) {
        setOwnerMessage(t.errors.editsPreserved(errorMessage(reason, t.errors.requestFailed)));
      }
    } finally {
      setBusy(false);
    }
  }

  function conflictPanel(owner: "reason" | "planning") {
    if (!conflict || (conflictOwner ?? "planning") !== owner) return null;
    const setOwnerMessage = owner === "reason" ? setReasonMessage : setPlanningMessage;
    return <ConflictPanel conflict={conflict} busy={busy}
      onAccept={() => {
        finishOwnerEdit(owner, conflict.current ?? base);
        resolution.clear();
        setOwnerMessage("");
        void changed();
      }}
      onReapply={() => void save(owner, conflict.attempted, conflict.current!.version, conflict.base.version)}
      onEdit={() => {
        const current = conflict.current!;
        setBase(current);
        setDraft((existing) => owner === "reason"
          ? {
              ...(planningDirty ? existing : current.input),
              notes: conflict.attempted.notes,
            }
          : {
              ...current.input,
              ...(reasonEditing ? { notes: existing.notes } : {}),
              durationMinutes: conflict.attempted.durationMinutes,
              budgetAmountMinor: conflict.attempted.budgetAmountMinor,
              budgetCurrency: conflict.attempted.budgetCurrency,
            });
        resolution.resume();
        setConflictOwner(null);
        if (owner === "reason") setReasonEditing(true);
        else setPlanningDirty(true);
        setOwnerMessage("");
      }}
    />;
  }

  const savedNotes = base.input.notes;
  return <>
    <section className="pd-detail-section">
      <div className="pd-reason-head">
        <h3>{t.workspace.reasonTitle}</h3>
        {available && !reasonEditing && !conflict ? <button type="button" className="pd-reason-action" onClick={() => {
          if (!planningDirty) {
            const snapshot = { input: planningValues(place), version: place.version };
            setBase(snapshot);
            setDraft(snapshot.input);
          }
          setReasonEditing(true);
          editingChanged(true);
        }}><Pencil aria-hidden="true" className="size-4" />{savedNotes ? t.workspace.editReason : t.workspace.addReason}</button> : null}
      </div>
      {conflictPanel("reason")}
      {reasonEditing && !conflict ? (
        <form className="pd-reason-form" onSubmit={(event) => { event.preventDefault(); void save("reason"); }}>
          <textarea value={draft.notes ?? ""} maxLength={200} rows={3} placeholder={t.add.reasonPlaceholder} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
          <p className="pd-field-help">{t.add.reasonHelp}</p>
          <div className="pd-reason-actions">
            <button type="button" className="pd-secondary" disabled={busy} onClick={() => {
              setDraft({ ...draft, notes: base.input.notes });
              setReasonEditing(false);
              editingChanged(planningDirty);
              setReasonMessage("");
            }}>{t.workspace.cancelReason}</button>
            <button type="submit" className="pd-primary" disabled={busy}><CircleCheck aria-hidden="true" className="size-4" />{busy ? t.workspace.savingReason : t.workspace.saveReason}</button>
          </div>
        </form>
      ) : !conflict ? <p className={savedNotes ? "pd-reason-copy" : "pd-reason-copy pd-muted"}>{savedNotes ?? t.workspace.noReasonDetail}</p> : null}
      {reasonMessage ? <p className="pd-notice mt-3" role="alert">{reasonMessage}</p> : null}
    </section>

    <PlaceDayPicker key={`day:${place.id}`} trip={trip} place={place} available={available} request={request} changed={changed} />

    <details open={available ? undefined : true} className="rounded-xl border border-ink/10 p-3" onToggle={(event) => {
      if (available && event.currentTarget.open && !planningDirty && !reasonEditing && !conflict) {
        const snapshot = { input: planningValues(place), version: place.version };
        setBase(snapshot);
        setDraft(snapshot.input);
      }
      if (!event.currentTarget.open && !planningDirty && !conflict) editingChanged(reasonEditing);
    }}>
      <summary className="cursor-pointer font-bold">{t.planning.summary}</summary>
      {conflictPanel("planning")}
      <form hidden={Boolean(conflict)} className="mt-4 grid gap-4" onChange={() => {
        setPlanningDirty(true);
        editingChanged(true);
      }} onSubmit={(event) => { event.preventDefault(); void save("planning"); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 font-semibold">{t.planning.durationMinutes}<input className="min-h-11 rounded-lg border px-3" name="durationMinutes" type="number" min="1" value={draft.durationMinutes ?? ""} onChange={(event) => setDraft({ ...draft, durationMinutes: event.target.value === "" ? null : Number(event.target.value) })} placeholder={t.planning.unknown} /></label>
          <label className="grid gap-1 font-semibold">{t.planning.budgetMinorUnits}<input className="min-h-11 rounded-lg border px-3" name="budgetAmountMinor" type="number" min="0" value={draft.budgetAmountMinor ?? ""} onChange={(event) => setDraft({ ...draft, budgetAmountMinor: event.target.value === "" ? null : Number(event.target.value) })} placeholder={t.planning.unknown} /></label>
          <label className="grid gap-1 font-semibold">{t.planning.isoCurrency}<input className="min-h-11 rounded-lg border px-3 uppercase" name="budgetCurrency" maxLength={3} value={draft.budgetCurrency ?? ""} onChange={(event) => setDraft({ ...draft, budgetCurrency: event.target.value || null })} placeholder={t.planning.unknown} /></label>
        </div>
        <button disabled={busy} className="min-h-11 rounded-lg bg-ink-strong px-4 font-bold text-on-dark">{t.planning.save}</button>
      </form>
      {planningMessage ? <p role="status">{planningMessage}</p> : null}
    </details>
  </>;
}

function PlaceDayPicker({ trip, place, available, request, changed }: {
  trip: TripDto;
  place: TripPlaceDto;
  available: boolean;
  request<T>(url: string, options?: RequestOptions): Promise<T>;
  changed(): Promise<void>;
}) {
  const { locale, t } = useI18n();
  const [dayId, setDayId] = useState(place.assignedDayId ?? "");
  const [base, setBase] = useState({ dayId: place.assignedDayId ?? "", version: place.version });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const keys = useRef<RetryKeys>(new Map());
  useEffect(() => {
    if (!busy && dayId === base.dayId && (place.version !== base.version || (place.assignedDayId ?? "") !== base.dayId)) {
      setDayId(place.assignedDayId ?? "");
      setBase({ dayId: place.assignedDayId ?? "", version: place.version });
    }
  }, [place.assignedDayId, place.version, busy, dayId, base.dayId, base.version]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !available || place.scheduled) return;
    const targetDay = dayId || null;
    const operation = `day-assignment:${place.id}`;
    setBusy(true);
    setError("");
    let removedOriginalDay = false;
    try {
      async function assign(tripDayId: string | null, expectedVersion: number) {
        const payload = { assignments: [{ tripPlaceId: place.id, tripDayId, expectedVersion }] };
        const response = await request<ReturnType<typeof parseTripPlaceListResponse>>(`/api/trips/${trip.id}/trip-place-day-assignments`, {
          method: "PUT",
          headers: { "Idempotency-Key": retryKey(keys.current, operation, payload) },
          body: JSON.stringify(payload),
          parse: parseTripPlaceListResponse,
        });
        clearRetryKey(keys.current, operation);
        const updated = response.tripPlaces.find((entry) => entry.id === place.id);
        if (!updated) throw new Error(t.tripPlaces.errors.requestFailed);
        return updated;
      }
      let version = base.version;
      // The existing API requires remove-before-reassign; each step uses its real returned version.
      if (base.dayId && targetDay && base.dayId !== targetDay) {
        const removed = await assign(null, version);
        version = removed.version;
        removedOriginalDay = true;
        setBase({ dayId: "", version });
      }
      const updated = await assign(targetDay, version);
      setDayId(updated.assignedDayId ?? "");
      setBase({ dayId: updated.assignedDayId ?? "", version: updated.version });
      await changed();
    } catch (reason) {
      const failure = errorMessage(reason, t.tripSkeleton.plannedDayUpdateError);
      setError(removedOriginalDay ? `原日期已移出，尚未排入新日期。${failure}` : failure);
      await changed();
    } finally {
      setBusy(false);
    }
  }
  if (place.scheduled) return null;
  const located = place.latitude !== null && place.longitude !== null;
  if (!located) {
    return <section className="pd-detail-section">
      <h3>{t.tripPlaces.workspace.scheduleTitle}</h3>
      <div className="pd-location-warning" role="status">
        <MapPinOff aria-hidden="true" className="size-4" />
        <div>
          <strong>{t.tripPlaces.workspace.locationMissing}</strong>
          <p>{t.tripPlaces.workspace.locationMissingHelp}</p>
          <a className="pd-secondary pd-location-action" href={`?trip=${encodeURIComponent(trip.id)}&tab=itinerary&segment=daily&manage=places`}><MapPin aria-hidden="true" className="size-4" />{t.tripPlaces.workspace.addLocation}</a>
        </div>
      </div>
    </section>;
  }
  return <section className="pd-detail-section">
    <h3>{t.tripPlaces.workspace.scheduleTitle}</h3>
    <form onSubmit={(event) => void save(event)}>
      <fieldset className="pd-daypicker" disabled={busy || !available}>
        <legend className="sr-only">{t.tripPlaces.workspace.chooseDay}</legend>
        <label><input type="radio" name={`day-${place.id}`} value="" checked={!dayId} onChange={() => setDayId("")} /><span>{place.selectedForItinerary ? t.tripPlaces.workspace.pendingArrangement : t.tripPlaces.workspace.notPlanned}</span></label>
        {trip.days.map((day, index) => <label key={day.id}><input type="radio" name={`day-${place.id}`} value={day.id} checked={dayId === day.id} onChange={() => setDayId(day.id)} /><span>{t.tripSkeleton.dayLabel(index + 1)}<small>{new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "numeric", day: "numeric" }).format(new Date(`${day.date}T12:00:00Z`))}</small></span></label>)}
      </fieldset>
      {dayId !== base.dayId ? <button className="pd-primary mt-3" disabled={busy || !available}>{busy ? t.tripPlaces.workspace.scheduling : dayId ? t.tripPlaces.workspace.addToSchedule : t.tripPlaces.workspace.removeFromDay}</button> : null}
      {error ? <div className="pd-notice mt-3" role="alert">{error}<button type="button" className="pd-secondary mt-2" disabled={busy} onClick={() => { setDayId(place.assignedDayId ?? ""); setBase({ dayId: place.assignedDayId ?? "", version: place.version }); setError(""); }}>{t.tripPlaces.workspace.reloadDay}</button></div> : null}
    </form>
  </section>;
}

export function TripPlaceWorkspace({
  trip,
  request,
  placesRevision,
  onPlacesChanged,
}: TripPlaceWorkspaceProps) {
  const { locale, t: { tripPlaces: t, app: appText } } = useI18n();
  const [readModel, setReadModel] = useState<{ current: TripPlaceDto[]; retained: TripPlaceDto[] }>({ current: [], retained: [] });
  const places = readModel.current;
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState("");
  const [readError, setReadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [voteDrafts, setVoteDrafts] = useState<Record<string, boolean>>({});
  const [failedVotes, setFailedVotes] = useState<Record<string, true>>({});
  const [pendingVotes, setPendingVotes] = useState<Record<string, true>>({});
  const pendingVoteIds = useRef(new Set<string>());
  const retryKeys = useRef<RetryKeys>(new Map());
  const editingPlaceIds = useRef(new Set<string>());
  const readGeneration = useRef(0);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const detailTitleRef = useRef<HTMLHeadingElement>(null);
  const detailReturnPosition = useRef<{ x: number; y: number } | null>(null);
  const [mergeConfirmation, setMergeConfirmation] = useState<{ source: TripPlaceDto; target: TripPlaceDto } | null>(null);
  const [merging, setMerging] = useState(false);
  const [removalConfirmation, setRemovalConfirmation] = useState<TripPlaceDto | null>(null);
  const [removing, setRemoving] = useState(false);

  function openDetail(placeId: string) {
    if (placeId === selectedPlaceId) {
      window.requestAnimationFrame(() => detailTitleRef.current?.focus());
      return;
    }
    detailReturnPosition.current = { x: window.scrollX, y: window.scrollY };
    setSelectedPlaceId(placeId);
  }

  const refreshPlaces = useCallback(async (generation = ++readGeneration.current) => {
    try {
      const response = await request<unknown>(`/api/trips/${trip.id}/trip-places`);
      if (generation !== readGeneration.current) return false;
      const current = parseTripPlaceListResponse(response).tripPlaces;
      const currentIds = new Set(current.map((place) => place.id));
      setReadModel((previous) => ({
        current,
        retained: [...previous.current, ...previous.retained].filter((place) => editingPlaceIds.current.has(place.id) && !currentIds.has(place.id)),
      }));
      setReadError("");
      setLoading(false);
      return true;
    } catch (error) {
      if (generation !== readGeneration.current) return false;
      setLoading(false);
      throw error;
    }
  }, [request, trip.id]);

  const load = useCallback(async () => {
    const generation = ++readGeneration.current;
    setLoading(true);
    setReadError("");
    try {
      const accepted = await refreshPlaces(generation);
      if (accepted) setReadError("");
    } catch (error) {
      if (generation === readGeneration.current) {
        setReadError(errorMessage(error, t.errors.requestFailed));
      }
    } finally {
      if (generation === readGeneration.current) setLoading(false);
    }
  }, [refreshPlaces, t.errors.requestFailed]);

  useEffect(() => {
    void load();
  }, [load, placesRevision, trip.members.length]);

  useEffect(() => {
    const retained = readModel.retained[0];
    if (retained) setSelectedPlaceId(retained.id);
  }, [readModel.retained]);

  function closeDetail() {
    const placeId = selectedPlaceId;
    const position = detailReturnPosition.current;
    detailReturnPosition.current = null;
    setSelectedPlaceId(null);
    setRemovalConfirmation(null);
    if (placeId) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-place-detail-trigger="${placeId}"]`)?.focus({ preventScroll: true });
        if (position) window.scrollTo({ left: position.x, top: position.y, behavior: "instant" });
      });
    }
  }

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
      const refreshed = await refreshPlaces();
      clearRetryKey(retryKeys.current, operation);
      setVoteDrafts((current) => {
        const next = { ...current };
        delete next[place.id];
        return next;
      });
      if (refreshed) setMessage("");
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
    if (removing) return;
    setRemoving(true);
    setMessage("");
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
      setRemovalConfirmation(null);
    } catch (error) {
      setMessage(errorMessage(error, t.errors.requestFailed));
    } finally {
      setRemoving(false);
    }
  }

  async function merge(source: TripPlaceDto, target: TripPlaceDto) {
    const operation = `merge:${source.id}:${target.id}`;
    const payload = {
      targetTripPlaceId: target.id,
      expectedSourceVersion: source.version,
      expectedTargetVersion: target.version,
    };
    setMerging(true);
    try {
      await request(`/api/trips/${trip.id}/trip-places/${source.id}/merge`, {
        method: "POST",
        headers: { "Idempotency-Key": retryKey(retryKeys.current, operation, payload) },
        body: JSON.stringify(payload),
        parse: parseTripPlaceResponse,
      });
      clearRetryKey(retryKeys.current, operation);
      setSelectedPlaceId(target.id);
      setMergeConfirmation(null);
      await load();
      onPlacesChanged();
    } catch (error) {
      setMessage(errorMessage(error, t.errors.requestFailed));
    } finally {
      setMerging(false);
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

  const listedPlaces = [...places, ...readModel.retained];
  const placeNameCounts = new Map<string, number>();
  for (const place of listedPlaces) {
    placeNameCounts.set(place.name, (placeNameCounts.get(place.name) ?? 0) + 1);
  }
  const selectedPlace = listedPlaces.find((place) => place.id === selectedPlaceId) ?? null;
  const previews = usePlacePreviews({
    tripId: trip.id,
    kind: "trip-place",
    ids: listedPlaces.map((place) => place.id),
    request,
  });

  function quickActions(place: TripPlaceDto) {
    if (!placesById.has(place.id) || !place.votingAvailable) return null;
    const voteDraft = voteDrafts[place.id];
    return (
      <div className="pd-row-actions">
        <VoteControl compact name={place.name} voters={place.voters} voteCount={place.voteCount} ownVote={place.ownVote} votingAvailable disabled={Boolean(pendingVotes[place.id])} onChange={(voted) => void setVote(place, voted)} />
        {failedVotes[place.id] && voteDraft !== undefined ? (
          <button className="pd-secondary" disabled={pendingVotes[place.id]} onClick={() => void setVote(place, voteDraft)}>{t.vote.retry}</button>
        ) : null}
      </div>
    );
  }

  function placeDetail(place: TripPlaceDto) {
    const available = placesById.has(place.id);
    const factsLabel = place.factsSource === "provider"
      ? place.providerAttribution ?? t.workspace.providerFacts
      : place.provider === "google"
        ? t.workspace.memberFactsWithGoogle
        : t.workspace.manualEntry;
    const duplicateSuggestions = duplicateSuggestionsByPlace.get(place.id) ?? [];
    return (
      <PlaceDetailContent
        tripId={trip.id}
        reference={{ kind: "trip-place", id: place.id }}
        request={request}
        collapsible
        interlude={<div className="pd-detail">
          <PlanningEditors key={place.id} trip={trip} place={place} available={available} request={request} changed={changedPlaces}
            editingChanged={(editing) => {
              if (editing) editingPlaceIds.current.add(place.id);
              else {
                editingPlaceIds.current.delete(place.id);
                setReadModel((current) => ({ ...current, retained: current.retained.filter((entry) => entry.id !== place.id) }));
              }
            }} />
          <section className="pd-detail-section">
            <h3>{t.workspace.placeAndSources}</h3>
            <p className="pd-detail-meta"><MapPin aria-hidden="true" className="size-4" /><span>{place.address ?? t.workspace.unknownAddress}</span></p>
            <p className="mt-1 text-sm text-muted-foreground">{t.workspace.factsSource(factsLabel)}{place.aiProposalId ? `・${t.workspace.aiProposal}` : ""}</p>
            {place.providerObservedAt ? <p className="mt-1 text-sm text-muted-foreground">{t.workspace.providerObserved(new Date(place.providerObservedAt).toLocaleString(locale))}{place.providerFactsExpired ? `・${t.workspace.expiredFacts}` : ""}</p> : null}
            <div className="pd-source-links mt-3">
              {place.provider === "google" && place.providerPlaceId ? <a className="pd-secondary" href={googleMapsPlaceUrl(place.name, place.providerPlaceId)} target="_blank" rel="noreferrer"><Images aria-hidden="true" className="size-4" />{t.workspace.viewPhotos}</a> : null}
              {place.sourceUrl ? <a className="inline-flex min-h-11 items-center break-all text-sm font-bold text-accent-strong underline underline-offset-2" href={place.sourceUrl} rel="noreferrer" target="_blank">{t.workspace.openOriginalSource}</a> : null}
            </div>
          </section>
          {available && place.votingAvailable ? <section className="pd-detail-section"><VoteVoters voters={place.voters} /></section> : null}
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
                      <span className="text-xs font-bold text-muted-foreground">{label}</span>
                      {candidate ? (
                        <>
                          <h5 className="text-xl font-semibold">{candidate.name}</h5>
                          <p className="text-sm">{t.placeType[candidate.type]}・{candidate.address ?? t.workspace.unknownAddress}</p>
                          <p className="mt-1 text-sm text-muted-foreground">{candidate.factsSource === "provider" ? t.duplicates.providerFacts : t.duplicates.memberFacts}</p>
                          {candidate.notes ? <p className="mt-1 whitespace-pre-wrap break-words text-sm">{candidate.notes}</p> : null}
                          {candidate.sourceUrl ? <a className="mt-1 block break-all text-sm underline underline-offset-2" href={candidate.sourceUrl} rel="noreferrer" target="_blank">{t.workspace.openOriginalSource}</a> : null}
                        </>
                      ) : <p className="mt-1 text-sm text-muted-foreground">{t.duplicates.unavailable}</p>}
                    </section>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button className="min-h-11 rounded-lg bg-accent px-3 font-bold text-ink-strong outline-none hover:bg-accent/80 focus:ring-4 focus:ring-focus/30 disabled:opacity-60" disabled={!other} onClick={() => {
                    if (other) setMergeConfirmation({ source: place, target: other });
                  }}>{t.duplicates.merge}</button>
                  <button className="min-h-11 rounded-lg border px-3 font-bold outline-none hover:bg-surface-subtle focus:ring-4 focus:ring-focus/30" onClick={() => void keepSeparate(suggestion.id)}>{t.duplicates.keepSeparate}</button>
                </div>
              </section>
            );
          }) : null}
        </div>}
      />
    );
  }

  return (
    <section className="pd-workspace" aria-labelledby="shared-wishlist-heading">
      <div className="pd-pagehead">
        <h2 id="shared-wishlist-heading">{appText.placesSegments.wishlist}</h2>
        <button className="pd-primary" onClick={() => setAdding(true)}><Plus aria-hidden="true" className="size-4" />{t.workspace.addPlace}</button>
      </div>
      {readError ? <div className="pd-notice pd-read-error" role="alert"><p>{readError}</p><button type="button" className="pd-secondary" disabled={loading} onClick={() => void load()}>{t.workspace.reload}</button></div> : null}
      {message ? <p className="pd-notice" role="alert">{message}</p> : null}
      {loading && places.length === 0 ? <p className="pd-subhead" role="status">{t.workspace.loading}</p> : null}
      {!loading && !readError && places.length === 0 && readModel.retained.length === 0 ? (
        <section className="pd-empty">
          <div>
            <span className="pd-empty-icon"><MapPin aria-hidden="true" className="size-6" /></span>
            <h3>{t.workspace.emptyTitle}</h3>
            <p>{t.workspace.emptyDescription}</p>
            <p className="pd-empty-ai">{t.workspace.emptyAiPrefix}<a href={`?trip=${encodeURIComponent(trip.id)}&tab=places&segment=discovery`}>{t.workspace.emptyAiLink}</a>{t.workspace.emptyAiSuffix}</p>
            <button type="button" className="pd-primary" onClick={() => setAdding(true)}><Plus aria-hidden="true" className="size-4" />{t.workspace.addFirstPlace}</button>
          </div>
        </section>
      ) : null}
      {listedPlaces.length > 0 ? (
        <div className="pd-list" aria-label={t.workspace.tableLabel}>
          {listedPlaces.map((place) => {
            const available = placesById.has(place.id);
            const assignedDate = place.assignedDayId ? trip.days.find((day) => day.id === place.assignedDayId)?.date ?? t.workspace.unavailableTripDay : null;
            const plannedLabel = assignedDate ?? (place.status === "scheduled"
              ? t.status.scheduled
              : place.selectedForItinerary
                ? t.workspace.pendingArrangement
                : t.workspace.notPlanned);
            const duplicates = duplicateSuggestionsByPlace.get(place.id) ?? [];
            const actionStatus = duplicates.length > 0 ? "possible-duplicate" : place.status;
            const needsAction = actionStatus === "needs-location" || actionStatus === "possible-duplicate" || actionStatus === "provider-unavailable";
            const repeatedName = (placeNameCounts.get(place.name) ?? 0) > 1;
            return (
              <article key={place.id} data-wishlist-place={place.name} className="pd-row"
                aria-label={repeatedName ? t.workspace.placeAtAddress(place.name, place.address ?? t.workspace.unknownAddress) : place.name}
                aria-current={selectedPlaceId === place.id ? "true" : undefined}
                onClick={(event) => {
                  if (event.target instanceof Element && event.target.closest("button, a, input, textarea, select")) return;
                  openDetail(place.id);
                }}>
                <div className="pd-row-main">
                  <PlaceThumbnail photo={previews.photos.get(place.id)} loading={previews.loading} />
                  <div className="pd-row-copy">
                    <div className="pd-titleline">
                      <button type="button" data-place-detail-trigger={place.id} className="pd-titlebutton" aria-label={t.workspace.viewDetail(place.name)} onClick={() => openDetail(place.id)}>{place.name}</button>
                      <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
                    </div>
                    <div className="pd-row-labels">
                      <span className="pd-chip">{t.placeType[place.type]}</span>
                      <span className="pd-state">{itineraryMembershipLabel(place, t)}</span>
                      {available && needsAction ? <span className="pd-state"><StatusIcon status={actionStatus} />{statusLabel(actionStatus, t)}</span> : null}
                    </div>
                    {repeatedName ? <p className="pd-row-note">{place.address ?? t.workspace.unknownAddress}</p> : null}
                    <p className={`pd-row-note${place.notes ? "" : " pd-muted"}`}>{place.notes ?? t.workspace.noReason}</p>
                    <PlacePhotoCredit photo={previews.photos.get(place.id)} />
                  </div>
                </div>
                <div className="pd-row-bottom">
                  <span className="pd-state">{available ? plannedLabel : null}</span>
                  {quickActions(place)}
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
      {selectedPlace ? (
        <PlaceDetailSheet
          open
          appearance="workspace"
          title={selectedPlace.name}
          description={<div className="pd-detail-badges"><span className="pd-chip">{t.placeType[selectedPlace.type]}</span><span className="pd-state">{itineraryMembershipLabel(selectedPlace, t)}</span>{selectedPlace.status !== "ready" ? <span className="pd-state"><StatusIcon status={selectedPlace.status} />{statusLabel(selectedPlace.status, t)}</span> : null}</div>}
          titleRef={detailTitleRef}
          onClose={closeDetail}
          footer={
          removalConfirmation ? <div className="pd-confirm-footer"><p>{t.workspace.confirmRemove(removalConfirmation.name)}</p>{message ? <p role="alert">{message}</p> : null}<div><button className="pd-secondary" disabled={removing} onClick={() => setRemovalConfirmation(null)}>保留地點</button><button className="pd-danger-button" disabled={removing} onClick={() => void remove(removalConfirmation)}>{removing ? "移除中…" : t.workspace.remove}</button></div></div>
          : <div>{message ? <p className="pd-notice" role="alert">{message}</p> : null}<div className="pd-fixed-actions">{quickActions(selectedPlace)}{placesById.has(selectedPlace.id) ? <button className="pd-danger-link" disabled={removing} onClick={() => { setMessage(""); setRemovalConfirmation(selectedPlace); }}>{t.workspace.remove}</button> : null}</div></div>
        }>
          {placeDetail(selectedPlace)}
        </PlaceDetailSheet>
      ) : null}

      <Dialog open={mergeConfirmation !== null} onOpenChange={(open) => { if (!open && !merging) setMergeConfirmation(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{mergeConfirmation ? t.duplicates.confirmTitle(mergeConfirmation.source.name, mergeConfirmation.target.name) : ""}</DialogTitle>
            <DialogDescription>{t.duplicates.confirmDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button type="button" className="min-h-11 rounded-lg bg-accent px-4 font-bold text-ink-strong outline-none hover:bg-accent/80 focus:ring-4 focus:ring-focus/30 disabled:opacity-60" disabled={merging} onClick={() => {
              if (mergeConfirmation) void merge(mergeConfirmation.source, mergeConfirmation.target);
            }}>{t.duplicates.confirm}</button>
            <button type="button" className="min-h-11 rounded-lg border px-4 font-bold outline-none hover:bg-surface-subtle focus:ring-4 focus:ring-focus/30 disabled:opacity-60" disabled={merging} onClick={() => setMergeConfirmation(null)}>{t.duplicates.cancel}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {adding ? <AddPlacePanel tripId={trip.id} request={request} close={() => setAdding(false)} changed={changedPlaces} /> : null}
    </section>
  );
}
