import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarCheck,
  CalendarClock,
  CalendarPlus,
  Check,
  CircleAlert,
  CircleCheck,
  CloudOff,
  Images,
  LoaderCircle,
  MapPin,
  MapPinOff,
  Pencil,
  Plus,
  X,
} from "lucide-react";

import type { TripDto } from "@along-the-way/contracts/private-trips";
import {
  parseProviderCandidatesResponse,
  parseTripPlaceListResponse,
  parseTripPlaceResponse,
  type ProviderPlaceCandidateDto,
  type ProviderPlaceSearchResultDto,
  type TripPlaceDto,
  type UpdateTripPlacePlanningInput,
} from "@along-the-way/contracts/trip-places";
import { ConflictPanel, useVersionConflict, type EditSnapshot } from "./ConflictPanel";
import { ApiRequestError } from "./api-error";
import type { PlaceType } from "@along-the-way/contracts/trip-skeleton";

import { googleMapsPlaceUrl } from "./google-maps";
import { useI18n, type Messages } from "./i18n";
import { VoteControl, VoteVoters } from "./VoteControl";
import { PlaceDetailContent } from "./PlaceDetailContent";
import { PlacePhotoCredit, PlaceThumbnail, usePlacePreviews } from "./PlaceThumbnail";
import { PlaceListRow } from "./PlaceListRow";
import { PlaceDetailSheet } from "./PlaceDetailSheet";
import { PlaceMustItems, type PlaceMustItemsHandle } from "./PlaceMustItems";
import { NativeSelect } from "./components/ui/native-select";
import { SchedulePlacesSheet } from "./SchedulePlacesSheet";
import { SelectionBar } from "./SelectionBar";
import { useScheduleToast } from "./ScheduleToast";
import { assignPlacesToDay } from "./schedule-assignments";
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


interface ScheduleContext {
  placeIds: string[];
}

function formatScheduleDate(date: string, locale: string) {
  const instant = new Date(`${date}T12:00:00Z`);
  const calendarDate = new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  }).format(instant);
  const weekday = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    timeZone: "UTC",
  }).format(instant);
  return `${calendarDate}（${weekday}）`;
}

function canSelectForSchedule(place: TripPlaceDto, available: boolean) {
  return available
    && place.latitude !== null
    && place.longitude !== null
    && !place.scheduled
    && place.assignedDayId === null;
}

function isScheduledForRemovalPolicy(place: TripPlaceDto) {
  return place.scheduled || place.selectedForItinerary || place.assignedDayId !== null;
}
interface TripPlaceWorkspaceProps {
  trip: TripDto;
  request<T>(url: string, options?: RequestOptions): Promise<T>;
  placesRevision: number;
  onPlacesChanged(): void;
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
  if (!(error instanceof ApiRequestError)) return fallback;
  if (error.code === "provider_unavailable") {
    return "Google 地點服務暫時無法使用，請稍後再試或改用手動輸入。";
  }
  if (error.code === "rate_limited") return "操作太頻繁，請稍後再試。";
  if (error.code === "conflict") return "旅程資料已更新，請重新載入後再試。";
  if (error.code === "voting_unavailable") return "至少需要兩位旅程成員才能投票。";
  return fallback;
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
  const { t: { tripPlaces: t } } = useI18n();
  const [mode, setMode] = useState<"url" | "search" | "manual">("search");
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [manualDraft, setManualDraft] = useState<ManualPlaceDraft>(emptyManualPlaceDraft);
  const [coordinateError, setCoordinateError] = useState("");
  const [candidates, setCandidates] = useState<ProviderPlaceSearchResultDto[]>([]);
  const [attribution, setAttribution] = useState("");
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const [resultCount, setResultCount] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingProviderPlaceId, setPendingProviderPlaceId] = useState<string | null>(null);
  const retryKeys = useRef<RetryKeys>(new Map());

  async function discover(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setCandidates([]);
    setAttribution("");
    setResolvedUrl(null);
    setResultCount(null);
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
      setResultCount(parsed.candidates.length);
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
    setPendingProviderPlaceId(candidate.providerPlaceId);
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
      setMessage(error instanceof ApiRequestError && error.code === "already_in_wishlist"
        ? t.errors.alreadyInWishlist
        : t.errors.selectionPreserved(errorMessage(error, t.errors.requestFailed)));
    } finally {
      setBusy(false);
      setPendingProviderPlaceId(null);
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

  const pendingCandidateName = candidates.find((candidate) => candidate.providerPlaceId === pendingProviderPlaceId)?.name ?? null;

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
              setAttribution("");
              setResolvedUrl(null);
              setResultCount(null);
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
          <div className="pd-field">
            <label htmlFor="add-place-note">{t.add.originalNote}<textarea id="add-place-note" name="originalNote" value={note} maxLength={200} rows={2} placeholder={t.add.reasonPlaceholder} aria-describedby="add-place-note-help" onChange={(event) => setNote(event.target.value)} /></label>
            <span id="add-place-note-help" className="pd-field-help">{t.add.reasonHelp}</span>
          </div>
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
          <div className="pd-field">
            <label htmlFor="add-place-note">{t.add.originalNote}<textarea id="add-place-note" value={note} maxLength={200} rows={2} placeholder={t.add.reasonPlaceholder} aria-describedby="add-place-note-help" onChange={(event) => setNote(event.target.value)} /></label>
            <span id="add-place-note-help" className="pd-field-help">{t.add.reasonHelp}</span>
          </div>
          <button className="pd-primary" disabled={busy}>{busy ? t.add.checking : mode === "url" ? t.add.resolveLink : t.add.searchPlaces}</button>
        </form>
      )}
      {resultCount !== null ? <p className="pd-result-status" role="status" aria-live="polite">{t.add.resultCount(resultCount)}</p> : null}

      {candidates.length > 0 ? (
        <section className="mt-5" aria-labelledby="provider-candidates">
          <h3 id="provider-candidates" className="pd-section-title">{t.add.confirmTitle}</h3>
          {resolvedUrl ? <p className="pd-add-intro break-all">{t.add.resolvedTo(resolvedUrl)}</p> : null}
          <p className="pd-add-intro">{t.add.resultsProvidedBy(attribution)}</p>
          <ul className="pd-result-list">
            {candidates.map((candidate) => {
              const isPending = pendingProviderPlaceId === candidate.providerPlaceId;
              return (
                <li key={candidate.providerPlaceId}>
                  <PlaceThumbnail photo={candidate.photo} />
                  <span className="pd-result-copy">
                    <span className="pd-result-title"><strong>{candidate.name}</strong>{candidate.typeLabel ? <span className="pd-result-type">· {candidate.typeLabel}</span> : null}</span>
                    <small>{candidate.address ?? t.add.addressUnavailable}</small>
                    <PlacePhotoCredit photo={candidate.photo} />
                  </span>
                  <button
                    type="button"
                    className="pd-primary pd-accent"
                    disabled={busy || candidate.alreadyInWishlist}
                    aria-busy={isPending || undefined}
                    aria-label={candidate.alreadyInWishlist
                      ? t.add.alreadyInWishlistCandidate(candidate.name, candidate.typeLabel)
                      : t.add.addCandidate(candidate.name, candidate.typeLabel)}
                    onClick={() => void confirm(candidate)}
                  >
                    {candidate.alreadyInWishlist ? t.add.alreadyInWishlist : isPending ? (
                      <>
                        <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
                        {t.add.adding}
                      </>
                    ) : t.add.addThisPlace}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {message ? <p className="pd-notice mt-4" role="alert">{message}</p> : null}
      {/* The pressed button keeps its place name as accessible name, so progress is announced here. */}
      <p className="sr-only" role="status" aria-atomic="true">
        {pendingCandidateName ? t.add.addingCandidate(pendingCandidateName) : ""}
      </p>
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

function PlanningEditors({ tripId, place, available, request, changed, editingChanged }: {
  tripId: string;
  place: TripPlaceDto;
  available: boolean;
  request: TripPlaceWorkspaceProps["request"];
  changed(): Promise<void>;
  editingChanged(editing: boolean): void;
}) {
  const { t: { tripPlaces: t } } = useI18n();
  const [base, setBase] = useState<EditSnapshot<PlanningInput>>({ input: planningValues(place), version: place.version });
  const [draft, setDraft] = useState(base.input);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const resolution = useVersionConflict<PlanningInput>();
  const retryKeys = useRef<RetryKeys>(new Map());

  useEffect(() => {
    if (!editing && !resolution.conflict && place.version > base.version) {
      const snapshot = { input: planningValues(place), version: place.version };
      setBase(snapshot);
      setDraft(snapshot.input);
    }
  }, [place, editing, resolution.conflict, base.version]);

  function finish(next: EditSnapshot<PlanningInput>) {
    setBase(next);
    setDraft(next.input);
    setEditing(false);
    setMessage("");
    resolution.clear();
    editingChanged(false);
  }

  async function save(attempted?: PlanningInput, version = base.version, conflictBase = resolution.conflictBaseVersion) {
    const normalized = attempted ?? { ...base.input, notes: draft.notes?.trim() || null };
    const operation = `planning:${place.id}`;
    const payload = { ...normalized, expectedVersion: version };
    setMessage("");
    setBusy(true);
    try {
      const response = await request<{ tripPlace: TripPlaceDto }>(`/api/trips/${tripId}/trip-places/${place.id}/planning`, {
        method: "PATCH",
        headers: { "Idempotency-Key": retryKey(retryKeys.current, operation, payload), ...(conflictBase ? { "Conflict-Base-Version": String(conflictBase) } : {}) },
        body: JSON.stringify(payload),
        parse: parseTripPlaceResponse,
      });
      clearRetryKey(retryKeys.current, operation);
      finish({ input: planningValues(response.tripPlace), version: response.tripPlace.version });
      await changed();
    } catch (error) {
      try {
        if (error instanceof ApiRequestError && error.code === "trip_place_not_found") {
          editingChanged(true);
          await changed();
          return;
        }
        if (await resolution.capture(error, base, normalized, async () => {
          const latest = parseTripPlaceListResponse(await request(`/api/trips/${tripId}/trip-places`)).tripPlaces.find((entry) => entry.id === place.id);
          return latest ? { input: planningValues(latest), version: latest.version } : null;
        })) {
          editingChanged(true);
          return;
        }
        setMessage(t.errors.editsPreserved(errorMessage(error, t.errors.requestFailed)));
      } catch (reason) {
        setMessage(t.errors.editsPreserved(errorMessage(reason, t.errors.requestFailed)));
      }
    } finally {
      setBusy(false);
    }
  }

  const conflict = available ? resolution.conflict : {
    base,
    current: null,
    attempted: draft,
    latestChange: null,
  };
  return (
    <section className="pd-detail-section">
      <div className="pd-reason-head">
        <h3>{t.workspace.reasonTitle}</h3>
        {available && !editing && !conflict ? <button type="button" className="pd-reason-action" onClick={() => {
          const snapshot = { input: planningValues(place), version: place.version };
          setBase(snapshot);
          setDraft(snapshot.input);
          setEditing(true);
          editingChanged(true);
        }}><Pencil aria-hidden="true" className="size-4" />{base.input.notes ? t.workspace.editReason : t.workspace.addReason}</button> : null}
      </div>
      {conflict ? <ConflictPanel
        conflict={conflict}
        busy={busy}
        onAccept={() => {
          if (!conflict.current) {
            setEditing(false);
            resolution.clear();
            setMessage("");
            editingChanged(false);
            void changed();
            return;
          }
          finish(conflict.current);
          void changed();
        }}
        onReapply={() => void save(conflict.attempted, conflict.current!.version, conflict.base.version)}
        onEdit={() => {
          const current = conflict.current!;
          setBase(current);
          setDraft({ ...current.input, notes: conflict.attempted.notes });
          resolution.resume();
          setEditing(true);
          setMessage("");
        }}
      /> : editing ? (
        <form className="pd-reason-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <textarea value={draft.notes ?? ""} maxLength={200} rows={3} placeholder={t.add.reasonPlaceholder} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
          <p className="pd-field-help">{t.add.reasonHelp}</p>
          <div className="pd-reason-actions">
            <button type="button" className="pd-secondary" disabled={busy} onClick={() => {
              setDraft(base.input);
              setEditing(false);
              editingChanged(false);
              setMessage("");
            }}>{t.workspace.cancelReason}</button>
            <button type="submit" className="pd-primary" disabled={busy}><CircleCheck aria-hidden="true" className="size-4" />{busy ? t.workspace.savingReason : t.workspace.saveReason}</button>
          </div>
        </form>
      ) : <p className={base.input.notes ? "pd-reason-copy" : "pd-reason-copy pd-muted"}>{base.input.notes ?? t.workspace.noReasonDetail}</p>}
      {message ? <p className="pd-notice mt-3" role="alert">{message}</p> : null}
    </section>
  );
}


export function TripPlaceWorkspace({
  trip,
  request,
  placesRevision,
  onPlacesChanged,
}: TripPlaceWorkspaceProps) {
  const { locale, t: { tripPlaces: t, app: appText, schedule } } = useI18n();
  const { toast, show: showScheduleToast } = useScheduleToast();
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
  const [selecting, setSelecting] = useState(false);
  const [selectedPlaceIds, setSelectedPlaceIds] = useState<Set<string>>(() => new Set());
  const [scheduleContext, setScheduleContext] = useState<ScheduleContext | null>(null);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleError, setScheduleError] = useState("");
  const [highlightedPlaceIds, setHighlightedPlaceIds] = useState<Set<string>>(() => new Set());
  const detailTitleRef = useRef<HTMLHeadingElement>(null);
  const detailReturnPosition = useRef<{ x: number; y: number } | null>(null);
  const mustItemsRef = useRef<PlaceMustItemsHandle>(null);
  const [mergeConfirmation, setMergeConfirmation] = useState<{ source: TripPlaceDto; target: TripPlaceDto } | null>(null);
  const [merging, setMerging] = useState(false);
  const [removalConfirmation, setRemovalConfirmation] = useState<TripPlaceDto | null>(null);
  const [removing, setRemoving] = useState(false);

  const canSchedule = trip.role === "owner";

  useEffect(() => {
    if (canSchedule) return;
    setSelecting(false);
    setSelectedPlaceIds(new Set());
    setScheduleContext(null);
    setScheduleBusy(false);
    setRemovalConfirmation(null);
    setScheduleError("");
  }, [canSchedule]);

  function openDetail(placeId: string) {
    if (placeId === selectedPlaceId) {
      window.requestAnimationFrame(() => detailTitleRef.current?.focus());
      return;
    }
    detailReturnPosition.current = { x: window.scrollX, y: window.scrollY };
    setSelectedPlaceId(placeId);
  }

  function startSelection() {
    if (!canSchedule) return;
    setSelectedPlaceIds(new Set());
    setSelecting(true);
  }

  function cancelSelection() {
    setSelectedPlaceIds(new Set());
    setSelecting(false);
  }

  function openScheduleForPlace(place: TripPlaceDto) {
    if (!canSchedule) return;
    setScheduleError("");
    setRemovalConfirmation(null);
    setSelectedPlaceId(null);
    setScheduleContext({ placeIds: [place.id] });
  }

  function closeSchedule() {
    const returnToSelection = selecting;
    const returnPlaceId = scheduleContext?.placeIds.length === 1 ? scheduleContext.placeIds[0] : null;
    setScheduleError("");
    setScheduleContext(null);
    window.requestAnimationFrame(() => {
      const target = returnToSelection
        ? document.querySelector<HTMLElement>(".schedule-selection-bar .schedule-primary-button")
        : returnPlaceId
          ? document.querySelector<HTMLElement>(`[data-place-detail-trigger="${returnPlaceId}"]`)
          : null;
      target?.focus({ preventScroll: true });
    });
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

  useEffect(() => {
    const deepLinkedPlaceId = new URLSearchParams(window.location.search).get("place");
    if (!deepLinkedPlaceId || selectedPlaceId || !readModel.current.some((place) => place.id === deepLinkedPlaceId)) return;
    setSelectedPlaceId(deepLinkedPlaceId);
  }, [readModel.current, selectedPlaceId]);

  useEffect(() => {
    if (highlightedPlaceIds.size === 0) return;
    const timer = window.setTimeout(() => setHighlightedPlaceIds(new Set()), 1_400);
    return () => window.clearTimeout(timer);
  }, [highlightedPlaceIds]);

  function closeDetail() {
    const placeId = selectedPlaceId;
    const position = detailReturnPosition.current;
    detailReturnPosition.current = null;
    setSelectedPlaceId(null);
    setRemovalConfirmation(null);
    const url = new URL(window.location.href);
    if (placeId && url.searchParams.get("place") === placeId) {
      url.searchParams.delete("place");
      window.history.replaceState({}, "", url);
    }
    if (placeId) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-place-detail-trigger="${placeId}"]`)?.focus({ preventScroll: true });
        if (position) window.scrollTo({ left: position.x, top: position.y, behavior: "instant" });
      });
    }
  }

  function requestCloseDetail() {
    if (mustItemsRef.current && !mustItemsRef.current.requestClose(closeDetail)) return;
    closeDetail();
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
    if (removing || (!canSchedule && isScheduledForRemovalPolicy(place))) return;
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
      setMessage(error instanceof ApiRequestError && (error.code === "forbidden" || error.status === 403)
        ? schedule.ownerOnlyAction
        : errorMessage(error, t.errors.requestFailed));
    } finally {
      setRemoving(false);
    }
  }

  async function merge(source: TripPlaceDto, target: TripPlaceDto) {
    if (!canSchedule && (isScheduledForRemovalPolicy(source) || isScheduledForRemovalPolicy(target))) {
      setMessage(schedule.ownerOnlyAction);
      return;
    }

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
      setMessage(error instanceof ApiRequestError && (error.code === "forbidden" || error.status === 403)
        ? schedule.ownerOnlyAction
        : errorMessage(error, t.errors.requestFailed));
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
  const schedulePlaces = scheduleContext
    ? scheduleContext.placeIds.flatMap((placeId) => {
        const place = listedPlaces.find((entry) => entry.id === placeId);
        return place ? [place] : [];
      })
    : [];
  const scheduledPlace = schedulePlaces.length === 1 ? schedulePlaces[0]! : null;
  const missingLocationCount = listedPlaces.filter((place) => place.latitude === null || place.longitude === null).length;
  const hasSchedulablePlaces = canSchedule && listedPlaces.some((place) => canSelectForSchedule(place, placesById.has(place.id)));
  const previews = usePlacePreviews({
    tripId: trip.id,
    kind: "trip-place",
    ids: listedPlaces.map((place) => place.id),
    request,
  });

  function dayLabel(dayId: string | null) {
    if (!dayId) return null;
    const day = trip.days.find((entry) => entry.id === dayId);
    return day ? formatScheduleDate(day.date, locale) : t.workspace.unavailableTripDay;
  }

  function togglePlaceSelection(place: TripPlaceDto) {
    if (!canSchedule || !canSelectForSchedule(place, placesById.has(place.id))) return;
    setSelectedPlaceIds((current) => {
      const next = new Set(current);
      if (next.has(place.id)) next.delete(place.id);
      else next.add(place.id);
      return next;
    });
  }

  function openSelectionSchedule() {
    if (!canSchedule || selectedPlaceIds.size === 0) return;
    setScheduleError("");
    setScheduleContext({ placeIds: [...selectedPlaceIds] });
  }

  async function confirmSchedule(dayId: string | null) {
    if (!canSchedule || scheduleBusy || schedulePlaces.length === 0) return;
    setScheduleBusy(true);
    setScheduleError("");
    try {
      const response = await assignPlacesToDay({
        request,
        tripId: trip.id,
        dayId,
        items: schedulePlaces.map((place) => ({
          tripPlaceId: place.id,
          version: place.version,
          currentDayId: place.assignedDayId,
        })),
      });
      ++readGeneration.current;
      const currentIds = new Set(response.tripPlaces.map((place) => place.id));
      setReadModel((previous) => ({
        current: response.tripPlaces,
        retained: previous.retained.filter((place) => editingPlaceIds.current.has(place.id) && !currentIds.has(place.id)),
      }));
      setHighlightedPlaceIds(new Set(schedulePlaces.map((place) => place.id)));
      setSelectedPlaceIds(new Set());
      setSelecting(false);
      setScheduleContext(null);
      onPlacesChanged();
      if (dayId) {
        const day = trip.days.find((entry) => entry.id === dayId);
        const label = day ? formatScheduleDate(day.date, locale) : t.workspace.unavailableTripDay;
        showScheduleToast(schedule.toastScheduled(schedulePlaces.length, label), day ? {
          label: schedule.viewItinerary,
          href: `?trip=${encodeURIComponent(trip.id)}&tab=itinerary&segment=daily&day=${encodeURIComponent(day.date)}`,
        } : undefined);
      } else if (scheduledPlace) {
        showScheduleToast(schedule.toastUnscheduled(scheduledPlace.name));
      }
    } catch (error) {
      setScheduleError(error instanceof ApiRequestError && (error.code === "forbidden" || error.status === 403)
        ? schedule.ownerOnlyAction
        : errorMessage(error, t.errors.requestFailed));
      try {
        await refreshPlaces();
      } catch {
        // Keep the assignment error visible in the schedule sheet.
      }
    } finally {
      setScheduleBusy(false);
    }
  }

  function voteActions(place: TripPlaceDto) {
    if (!placesById.has(place.id)) return null;
    const voteDraft = voteDrafts[place.id];
    return <>
      <VoteControl compact name={place.name} voters={place.voters} voteCount={place.voteCount} ownVote={place.ownVote} votingAvailable={place.votingAvailable} disabled={Boolean(pendingVotes[place.id])} onChange={(voted) => void setVote(place, voted)} />
      {failedVotes[place.id] && voteDraft !== undefined ? (
        <button className="pd-secondary" disabled={pendingVotes[place.id]} onClick={() => void setVote(place, voteDraft)}>{t.vote.retry}</button>
      ) : null}
    </>;
  }
  function placeDetail(place: TripPlaceDto) {
    const available = placesById.has(place.id);
    const manageLocationHref = `?${new URLSearchParams({ trip: trip.id, tab: "itinerary", segment: "daily", manage: "places" })}`;
    const duplicateSuggestions = duplicateSuggestionsByPlace.get(place.id) ?? [];
    return (
      <PlaceDetailContent
        tripId={trip.id}
        reference={{ kind: "trip-place", id: place.id }}
        request={request}
        collapsible
        disclosureLabel="旅遊資訊與資料來源"
        interlude={<div className="pd-detail">
          <PlanningEditors key={place.id} tripId={trip.id} place={place} available={available} request={request} changed={changedPlaces}
            editingChanged={(editing) => {
              if (editing) editingPlaceIds.current.add(place.id);
              else {
                editingPlaceIds.current.delete(place.id);
                setReadModel((current) => ({ ...current, retained: current.retained.filter((entry) => entry.id !== place.id) }));
              }
            }} />
          <PlaceMustItems
            ref={mustItemsRef}
            tripId={trip.id}
            tripPlaceId={place.id}
            request={request}
            editable={available}
            revision={placesRevision}
            onChanged={onPlacesChanged}
          />
          <section className="pd-detail-section">
            <h3>地點</h3>
            <p className="pd-detail-meta"><MapPin aria-hidden="true" className="size-4" /><span>{place.address ?? t.workspace.unknownAddress}</span></p>
            {place.latitude === null || place.longitude === null ? <a className="pd-secondary mt-3" href={manageLocationHref}><MapPinOff aria-hidden="true" className="size-4" />{schedule.addLocation}</a> : null}
            <div className="pd-source-links mt-3">
              {place.provider === "google" && place.providerPlaceId ? <a className="pd-secondary" href={googleMapsPlaceUrl(place.name, place.providerPlaceId)} target="_blank" rel="noreferrer"><Images aria-hidden="true" className="size-4" />{t.workspace.viewPhotos}</a> : null}
              {place.sourceUrl ? <a className="inline-flex min-h-11 items-center break-all text-sm font-bold text-accent-strong underline underline-offset-2" href={place.sourceUrl} rel="noreferrer" target="_blank">{t.workspace.openOriginalSource}</a> : null}
            </div>
          </section>
          {available && place.votingAvailable ? <section className="pd-detail-section"><VoteVoters voters={place.voters} /></section> : null}
          {available ? duplicateSuggestions.map((suggestion) => {
            const other = placesById.get(suggestion.otherTripPlaceId);
            const mergeIsOwnerOnly = isScheduledForRemovalPolicy(place) || Boolean(other && isScheduledForRemovalPolicy(other));
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
                  {canSchedule || !mergeIsOwnerOnly ? <button className="min-h-11 rounded-lg bg-accent px-3 font-bold text-ink-strong outline-none hover:bg-accent/80 focus:ring-4 focus:ring-focus/30 disabled:opacity-60" disabled={!other} onClick={() => {
                    if (other) setMergeConfirmation({ source: place, target: other });
                  }}>{t.duplicates.merge}</button> : null}
                  <button className="min-h-11 rounded-lg border px-3 font-bold outline-none hover:bg-surface-subtle focus:ring-4 focus:ring-focus/30" onClick={() => void keepSeparate(suggestion.id)}>{t.duplicates.keepSeparate}</button>
                </div>
              </section>
            );
          }) : null}
        </div>}
      />
    );
  }

  function selectionCheckbox(place: TripPlaceDto) {
    const eligible = canSelectForSchedule(place, placesById.has(place.id));
    const selected = selectedPlaceIds.has(place.id);
    return (
      <button
        type="button"
        className="schedule-selection-check"
        role="checkbox"
        aria-checked={selected}
        aria-label={schedule.selectPlace(place.name)}
        disabled={!eligible}
        onClick={(event) => {
          event.stopPropagation();
          togglePlaceSelection(place);
        }}
      >
        <Check aria-hidden="true" />
      </button>
    );
  }

  function detailScheduleAction(place: TripPlaceDto) {
    if (!canSchedule || !placesById.has(place.id)) return null;
    if (place.latitude === null || place.longitude === null) {
      return (
        <a className="schedule-secondary-button" href={`?trip=${encodeURIComponent(trip.id)}&tab=itinerary&segment=daily&manage=places`}>
          <MapPin aria-hidden="true" />
          {schedule.addLocation}
        </a>
      );
    }
    if (place.scheduled) return null;
    return (
      <button type="button" className="schedule-primary-button" onClick={() => openScheduleForPlace(place)}>
        <CalendarPlus aria-hidden="true" />
        {place.assignedDayId ? schedule.changeDate : schedule.pageAction}
      </button>
    );
  }



  return (
    <section className="pd-workspace" data-selecting={selecting || undefined} aria-labelledby="shared-wishlist-heading">
      <div className={`pd-pagehead${selecting ? " pd-pagehead--selecting" : ""}`}>
        {selecting ? (
          <>
            <h2 id="shared-wishlist-heading" className="schedule-page-title">{schedule.selectedCount(selectedPlaceIds.size)}</h2>
            <button type="button" className="schedule-secondary-button" onClick={cancelSelection}>
              <X aria-hidden="true" />
              {schedule.cancel}
            </button>
          </>
        ) : (
          <>
            <div className="pd-pagehead-copy" data-compact-mobile={listedPlaces.length > 0 || undefined}>
              <h2 id="shared-wishlist-heading" className="schedule-page-title" aria-label={appText.placesSegments.wishlist}>
                <span className="pd-pagehead-title--full" aria-hidden="true">{appText.placesSegments.wishlist}</span>
                <span className="pd-pagehead-title--compact" aria-hidden="true">{t.workspace.compactTitle(listedPlaces.length)}</span>
              </h2>
              <p>{t.workspace.helper}</p>
            </div>
            <div className="schedule-head-buttons">
              {hasSchedulablePlaces ? (
                <button type="button" className="schedule-primary-button" onClick={startSelection}>
                  <CalendarPlus aria-hidden="true" />
                  {schedule.pageAction}
                </button>
              ) : null}
              <button type="button" className="schedule-secondary-button" onClick={() => setAdding(true)}>
                <Plus aria-hidden="true" />
                {t.workspace.addPlace}
              </button>
            </div>
          </>
        )}
      </div>
      {!canSchedule ? <p className="pd-subhead">{schedule.ownerOnly}</p> : null}
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
            const located = place.latitude !== null && place.longitude !== null;
            const scheduled = place.scheduled || place.assignedDayId !== null;
            const selected = selectedPlaceIds.has(place.id);
            const eligible = canSelectForSchedule(place, available);
            const repeatedName = (placeNameCounts.get(place.name) ?? 0) > 1;
            const preview = previews.previews.get(place.id);
            const status = !located ? (
              <span className="pd-schedule-meta pd-schedule-meta--missing"><MapPinOff aria-hidden="true" />{t.workspace.missingLocationForSchedule}</span>
            ) : scheduled ? (
              <span className="pd-schedule-meta schedule-status-pill"><CalendarCheck aria-hidden="true" />{place.assignedDayId ? schedule.scheduledOn(dayLabel(place.assignedDayId)!) : t.workspace.selectedPendingDate}</span>
            ) : (
              <span className="pd-schedule-meta"><CalendarClock aria-hidden="true" />{schedule.notScheduled}</span>
            );
            const state = selecting
              ? selected ? "selected" : eligible ? "selectable" : "selecting"
              : "default";
            return (
              <PlaceListRow
                key={place.id}
                variant="wishlist"
                name={place.name}
                typeLabel={t.placeType[place.type]}
                secondary={place.notes ? <span>{t.workspace.reason(place.notes)}</span> : undefined}
                status={status}
                photo={preview?.photo}
                photoCount={preview?.photoCount ?? 0}
                loadingPhoto={previews.loading}
                photoCredit={preview?.photo ? <PlacePhotoCredit photo={preview.photo} /> : undefined}
                voteAction={voteActions(place)}
                selectionControl={canSchedule && selecting ? selectionCheckbox(place) : undefined}
                ariaLabel={repeatedName ? t.workspace.placeAtAddress(place.name, place.address ?? t.workspace.unknownAddress) : place.name}
                current={!selecting && selectedPlaceId === place.id}
                state={state}
                scheduled={scheduled}
                changed={!selecting && highlightedPlaceIds.has(place.id)}
                onOpen={() => openDetail(place.id)}
                onActivate={() => {
                  if (selecting) {
                    if (eligible) togglePlaceSelection(place);
                  } else {
                    openDetail(place.id);
                  }
                }}
                openLabel={t.workspace.viewDetail(place.name)}
                openDataAttribute={{ name: "place-detail-trigger", value: place.id }}
                dataAttribute={{ name: "wishlist-place", value: place.name }}
              />
            );
          })}
        </div>
      ) : null}
      {selectedPlace ? (
        <PlaceDetailSheet
          open
          appearance="workspace"
          title={selectedPlace.name}
          description={<div className="pd-detail-badges">
            <span className="pd-chip">{t.placeType[selectedPlace.type]}</span>
            <span className="pd-state">{itineraryMembershipLabel(selectedPlace, t)}</span>
            {selectedPlace.latitude === null || selectedPlace.longitude === null
              ? <span className="pd-state"><MapPinOff aria-hidden="true" className="size-3.5" />{schedule.missingLocation}</span>
              : selectedPlace.assignedDayId
                ? <span className="schedule-status-pill"><CalendarCheck aria-hidden="true" />{schedule.scheduledOn(dayLabel(selectedPlace.assignedDayId)!)}</span>
                : selectedPlace.scheduled
                  ? <span className="schedule-status-pill"><CalendarCheck aria-hidden="true" />{t.status.scheduled}</span>
                  : <span className="pd-state"><CalendarClock aria-hidden="true" className="size-3.5" />{schedule.notScheduled}</span>}
            {selectedPlace.status === "possible-duplicate"
              ? <span className="pd-state"><CircleAlert aria-hidden="true" className="size-3.5" />{t.status.possibleDuplicate}</span>
              : selectedPlace.status === "provider-unavailable"
                ? <span className="pd-state"><CloudOff aria-hidden="true" className="size-3.5" />{t.status.providerUnavailable}</span>
                : null}
          </div>}
          titleRef={detailTitleRef}
          onClose={requestCloseDetail}
          footer={
          removalConfirmation ? <div className="pd-confirm-footer"><p>{t.workspace.confirmRemove(removalConfirmation.name)}</p>{message ? <p role="alert">{message}</p> : null}<div><button className="pd-secondary" disabled={removing} onClick={() => setRemovalConfirmation(null)}>保留地點</button><button className="pd-danger-button" disabled={removing} onClick={() => void remove(removalConfirmation)}>{removing ? "移除中…" : t.workspace.remove}</button></div></div>
          : <div>{message ? <p className="pd-notice" role="alert">{message}</p> : null}<div className="pd-fixed-actions">{detailScheduleAction(selectedPlace)}{voteActions(selectedPlace)}{placesById.has(selectedPlace.id) && (canSchedule || !isScheduledForRemovalPolicy(selectedPlace)) ? <button className="pd-danger-link" disabled={removing} onClick={() => { setMessage(""); setRemovalConfirmation(selectedPlace); }}>{t.workspace.remove}</button> : null}</div></div>
        }>
          {placeDetail(selectedPlace)}
        </PlaceDetailSheet>
      ) : null}
      {canSchedule ? (
        <>
          <SchedulePlacesSheet
            open={scheduleContext !== null}
            trip={trip}
            places={schedulePlaces.map((place) => ({ id: place.id, name: place.name }))}
            initialDayId={scheduledPlace?.assignedDayId}
            allowUnscheduled={Boolean(scheduledPlace?.assignedDayId)}
            busy={scheduleBusy}
            error={scheduleError}
            onConfirm={confirmSchedule}
            onClose={closeSchedule}
          />
          <SelectionBar
            count={selectedPlaceIds.size}
            hint={missingLocationCount > 0 ? schedule.missingLocationHint(missingLocationCount) : undefined}
            actionLabel={schedule.chooseDate}
            onAction={openSelectionSchedule}
            visible={selecting}
          />
        </>
      ) : null}
      {toast}

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
