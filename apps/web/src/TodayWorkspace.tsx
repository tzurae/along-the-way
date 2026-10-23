import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, BedDouble, BellRing, CalendarDays, ChevronRight, CircleDot, Clock3, ExternalLink, GitFork, ImageOff, ListOrdered, LoaderCircle, Lock, MapPin, Navigation, Plane, Sparkles, TriangleAlert, Users, WifiOff } from "lucide-react";
import {
  parseNearbyActivitiesResponse,
  parseNearbyAlternativesResponse,
  parseTripPlaceListResponse,
  type NearbyActivitiesResponse,
  type NearbyAlternativeDto,
  type NearbyAlternativesResponse,
  type TripPlaceListResponse,
} from "@along-the-way/contracts/trip-places";
import { useI18n, type Messages } from "./i18n";
import { googleMapsCoordinatesUrl, googleMapsDirectionsUrl, googleMapsNavigationUrl } from "./google-maps";
import { safeExternalUrl } from "./external-url";
import { dayItems, dayLodgingAnchors, localDate, parallelItemIds, personalState, tripClock, type TodayDay, type TodayItem, type TodayModel, type TodayPlace } from "./today-model";
import { readTripLocation } from "./trip-location";
import { ApiRequestError } from "./api-error";
import { PlaceDetailContent } from "./PlaceDetailContent";
import { PlacePhotoCredit, PlaceThumbnail, usePlacePreviews, type PlaceDetailRequest, type PlaceDetailRequestOptions, type PlacePreviewValue } from "./PlaceThumbnail";
import { PlaceDetailSheet } from "./PlaceDetailSheet";
import { ClampedText } from "./ClampedText";
import { TodayPlaceGuide, type TodayPlaceGuideReference } from "./TodayPlaceGuide";
import { NearbyActivitiesContent, type NearbyActivitiesState } from "./TodayNearbyActivities";
import { NativeSelect } from "./components/ui/native-select";
import { placeTypeLabels } from "./locales/zh-TW/place-types";

interface TodayDetailSelection {
  reference: TodayPlaceGuideReference;
  name: string;
  triggerKey: string;
  date: string;
}

function haversineKilometres(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
) {
  const toRadians = Math.PI / 180;
  const latitudeDelta = (to.latitude - from.latitude) * toRadians;
  const longitudeDelta = (to.longitude - from.longitude) * toRadians;
  const fromLatitude = from.latitude * toRadians;
  const toLatitude = to.latitude * toRadians;
  const chord = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  const arc = Math.min(1, chord);
  return 6_371 * 2 * Math.atan2(Math.sqrt(arc), Math.sqrt(1 - arc));
}

function TodayItemDetails({ item, now, parallel, memberId, date, previews, previewsLoading, openPlace }: {
  item: TodayItem;
  now: number;
  parallel: boolean;
  memberId: string;
  date: string;
  previews: Map<string, PlacePreviewValue>;
  previewsLoading: boolean;
  openPlace?: (selection: TodayDetailSelection) => void;
}) {
  const { t } = useI18n();
  const text = t.today;
  const headingId = useId();
  const current = item.start && item.end && Date.parse(item.start) <= now && now < Date.parse(item.end);
  const start = item.endpoints.find((endpoint) => endpoint.role === "start");
  const end = item.endpoints.find((endpoint) => endpoint.role === "end");
  const directions = item.type === "transport" && start?.place && end?.place ? googleMapsCoordinatesUrl(end.place, start.place) : null;
  const official = safeExternalUrl(item.sourceUrl);
  const startLabel = item.type === "flight" ? text.departure : item.type === "lodging" ? text.checkIn : item.type === "transport" ? text.origin : text.start;
  const endLabel = item.type === "flight" ? text.arrival : item.type === "lodging" ? text.checkOut : item.type === "transport" ? text.destination : text.end;
  const needsManualCheck = item.constraints.length > 0 || !item.start || !item.end;
  return <article className="today-item-detail" aria-labelledby={headingId} data-current={Boolean(current)}>
    <h4 id={headingId}>{item.title}</h4>
    <section className="today-detail-section">
      <h5>{text.endpointsSection}</h5>
      <dl className="today-detail-facts">
        {item.endpoints.map((endpoint) => {
          const maps = endpoint.place ? googleMapsCoordinatesUrl(endpoint.place) : null;
          const detailIdentity = endpoint.place?.id ?? null;
          const triggerKey = detailIdentity ? encodeURIComponent(`${item.id}:${endpoint.role}:${detailIdentity}`) : "";
          const preview = detailIdentity ? previews.get(detailIdentity) : undefined;
          return <div key={endpoint.role} className="today-detail-endpoint">
            {endpoint.place && detailIdentity && openPlace ? <PlaceThumbnail photo={preview?.photo} photoCount={preview?.photoCount} loading={previewsLoading} placeType={endpoint.place.type ?? undefined} /> : null}
            <div className="min-w-0">
              <dt>{endpoint.role === "start" ? startLabel : endLabel}</dt>
              <dd>
                {endpoint.place ? <>{detailIdentity && openPlace ? <button
                  type="button"
                  className="min-h-11 max-w-full break-words text-left font-bold underline decoration-ink/30 underline-offset-4 outline-none hover:decoration-ink focus-visible:rounded focus-visible:ring-4 focus-visible:ring-focus/30"
                  aria-label={text.viewPlaceDetail(endpoint.place.name)}
                  data-today-place-detail-trigger={triggerKey}
                  onClick={() => openPlace({ reference: { kind: "itinerary-place", id: detailIdentity }, name: endpoint.place!.name, triggerKey, date })}
                >{endpoint.place.name}</button> : endpoint.place.name}</> : null}
              </dd>
              {endpoint.place?.address ? <dd>{endpoint.place.address}</dd> : null}
              <dd>{maps ? <a className="today-link" href={maps} target="_blank" rel="noopener noreferrer">{text.maps}<ExternalLink size={14} aria-hidden="true" /><span className="text-xs">{text.leavesApp}</span></a> : <span className="inline-flex items-center gap-1"><TriangleAlert size={15} aria-hidden="true" />{text.locationMissing}</span>}</dd>
              {endpoint.place && detailIdentity && openPlace ? <PlacePhotoCredit photo={preview?.photo} /> : null}
            </div>
          </div>;
        })}
      </dl>
      {directions ? <a className="today-link mt-2" href={directions} target="_blank" rel="noopener noreferrer">{text.directions}<ExternalLink size={16} aria-hidden="true" /><span className="text-xs">{text.leavesApp}</span></a> : null}
    </section>
    <section className="today-detail-section">
      <h5>{text.confirmationSection}</h5>
      <div className="today-detail-meta">
        <span>{text.types[item.type]}</span>
        {current ? <span><Clock3 size={16} aria-hidden="true" />{text.current}</span> : null}
        {parallel ? <span><Users size={16} aria-hidden="true" />{text.parallel}</span> : null}
        {item.locked ? <span><Lock size={16} aria-hidden="true" />{text.locked}</span> : null}
      </div>
      <p className="today-detail-participants">{item.participants === null ? text.participantsUnknown : <>{text.participants}：{item.participants.length === 0 ? text.noParticipants : item.participants.map((person) => `${person.name}${person.removed ? `・${t.tripSkeleton.participantRemoved}` : ""}${person.id === memberId ? `（${text.you}）` : ""}`).join("、")}</>}</p>
      {item.facts.length ? <dl className="today-detail-facts">
        {item.facts.map((fact) => <div key={fact.kind}><dt>{text.facts[fact.kind]}</dt><dd className="whitespace-pre-wrap">{fact.value}</dd></div>)}
      </dl> : null}
      {official ? <a className="today-link mt-2" href={official} target="_blank" rel="noopener noreferrer">{text.officialLink}<ExternalLink size={16} aria-hidden="true" /><span className="text-xs">{text.leavesApp}</span></a> : null}
    </section>
    <section className="today-detail-section">
      <h5>{text.notes}</h5>
      {needsManualCheck ? <div className="text-sm">
        <p className="inline-flex items-center gap-1 font-semibold"><TriangleAlert size={16} aria-hidden="true" />{text.manualChecks}</p>
        <ul className="mt-1 list-inside list-disc">
          {item.constraints.map((constraint, index) => <li key={index}>{constraint.type === "fixed_time" ? text.fixed : constraint.type === "immovable" ? text.immovable : text.buffer(constraint.minutes)} · {text.constraintStatus[constraint.status]}</li>)}
        </ul>
      </div> : null}
      {item.type === "transport" ? <p className="mt-3 text-sm text-muted-foreground">{text.routeUnavailable}</p> : null}
      {item.notes ? <p className="mt-3 whitespace-pre-wrap">{item.notes}</p> : !needsManualCheck && item.type !== "transport" ? <p className="text-sm text-muted-foreground">{text.noNotes}</p> : null}
    </section>
  </article>;
}

type TimelineState = "past" | "current" | "next" | "later" | "unscheduled";

function itemDisplayOnDay(item: TodayItem, zone: string | null, selectedDate: string) {
  const start = item.endpoints.find((endpoint) => endpoint.role === "start");
  const end = item.endpoints.find((endpoint) => endpoint.role === "end");
  const startZone = start?.timeZone ?? zone;
  const endZone = end?.timeZone ?? startZone;
  const startLocalDate = item.start && startZone ? localDate(Date.parse(item.start), startZone) : null;
  const endLocalDate = item.end && endZone ? localDate(Date.parse(item.end), endZone) : null;
  const startsOnSelectedDay = startLocalDate === selectedDate;
  const endsOnSelectedDay = endLocalDate === selectedDate;
  return {
    start,
    end,
    startZone,
    endZone,
    startsOnSelectedDay,
    endsOnSelectedDay,
    displayedEndpoint: startsOnSelectedDay ? start ?? null : endsOnSelectedDay ? end ?? null : null,
    displayedInstant: startsOnSelectedDay ? item.start : endsOnSelectedDay ? item.end : null,
  };
}


function TodayCard({ item, zone, selectedDate, parallel, state, onOpen }: {
  item: TodayItem;
  zone: string | null;
  selectedDate: string;
  parallel: boolean;
  state: TimelineState;
  onOpen(item: TodayItem, triggerKey?: string): void;
}) {
  const { t } = useI18n();
  const display = itemDisplayOnDay(item, zone, selectedDate);
  const continuesFromPreviousDay = Boolean(item.start && item.end && !display.startsOnSelectedDay);
  const destination = display.end?.place ?? display.start?.place ?? null;
  // Times are not shown on Today; the left column marks the kind of fixed item instead.
  const TypeIcon = item.type === "flight" ? Plane : item.type === "lodging" ? BedDouble : CalendarDays;
  return <li className={`today-stop is-fixed is-${state}`} data-current={state === "current"}>
    <span className="today-stop-kind" aria-hidden="true"><TypeIcon size={16} /></span>
    <span className="today-stop-track" aria-hidden="true" />
    <button
      type="button"
      className="today-stop-body"
      data-today-item-trigger={item.id}
      aria-label={t.today.viewItemDetail(item.title)}
      onClick={() => onOpen(item)}
    >
      <span className="today-stop-title">
        {item.type === "lodging" ? <span className="lodging-mark" aria-hidden="true"><BedDouble /></span> : null}
        <strong>{item.title}</strong>
        <span className="today-chip today-chip-category">{t.today.types[item.type]}</span>
        {state === "current" ? <span className="today-chip"><CircleDot size={14} aria-hidden="true" />{t.today.current}</span> : null}
        {state === "next" ? <span className="today-chip today-chip-status"><MapPin size={14} aria-hidden="true" />{t.today.nextStop}</span> : null}
        {parallel ? <span className="today-chip today-chip-status"><Users size={14} aria-hidden="true" />{t.today.parallel}</span> : null}
        {item.locked ? <span className="today-chip today-chip-status"><Lock size={14} aria-hidden="true" />{t.today.locked}</span> : null}
      </span>
      <span className="today-stop-meta">
        {continuesFromPreviousDay ? <span>{t.today.continuesFromPreviousDay}</span> : null}
        {destination ? <span>{destination.name}</span> : null}
        {!destination ? <span>{t.today.locationMissing}</span> : null}
      </span>
    </button>
  </li>;
}

/** Where the day starts or ends: a compact row, not a stop; opens the stay's own detail. */
function TodayLodgingAnchor({ edge, item, place, onOpen }: {
  edge: "start" | "end";
  item: TodayItem;
  place: TodayPlace;
  onOpen(item: TodayItem, triggerKey?: string): void;
}) {
  const { t } = useI18n();
  const label = edge === "start" ? t.today.lodgingAnchorStart(place.name) : t.today.lodgingAnchorEnd(place.name);
  const triggerKey = `anchor-${edge}:${item.id}`;
  return <li className={`today-stop today-anchor is-anchor-${edge}`}>
    <span className="today-stop-kind" aria-hidden="true"><BedDouble size={16} /></span>
    <span className="today-stop-track" aria-hidden="true" />
    <button
      type="button"
      className="today-stop-body today-anchor-body"
      data-today-item-trigger={triggerKey}
      aria-label={t.today.viewItemDetail(label)}
      onClick={() => onOpen(item, triggerKey)}
    >
      <span>{label}</span>
      <ChevronRight size={16} aria-hidden="true" />
    </button>
  </li>;
}

type WishlistPlace = TodayDay["wishlist"][number];
type TimelineEntry =
  | { kind: "fixed"; item: TodayItem; state: TimelineState }
  | { kind: "place"; place: WishlistPlace; order: number }
  | { kind: "anchor"; edge: "start" | "end"; item: TodayItem; place: TodayPlace };

interface TimelineRouteEnd {
  name: string;
  latitude: number | null;
  longitude: number | null;
  providerPlaceId: string | null;
}

function routeEnd(entry: TimelineEntry, edge: "before" | "after", zone: string | null, selectedDate: string): TimelineRouteEnd | null {
  if (entry.kind === "place") return entry.place;
  if (entry.kind === "anchor") return { name: entry.place.name, latitude: entry.place.latitude, longitude: entry.place.longitude, providerPlaceId: null };
  const display = itemDisplayOnDay(entry.item, zone, selectedDate);
  let place;
  if (entry.item.type === "flight" || entry.item.type === "transport") {
    place = display.startsOnSelectedDay !== display.endsOnSelectedDay
      ? display.displayedEndpoint?.place ?? null
      : edge === "before"
        ? display.start?.place ?? display.end?.place ?? null
        : display.end?.place ?? display.start?.place ?? null;
  } else {
    place = display.displayedEndpoint?.place ?? display.start?.place ?? display.end?.place ?? null;
  }
  return place ? { name: place.name, latitude: place.latitude, longitude: place.longitude, providerPlaceId: null } : null;
}

/** Each stop's quiet actions (備案, 附近活動) share the leg row under it, after the Maps link. */
function TodayDirectionsLeg({ from, to, zone, selectedDate, controls, alternativesPanel }: {
  from: TimelineEntry;
  to: TimelineEntry | null;
  zone: string | null;
  selectedDate: string;
  controls: Array<{ key: string; node: ReactNode }>;
  alternativesPanel?: ReactNode;
}) {
  const origin = routeEnd(from, "after", zone, selectedDate);
  const destination = to ? routeEnd(to, "before", zone, selectedDate) : null;
  // Check-in/check-out day: the stay's own card sits next to its anchor; a hotel → hotel leg says nothing.
  const sameStay = (from.kind === "anchor" || to?.kind === "anchor")
    && origin?.latitude != null && origin.latitude === destination?.latitude && origin.longitude === destination.longitude;
  const directions = origin && destination && !sameStay ? googleMapsDirectionsUrl(origin, destination) : null;
  if (!directions && controls.length === 0 && !alternativesPanel) return null;
  return <li className={`today-route-leg${alternativesPanel ? " has-backups" : ""}`}>
    <span aria-hidden="true" />
    <span className="today-route-leg-track" aria-hidden="true" />
    <span className="today-route-leg-body">
      {directions && origin && destination ? <a
        className="route-leg-directions"
        href={directions}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`在 Google Maps 查看「${origin.name}」到「${destination.name}」的交通方式（另開新分頁）`}
      >
        <MapPin aria-hidden="true" /> Google Maps
      </a> : null}
      {controls.map((control, controlIndex) => <Fragment key={control.key}>
        {directions || controlIndex > 0 ? <span className="today-route-leg-separator" aria-hidden="true">·</span> : null}
        {control.node}
      </Fragment>)}
    </span>
    {alternativesPanel ? <div className="today-route-leg-backups">{alternativesPanel}</div> : null}
  </li>;
}

const SUPPORTED_ALTERNATIVE_TYPES: Partial<Record<NonNullable<WishlistPlace["type"]>, true>> = {
  restaurant: true,
  cafe: true,
  worship: true,
  museum: true,
  nature: true,
  shopping: true,
  activity: true,
};

type AlternativePanelState = {
  dayId: string;
  date: string;
  stopTripPlaceId: string;
  stopName: string;
  stopType: NonNullable<WishlistPlace["type"]>;
  phase: "loading" | "ready" | "error";
  response: NearbyAlternativesResponse | null;
  error: "quota" | "unavailable" | null;
};

interface CandidateDetailSelection {
  candidate: NearbyAlternativeDto;
  stopTripPlaceId: string;
  stopName: string;
  triggerKey: string;
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

function stopTriggerKey(tripPlaceId: string) {
  return encodeURIComponent(`wishlist:${tripPlaceId}`);
}

function candidateTriggerKey(stopTripPlaceId: string, providerPlaceId: string) {
  return encodeURIComponent(`nearby:${stopTripPlaceId}:${providerPlaceId}`);
}

function alternativeRating(candidate: NearbyAlternativeDto, locale: string, copy: Messages["today"]["stopBackups"]) {
  if (candidate.rating === null) return copy.noRating;
  const rating = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(candidate.rating);
  if (candidate.userRatingCount === null) return `★${rating}`;
  return copy.rating(rating, new Intl.NumberFormat(locale).format(candidate.userRatingCount));
}

function AlternativePanel({
  id,
  state,
  locale,
  canManage,
  busyProviderPlaceId,
  error,
  retry,
  openCandidate,
  swap,
}: {
  id: string;
  state: AlternativePanelState;
  locale: string;
  canManage: boolean;
  busyProviderPlaceId: string | null;
  error: string | null;
  retry(): void;
  openCandidate(candidate: NearbyAlternativeDto): void;
  swap(candidate: NearbyAlternativeDto): void;
}) {
  const { t } = useI18n();
  const copy = t.today.stopBackups;
  const typeLabel = placeTypeLabels[state.stopType];
  const loadingCopy = copy.loading(typeLabel);
  return <div className="today-backups-expander">
    <section id={id} className="today-backups" aria-label={copy.findNearby(state.stopName, typeLabel)}>
      <div className="today-backups__head">
        <span>{copy.nearby}</span>
      </div>
      {state.phase === "loading" ? <>
        <div className="today-backups__loading" aria-hidden="true">
          <div className="today-backups__loading-label"><LoaderCircle className="animate-spin motion-reduce:animate-none" size={16} />{loadingCopy}</div>
          {Array.from({ length: 3 }, (_, index) => <div className="today-backups__skeleton" key={index}>
            <span className="place-list-skeleton__block today-backups__skeleton-thumb" />
            <span className="today-backups__skeleton-copy">
              <span className="place-list-skeleton__block today-backups__skeleton-title" />
              <span className="place-list-skeleton__block today-backups__skeleton-meta" />
            </span>
          </div>)}
        </div>
        <span className="sr-only" role="status">{loadingCopy}</span>
      </> : state.phase === "error" ? <div className="today-backups__state" role="alert">
        <p>{state.error === "quota" ? copy.quota : copy.unavailable}</p>
        {state.error === "unavailable" ? <button type="button" onClick={retry}>{copy.retry}</button> : null}
      </div> : state.response && state.response.alternatives.length === 0 ? <p className="today-backups__state" role="status">{copy.empty}</p> : (
        <ul className="today-backups__list">
          {state.response?.alternatives.map((candidate) => {
            const triggerKey = candidateTriggerKey(state.stopTripPlaceId, candidate.providerPlaceId);
            const busy = busyProviderPlaceId === candidate.providerPlaceId;
            const rating = alternativeRating(candidate, locale, copy);
            const distance = copy.distance(new Intl.NumberFormat(locale).format(candidate.straightLineMeters));
            const descriptionId = `today-candidate-meta-${triggerKey}`;
            return <li className="today-backups__candidate" key={candidate.providerPlaceId}>
              <button
                type="button"
                className="today-backups__candidate-detail"
                aria-label={copy.viewAlternative(candidate.name)}
                aria-describedby={descriptionId}
                data-today-candidate-detail-trigger={triggerKey}
                onClick={() => openCandidate(candidate)}
              >
                <PlaceThumbnail photo={candidate.photo} placeType={candidate.type} />
                <span className="today-backups__candidate-copy" id={descriptionId}>
                  <strong>{candidate.name}</strong>
                  <span>{rating}</span>
                  <span>{distance}</span>
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
              {canManage ? <button
                type="button"
                className="today-backups__swap"
                disabled={busyProviderPlaceId !== null}
                aria-busy={busy}
                onClick={() => swap(candidate)}
              >{busy ? copy.processing : copy.swap}</button> : null}
              <div className="today-backups__candidate-credit">
                <small>{candidate.attribution}</small>
                <PlacePhotoCredit photo={candidate.photo} />
              </div>
            </li>;
          })}
        </ul>
      )}
      {error ? <p className="today-backups__operation-error" role="alert">{error}</p> : null}
    </section>
  </div>;
}

function CandidatePhoto({ candidate }: { candidate: NearbyAlternativeDto }) {
  const photoKey = candidate.photo ? `${candidate.photo.id}\u0000${candidate.photo.imageUrl}` : null;
  const [failure, setFailure] = useState({ photoKey, failed: false });
  if (failure.photoKey !== photoKey) setFailure({ photoKey, failed: false });
  const failed = failure.photoKey === photoKey && failure.failed;
  const { t } = useI18n();
  return <div className="today-candidate-detail__media">
    {candidate.photo && !failed ? <img
      src={candidate.photo.imageUrl}
      width={candidate.photo.width}
      height={candidate.photo.height}
      alt={t.today.stopBackups.candidatePhoto(candidate.name)}
      decoding="async"
      onError={() => setFailure({ photoKey, failed: true })}
    /> : <div className="today-candidate-detail__photo-empty" role="img" aria-label={t.placeDetail.photoUnavailable}>
      <ImageOff aria-hidden="true" />
      <span>{t.placeDetail.photoUnavailable}</span>
    </div>}
    <PlacePhotoCredit photo={candidate.photo} />
  </div>;
}

function TodayPlaceCard({
  place,
  order,
  date,
  preview,
  previewsLoading,
  openPlace,
  canManage,
  undoingReplacementId,
  operationError,
  alternativesOpen,
  undo,
}: {
  place: WishlistPlace;
  order: number;
  date: string;
  preview: PlacePreviewValue | undefined;
  previewsLoading: boolean;
  openPlace?: (selection: TodayDetailSelection) => void;
  canManage: boolean;
  undoingReplacementId: string | null;
  operationError: string | null;
  alternativesOpen: boolean;
  undo(place: WishlistPlace): void;
}) {
  const { t } = useI18n();
  const copy = t.today.stopBackups;
  const triggerKey = stopTriggerKey(place.id);
  const relationTriggerKey = place.replacedStop
    ? encodeURIComponent(`replaced:${place.id}:${place.replacedStop.originalTripPlaceId}`)
    : "";
  const hasFollowup = place.replacedStop !== null || (!alternativesOpen && operationError !== null);
  const undoing = place.replacedStop?.replacementId === undoingReplacementId;
  return <li className={`today-stop is-place${hasFollowup ? " has-followup" : ""}`}>
    <span className="today-stop-order" aria-hidden="true">{order}</span>
    <span className="today-stop-track" aria-hidden="true" />
    <div className="today-stop-body today-place-body">
      {openPlace ? <PlaceThumbnail photo={preview?.photo} photoCount={preview?.photoCount} loading={previewsLoading} placeType={place.type ?? undefined} /> : null}
      <div className="today-place-copy">
        {openPlace ? <button
          type="button"
          className="today-place-detail-trigger"
          aria-label={t.today.viewPlaceDetail(place.name)}
          data-today-place-detail-trigger={triggerKey}
          onClick={() => openPlace({ reference: { kind: "trip-place", id: place.id }, name: place.name, triggerKey, date })}
        >
          <strong>{place.name}</strong><ChevronRight size={16} aria-hidden="true" />
        </button> : <strong>{place.name}</strong>}
        <PlacePhotoCredit photo={preview?.photo} />
      </div>
    </div>
    {place.replacedStop ? <div className="today-stop-relation">
      <span>{copy.originalLabel}
        {openPlace ? <button
          type="button"
          aria-label={copy.viewOriginal(place.replacedStop.originalName)}
          data-today-place-detail-trigger={relationTriggerKey}
          onClick={() => openPlace({
            reference: { kind: "trip-place", id: place.replacedStop!.originalTripPlaceId },
            name: place.replacedStop!.originalName,
            triggerKey: relationTriggerKey,
            date,
          })}
        >{place.replacedStop.originalName}</button> : place.replacedStop.originalName}
      </span>
      {canManage ? <button
        type="button"
        className="today-stop-relation__undo"
        disabled={undoingReplacementId !== null}
        aria-busy={undoing}
        onClick={() => undo(place)}
      >{undoing ? copy.processing : copy.undo}</button> : null}
      {!alternativesOpen && operationError ? <p role="alert">{operationError}</p> : null}
    </div> : !alternativesOpen && operationError ? <p className="today-backups__operation-error today-backups__operation-error--standalone" role="alert">{operationError}</p> : null}
  </li>;
}

/**
 * Trips whose 行程 was already shown in this page load. A home-screen shortcut or a reload restores the URL,
 * including the `day` it was saved on; during the trip that first view shows today instead.
 */
const openedTrips = new Set<string>();

export function TodayWorkspace({ model, selectedDate, onDayChanged, canArrange, onArrangeDay, offline = false, fetchedAt, retry, retrying = false, persisted = true, request, onChanged, onPersistentError, photoRevision = 0 }: {
  model: TodayModel;
  selectedDate: string | null;
  onDayChanged(date: string, replace?: boolean): void;
  /** Owner, or an editor the owner allows to arrange the itinerary. */
  canArrange?: boolean;
  onArrangeDay?(date: string): void;
  offline?: boolean;
  fetchedAt: string;
  retry(): void;
  retrying?: boolean;
  persisted?: boolean;
  request?: PlaceDetailRequest;
  onChanged?(): Promise<void>;
  onPersistentError?(message: string): void;
  photoRevision?: number;
}) {
  const { t, locale } = useI18n();
  const text = t.today;
  const [now, setNow] = useState(Date.now);
  const [selectedDetail, setSelectedDetail] = useState<TodayDetailSelection | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<AlternativePanelState | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<CandidateDetailSelection | null>(null);
  const [busyProviderPlaceId, setBusyProviderPlaceId] = useState<string | null>(null);
  const [undoingReplacementId, setUndoingReplacementId] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<{ stopTripPlaceId: string; message: string } | null>(null);
  const [activities, setActivities] = useState<NearbyActivitiesState | null>(null);
  const activitySequence = useRef(0);
  const detailReturnPosition = useRef<{ x: number; y: number } | null>(null);
  const itemReturnPosition = useRef<{ x: number; y: number } | null>(null);
  const itemReturnTrigger = useRef<string | null>(null);
  const timelineRef = useRef<HTMLElement | null>(null);
  const detailTitleRef = useRef<HTMLHeadingElement>(null);
  const searchSequence = useRef(0);
  const visibleDayKey = useRef("");
  const retryKeys = useRef<RetryKeys>(new Map());
  const mounted = useRef(true);
  const detailRequest = useCallback(async <T,>(url: string, options?: PlaceDetailRequestOptions): Promise<T> => {
    if (!request) throw new Error("Place detail request is unavailable");
    return request<T>(url, photoRevision === 0 ? options : { ...options, cache: "no-cache" });
  }, [photoRevision, request]);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 15_000);
    window.addEventListener("focus", tick);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", tick); };
  }, []);
  const clock = tripClock(model, now);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // The first view of this trip in this page load shows today; later day switches in the app are kept.
  const coldStart = clock.phase === "during" && !openedTrips.has(model.tripId);
  const day = (coldStart ? clock.today : model.days.find((entry) => entry.date === selectedDate))
    ?? clock.today
    ?? (clock.phase === "after" ? model.days.at(-1) : model.days[0]);
  useEffect(() => {
    // Only a known clock settles the first view: an unknown zone must not use up the switch to today.
    if (clock.phase !== "unknown") openedTrips.add(model.tripId);
  }, [clock.phase, model.tripId]);
  visibleDayKey.current = `${model.tripId}:${day?.id ?? ""}`;
  useEffect(() => {
    if (readTripLocation().trip === model.tripId && day && day.date !== selectedDate) onDayChanged(day.date, true);
  }, [model.tripId, day, selectedDate, onDayChanged]);
  useEffect(() => {
    if (selectedDetail && day?.date !== selectedDetail.date) setSelectedDetail(null);
  }, [day?.date, selectedDetail]);
  useEffect(() => { setSelectedItemId(null); }, [day?.date]);
  useEffect(() => {
    searchSequence.current += 1;
    setAlternatives(null);
    setSelectedCandidate(null);
    setOperationError(null);
    activitySequence.current += 1;
    setActivities(null);
  }, [model.tripId, day?.id]);
  useEffect(() => {
    if (!alternatives || !day || day.wishlist.some((place) => place.id === alternatives.stopTripPlaceId)) return;
    searchSequence.current += 1;
    setAlternatives(null);
    setSelectedCandidate(null);
  }, [alternatives, day]);
  const reminderLines = useMemo(() => {
    if (!day) return [];
    const lines: Array<{ key: string; copy: string; emphasis: boolean }> = [];
    const seen = new Set<string>();
    const add = (key: string, copy: string, emphasis = false) => {
      if (seen.has(copy)) return;
      seen.add(copy);
      lines.push({ key, copy, emphasis });
    };
    const formatters = new Map<string, Intl.DateTimeFormat>();
    const formatTime = (instant: string | number, timeZone: string) => {
      let formatter = formatters.get(timeZone);
      if (!formatter) {
        formatter = new Intl.DateTimeFormat(locale, {
          timeZone,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        });
        formatters.set(timeZone, formatter);
      }
      return formatter.format(new Date(instant));
    };
    const endpointDate = (endpoint: TodayItem["endpoints"][number]) =>
      localDate(Date.parse(endpoint.instant), endpoint.timeZone);
    const endpointIsOnDay = (endpoint: TodayItem["endpoints"][number] | undefined) =>
      Boolean(endpoint && endpointDate(endpoint) === day.date);
    const firstDay = model.days[0]?.id === day.id;
    const lastTripDate = model.days.at(-1)?.date ?? null;
    const lastDay = model.days.at(-1)?.id === day.id;
    const checkIns: Array<{ item: TodayItem; endpoint: TodayItem["endpoints"][number] }> = [];
    const checkOuts: Array<{ item: TodayItem; endpoint: TodayItem["endpoints"][number] }> = [];
    const departures: Array<{ item: TodayItem; endpoint: TodayItem["endpoints"][number]; deadlineInstant: number; deadlineDate: string }> = [];

    for (const item of model.items) {
      const start = item.endpoints.find((endpoint) => endpoint.role === "start");
      const end = item.endpoints.find((endpoint) => endpoint.role === "end");
      if (firstDay && item.type === "lodging" && start && endpointIsOnDay(start)) checkIns.push({ item, endpoint: start });
      if (lastDay && item.type === "lodging" && end && endpointIsOnDay(end)) checkOuts.push({ item, endpoint: end });
      if (item.type === "flight" && start && endpointDate(start) === lastTripDate) {
        const deadlineInstant = Date.parse(start.instant) - 3 * 60 * 60 * 1_000;
        const deadlineDate = localDate(deadlineInstant, start.timeZone);
        if (endpointDate(start) === day.date || deadlineDate === day.date) {
          departures.push({ item, endpoint: start, deadlineInstant, deadlineDate });
        }
      }
    }

    if (clock.phase === "before") {
      add("departure-countdown", text.reminderDepartureCountdown(clock.daysUntil), true);
      add("departure-checklist", text.reminderDepartureChecklist);
    }
    if (firstDay) {
      add("first-day-welcome", text.reminderFirstDayWelcome, true);
      add("first-day-practical", text.reminderFirstDayPractical);
      for (const { item, endpoint } of checkIns) {
        add(`check-in:${item.id}`, text.reminderCheckIn(
          endpoint.place?.name ?? item.title,
          formatTime(endpoint.instant, endpoint.timeZone),
        ));
      }
    }
    if (lastDay) {
      add("last-day-farewell", text.reminderLastDayFarewell, true);
      for (const { item, endpoint } of checkOuts) {
        add(`check-out:${item.id}`, text.reminderCheckOut(
          endpoint.place?.name ?? item.title,
          formatTime(endpoint.instant, endpoint.timeZone),
        ));
      }
    }
    for (const { item, endpoint, deadlineInstant, deadlineDate } of departures) {
      const departureDate = endpointDate(endpoint);
      const deadlineTime = formatTime(deadlineInstant, endpoint.timeZone);
      add(`departure:${item.id}`, text.reminderDepartingFlight(
        item.title,
        formatTime(endpoint.instant, endpoint.timeZone),
        deadlineDate === departureDate ? deadlineTime : `${text.previous} ${deadlineTime}`,
      ));
    }
    if (lastDay) add("last-day-checklist", text.reminderLastDayChecklist);
    if (day.wishlist.length > 0) {
      let distanceComplete = day.wishlist.length >= 2;
      let distanceKilometres = 0;
      for (let placeIndex = 1; placeIndex < day.wishlist.length; placeIndex++) {
        const previous = day.wishlist[placeIndex - 1]!;
        const place = day.wishlist[placeIndex]!;
        if (
          previous.latitude === null
          || previous.longitude === null
          || place.latitude === null
          || place.longitude === null
        ) {
          distanceComplete = false;
          continue;
        }
        distanceKilometres += haversineKilometres(
          { latitude: previous.latitude, longitude: previous.longitude },
          { latitude: place.latitude, longitude: place.longitude },
        );
      }
      add("day-review", text.reminderDayReview(
        day.wishlist.length,
        distanceComplete ? distanceKilometres : null,
      ));
    }
    return lines;
  }, [clock.daysUntil, clock.phase, day, locale, model.days, model.items, text]);
  const endpointIds = useMemo(() => [...new Set(model.items.flatMap((item) => item.endpoints.flatMap((endpoint) => endpoint.place?.id ? [endpoint.place.id] : [])))], [model.items]);
  const wishlistIds = useMemo(() => [...new Set(model.days.flatMap((entry) => entry.wishlist.map((place) => place.id)))], [model.days]);
  const endpointPreviews = usePlacePreviews({ tripId: model.tripId, kind: "itinerary-place", ids: endpointIds, request: request ? detailRequest : undefined, enabled: Boolean(request) && !offline });
  const wishlistPreviews = usePlacePreviews({ tripId: model.tripId, kind: "trip-place", ids: wishlistIds, request: request ? detailRequest : undefined, enabled: Boolean(request) && !offline });

  if (!day) return <p>{text.empty}</p>;
  const activeDay = day;
  const index = model.days.indexOf(day);
  const lodgingAnchors = dayLodgingAnchors(model, day.date);
  // A stay that is only where this day starts/ends (neither check-in nor check-out today) is not a stop.
  const anchorOnlyIds = new Set([lodgingAnchors.start, lodgingAnchors.end].flatMap((anchor) => {
    if (!anchor) return [];
    const display = itemDisplayOnDay(anchor.item, day.timeZone, day.date);
    return display.startsOnSelectedDay || display.endsOnSelectedDay ? [] : [anchor.item.id];
  }));
  const items = dayItems(model, day).filter((item) => !anchorOnlyIds.has(item.id));
  const parallel = parallelItemIds(items);
  const selectedIsToday = clock.phase === "during" && clock.today?.id === day.id;
  const personal = personalState(items, model.memberId, now);
  const leadEligibleItems = items.filter((item) => item.participants === null || item.participants.some((participant) => participant.id === model.memberId));
  const leadCurrent = selectedIsToday ? leadEligibleItems.find((item) => item.start && item.end && Date.parse(item.start) <= now && now < Date.parse(item.end)) ?? null : null;
  const leadNext = selectedIsToday ? leadEligibleItems.filter((item) => item.start && Date.parse(item.start) > now)
    .sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!) || a.id.localeCompare(b.id))[0] ?? null : null;
  const firstFixed = [...model.items].filter((item) => item.start && (item.type === "flight" || item.type === "reservation" || item.locked || item.constraints.some((constraint) => constraint.type === "fixed_time" && constraint.status === "confirmed")))
    .sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!))[0] ?? null;
  const snapshotTime = new Intl.DateTimeFormat(locale, { timeZone: day.timeZone ?? "UTC", dateStyle: "medium", timeStyle: "short" }).format(new Date(fetchedAt));
  const openPlace = request && !offline ? (selection: TodayDetailSelection) => {
    detailReturnPosition.current = { x: window.scrollX, y: window.scrollY };
    setSelectedDetail(selection);
  } : undefined;

  function closeDetail() {
    const triggerKey = selectedDetail?.triggerKey;
    const position = detailReturnPosition.current;
    detailReturnPosition.current = null;
    setSelectedDetail(null);
    if (triggerKey) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-today-place-detail-trigger="${triggerKey}"]`)?.focus({ preventScroll: true });
        if (position) window.scrollTo({ left: position.x, top: position.y, behavior: "instant" });
      });
    }
  }
  const canManageAlternatives = Boolean(request && onChanged && canArrange && !offline);
  const canSeeActivities = Boolean(request && !offline);
  function focusTripPlace(tripPlaceId: string) {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const trigger = document.querySelector<HTMLElement>(`[data-today-place-detail-trigger="${stopTriggerKey(tripPlaceId)}"]`);
        (trigger ?? timelineRef.current)?.focus({ preventScroll: true });
        trigger?.scrollIntoView({ block: "nearest" });
      });
    });
  }

  function isCurrentTripRoute() {
    return readTripLocation().trip === model.tripId;
  }

  async function findAlternatives(place: WishlistPlace) {
    if (!request || !canManageAlternatives || !place.type || !SUPPORTED_ALTERNATIVE_TYPES[place.type]
      || place.latitude === null || place.longitude === null) return;
    const sequence = ++searchSequence.current;
    const requestDayKey = visibleDayKey.current;
    setSelectedCandidate(null);
    setOperationError(null);
    setAlternatives({
      dayId: activeDay.id,
      date: activeDay.date,
      stopTripPlaceId: place.id,
      stopName: place.name,
      stopType: place.type,
      phase: "loading",
      response: null,
      error: null,
    });
    try {
      const response = await request<NearbyAlternativesResponse>(
        `/api/trips/${model.tripId}/days/${activeDay.id}/trip-places/${place.id}/nearby-alternatives`,
        { method: "POST", parse: parseNearbyAlternativesResponse },
      );
      if (searchSequence.current !== sequence
        || visibleDayKey.current !== requestDayKey
        || response.dayId !== activeDay.id
        || response.stopTripPlaceId !== place.id) return;
      setAlternatives({
        dayId: activeDay.id,
        date: activeDay.date,
        stopTripPlaceId: place.id,
        stopName: place.name,
        stopType: place.type,
        phase: "ready",
        response,
        error: null,
      });
    } catch (reason) {
      if (searchSequence.current !== sequence || visibleDayKey.current !== requestDayKey) return;
      setAlternatives({
        dayId: activeDay.id,
        date: activeDay.date,
        stopTripPlaceId: place.id,
        stopName: place.name,
        stopType: place.type,
        phase: "error",
        response: null,
        error: reason instanceof ApiRequestError && reason.code === "provider_quota" ? "quota" : "unavailable",
      });
    }
  }

  function collapseAlternatives() {
    searchSequence.current += 1;
    setAlternatives(null);
    setSelectedCandidate(null);
    setOperationError(null);
  }

  /** View only, so any member may look; one request per tap, dropped if the day changed meanwhile. */
  async function findActivities(place: WishlistPlace) {
    if (!request || !canSeeActivities || place.latitude === null || place.longitude === null) return;
    const sequence = ++activitySequence.current;
    const requestDayKey = visibleDayKey.current;
    const base = {
      dayId: activeDay.id,
      date: activeDay.date,
      stopTripPlaceId: place.id,
      stopName: place.name,
      triggerKey: stopTriggerKey(place.id),
    };
    setActivities({ ...base, phase: "loading", response: null, error: null });
    try {
      const response = await request<NearbyActivitiesResponse>(
        `/api/trips/${model.tripId}/days/${activeDay.id}/trip-places/${place.id}/nearby-activities`,
        { method: "POST", parse: parseNearbyActivitiesResponse },
      );
      if (activitySequence.current !== sequence
        || visibleDayKey.current !== requestDayKey
        || response.stopTripPlaceId !== place.id) return;
      setActivities({ ...base, phase: "ready", response, error: null });
    } catch (reason) {
      if (activitySequence.current !== sequence || visibleDayKey.current !== requestDayKey) return;
      setActivities({
        ...base,
        phase: "error",
        response: null,
        error: reason instanceof ApiRequestError && reason.code === "rate_limited" ? "quota" : "unavailable",
      });
    }
  }

  function closeActivities() {
    const triggerKey = activities?.triggerKey;
    activitySequence.current += 1;
    setActivities(null);
    if (triggerKey) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-today-activities-trigger="${triggerKey}"]`)?.focus({ preventScroll: true });
      });
    }
  }

  function openCandidate(candidate: NearbyAlternativeDto) {
    if (!alternatives?.response) return;
    const triggerKey = candidateTriggerKey(alternatives.stopTripPlaceId, candidate.providerPlaceId);
    detailReturnPosition.current = { x: window.scrollX, y: window.scrollY };
    setSelectedCandidate({
      candidate,
      stopTripPlaceId: alternatives.stopTripPlaceId,
      stopName: alternatives.stopName,
      triggerKey,
    });
  }

  function closeCandidate() {
    const triggerKey = selectedCandidate?.triggerKey;
    const position = detailReturnPosition.current;
    detailReturnPosition.current = null;
    setSelectedCandidate(null);
    window.requestAnimationFrame(() => {
      if (triggerKey) document.querySelector<HTMLElement>(`[data-today-candidate-detail-trigger="${triggerKey}"]`)?.focus({ preventScroll: true });
      if (position) window.scrollTo({ left: position.x, top: position.y, behavior: "instant" });
    });
  }

  async function swapAlternative(candidate: NearbyAlternativeDto) {
    if (!request || !onChanged || !alternatives?.response || busyProviderPlaceId !== null) return;
    const alternativesResponse = alternatives.response;
    const context = alternatives;
    const mutationDayKey = visibleDayKey.current;
    const mutationSequence = searchSequence.current;
    const payload = {
      expectedDayVersion: alternativesResponse.dayVersion,
      providerPlaceId: candidate.providerPlaceId,
    };
    const operation = `replace:${context.dayId}:${context.stopTripPlaceId}`;
    setBusyProviderPlaceId(candidate.providerPlaceId);
    setOperationError(null);
    onPersistentError?.("");
    let response: TripPlaceListResponse;
    try {
      response = await request<TripPlaceListResponse>(
        `/api/trips/${model.tripId}/days/${context.dayId}/trip-places/${context.stopTripPlaceId}/replacement`,
        {
          method: "POST",
          headers: { "Idempotency-Key": retryKey(retryKeys.current, operation, payload) },
          body: JSON.stringify(payload),
          parse: parseTripPlaceListResponse,
        },
      );
    } catch (reason) {
      if (!mounted.current || !isCurrentTripRoute()) {
        if (mounted.current) setBusyProviderPlaceId(null);
        return;
      }
      const viewStillCurrent = visibleDayKey.current === mutationDayKey
        && searchSequence.current === mutationSequence;
      if (reason instanceof ApiRequestError && reason.code === "conflict") {
        const refreshSequence = viewStillCurrent ? ++searchSequence.current : mutationSequence;
        if (viewStillCurrent) {
          setAlternatives(null);
          setSelectedCandidate(null);
        }
        try {
          await onChanged();
          if (viewStillCurrent
            && mounted.current
            && visibleDayKey.current === mutationDayKey
            && searchSequence.current === refreshSequence) {
            setOperationError({ stopTripPlaceId: context.stopTripPlaceId, message: text.stopBackups.conflict });
          }
        } catch {
          if (isCurrentTripRoute()) onPersistentError?.(text.stopBackups.conflictRefreshFailed);
        }
      } else if (viewStillCurrent) {
        setOperationError({ stopTripPlaceId: context.stopTripPlaceId, message: text.stopBackups.outcomeUnknown });
      }
      if (mounted.current) setBusyProviderPlaceId(null);
      return;
    }
    retryKeys.current.delete(operation);
    if (!mounted.current || !isCurrentTripRoute()) {
      if (mounted.current) setBusyProviderPlaceId(null);
      return;
    }
    const viewStillCurrent = visibleDayKey.current === mutationDayKey
      && searchSequence.current === mutationSequence;
    const refreshSequence = viewStillCurrent ? ++searchSequence.current : mutationSequence;
    if (viewStillCurrent) {
      setAlternatives(null);
      setSelectedCandidate(null);
    }
    const replacement = response.tripPlaces.find((place) =>
      place.providerPlaceId === candidate.providerPlaceId
      && place.assignedDayId === context.dayId
      && !place.scheduled
    );
    try {
      await onChanged();
      if (viewStillCurrent
        && mounted.current
        && visibleDayKey.current === mutationDayKey
        && searchSequence.current === refreshSequence
        && replacement) {
        focusTripPlace(replacement.id);
      }
    } catch {
      if (isCurrentTripRoute()) onPersistentError?.(text.stopBackups.refreshFailed);
    } finally {
      if (mounted.current) setBusyProviderPlaceId(null);
    }
  }

  async function undoReplacement(place: WishlistPlace) {
    if (!request || !onChanged || !place.replacedStop || undoingReplacementId !== null) return;
    const relation = place.replacedStop;
    const mutationDayKey = visibleDayKey.current;
    const mutationSequence = searchSequence.current;
    const operation = `undo:${relation.replacementId}`;
    const payload = {};
    setUndoingReplacementId(relation.replacementId);
    setOperationError(null);
    onPersistentError?.("");
    try {
      await request<TripPlaceListResponse>(
        `/api/trips/${model.tripId}/stop-replacements/${relation.replacementId}/undo`,
        {
          method: "POST",
          headers: { "Idempotency-Key": retryKey(retryKeys.current, operation, payload) },
          body: JSON.stringify(payload),
          parse: parseTripPlaceListResponse,
        },
      );
    } catch (reason) {
      if (!mounted.current || !isCurrentTripRoute()) {
        if (mounted.current) setUndoingReplacementId(null);
        return;
      }
      const viewStillCurrent = visibleDayKey.current === mutationDayKey
        && searchSequence.current === mutationSequence;
      if (reason instanceof ApiRequestError && reason.code === "conflict") {
        const refreshSequence = viewStillCurrent ? ++searchSequence.current : mutationSequence;
        if (viewStillCurrent) {
          setAlternatives(null);
          setSelectedCandidate(null);
        }
        try {
          await onChanged();
          if (viewStillCurrent
            && mounted.current
            && visibleDayKey.current === mutationDayKey
            && searchSequence.current === refreshSequence) {
            setOperationError({ stopTripPlaceId: place.id, message: text.stopBackups.conflict });
          }
        } catch {
          if (isCurrentTripRoute()) onPersistentError?.(text.stopBackups.conflictRefreshFailed);
        }
      } else if (viewStillCurrent) {
        setOperationError({ stopTripPlaceId: place.id, message: text.stopBackups.outcomeUnknown });
      }
      if (mounted.current) setUndoingReplacementId(null);
      return;
    }
    retryKeys.current.delete(operation);
    if (!mounted.current || !isCurrentTripRoute()) {
      if (mounted.current) setUndoingReplacementId(null);
      return;
    }
    const viewStillCurrent = visibleDayKey.current === mutationDayKey
      && searchSequence.current === mutationSequence;
    const refreshSequence = viewStillCurrent ? ++searchSequence.current : mutationSequence;
    if (viewStillCurrent) {
      setAlternatives(null);
      setSelectedCandidate(null);
    }
    try {
      await onChanged();
      if (viewStillCurrent
        && mounted.current
        && visibleDayKey.current === mutationDayKey
        && searchSequence.current === refreshSequence) {
        focusTripPlace(relation.originalTripPlaceId);
      }
    } catch {
      if (isCurrentTripRoute()) onPersistentError?.(text.stopBackups.refreshFailed);
    } finally {
      if (mounted.current) setUndoingReplacementId(null);
    }
  }

  const detail = selectedDetail && request ? <PlaceDetailContent
    tripId={model.tripId}
    reference={selectedDetail.reference}
    date={selectedDetail.date}
    photoRevision={photoRevision}
    request={detailRequest}
    interlude={<TodayPlaceGuide
      tripId={model.tripId}
      reference={selectedDetail.reference}
      placeName={selectedDetail.name}
      request={detailRequest}
    />}
  /> : null;
  const candidateSourceUrl = selectedCandidate ? safeExternalUrl(selectedCandidate.candidate.sourceUrl) : null;
  const candidateBusy = Boolean(
    selectedCandidate
    && busyProviderPlaceId === selectedCandidate.candidate.providerPlaceId,
  );
  const candidateOperationError = selectedCandidate && operationError?.stopTripPlaceId === selectedCandidate.stopTripPlaceId
    ? operationError.message
    : null;
  const candidateDetail = selectedCandidate ? <article className="today-candidate-detail">
    <p className="today-candidate-detail__context">{text.stopBackups.replacing(selectedCandidate.stopName)}</p>
    <CandidatePhoto candidate={selectedCandidate.candidate} />
    <dl className="today-candidate-detail__facts">
      <div>
        <dt>{text.stopBackups.address}</dt>
        <dd>{selectedCandidate.candidate.address ?? text.stopBackups.addressUnavailable}</dd>
      </div>
      <div>
        <dt>{text.stopBackups.ratingLabel}</dt>
        <dd>{alternativeRating(selectedCandidate.candidate, locale, text.stopBackups)}</dd>
      </div>
      <div>
        <dt>{text.stopBackups.distanceLabel}</dt>
        <dd>{text.stopBackups.distance(new Intl.NumberFormat(locale).format(selectedCandidate.candidate.straightLineMeters))}</dd>
      </div>
      <div>
        <dt>{text.stopBackups.typeLabel}</dt>
        <dd>{placeTypeLabels[selectedCandidate.candidate.type]}</dd>
      </div>
    </dl>
    {candidateSourceUrl ? <a className="today-link" href={candidateSourceUrl} target="_blank" rel="noopener noreferrer">
      {text.stopBackups.maps}<ExternalLink size={16} aria-hidden="true" /><span className="text-xs">{text.leavesApp}</span>
    </a> : null}
    <small className="today-candidate-detail__attribution">{selectedCandidate.candidate.attribution}</small>
  </article> : null;
  const candidateFooter = selectedCandidate && canManageAlternatives ? <div className="today-candidate-detail__footer">
    {candidateOperationError ? <p role="alert">{candidateOperationError}</p> : null}
    <button
      type="button"
      disabled={busyProviderPlaceId !== null}
      aria-busy={candidateBusy}
      onClick={() => void swapAlternative(selectedCandidate.candidate)}
    >{candidateBusy ? text.stopBackups.processing : text.stopBackups.swap}</button>
    <small>{text.stopBackups.allMembersUpdate}</small>
  </div> : null;
  const formattedDay = new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", day: "numeric", weekday: "short" }).format(new Date(`${day.date}T12:00:00Z`));
  const leadItem = clock.phase === "before"
    ? firstFixed
    : selectedIsToday
      ? leadCurrent ?? leadNext
      : null;
  const navigationItem = selectedIsToday ? leadNext : null;
  const navigationPlace = navigationItem?.endpoints.find((endpoint) => endpoint.role === "start")?.place ?? null;
  const navigationUrl = navigationPlace ? googleMapsNavigationUrl(navigationPlace) : null;
  const previousMemberOrUnknown = selectedIsToday ? [...leadEligibleItems]
    .filter((item) => item.end && Date.parse(item.end) <= now)
    .sort((a, b) => Date.parse(a.end!) - Date.parse(b.end!))
    .at(-1) ?? null : null;
  // Before anything is current or has ended, the day starts from last night's stay.
  const originItem = leadCurrent ?? previousMemberOrUnknown;
  const navigationOrigin = originItem
    ? originItem.endpoints.find((endpoint) => endpoint.role === "end")?.place ?? null
    : lodgingAnchors.start?.place ?? null;
  const routeCopy = navigationItem
    ? navigationPlace
      ? navigationOrigin ? text.route(navigationOrigin.name, navigationPlace.name) : text.destinationCopy(navigationPlace.name)
      : text.locationMissing
    : null;
  const leadUsesGroupFallback = leadItem?.participants === null;
  const leadHasUnknownParticipants = leadUsesGroupFallback || navigationItem?.participants === null;

  const timed = items.filter((item) => item.start && item.end);
  const pastItems = selectedIsToday ? timed.filter((item) => Date.parse(item.end!) <= now) : [];
  const currentItems = selectedIsToday ? timed.filter((item) => Date.parse(item.start!) <= now && now < Date.parse(item.end!)) : [];
  const upcomingItems = timed.filter((item) => !pastItems.includes(item) && !currentItems.includes(item));
  const nextItem = selectedIsToday ? upcomingItems[0] ?? null : null;
  const laterItems = selectedIsToday ? upcomingItems.slice(nextItem ? 1 : 0) : upcomingItems;
  const untimedItems = items.filter((item) => !item.start || !item.end);
  const stateById: Record<string, TimelineState> = Object.fromEntries([
    ...pastItems.map((item) => [item.id, "past"] as const),
    ...currentItems.map((item) => [item.id, "current"] as const),
    ...(nextItem ? [[nextItem.id, "next"] as const] : []),
    ...laterItems.map((item) => [item.id, "later"] as const),
    ...untimedItems.map((item) => [item.id, "unscheduled"] as const),
  ]);
  const fixedByDisplayTime = items.map((item, originalIndex) => ({
    item,
    originalIndex,
    displayedInstant: itemDisplayOnDay(item, day.timeZone, day.date).displayedInstant,
  })).sort((a, b) => {
    if (a.displayedInstant === null) return b.displayedInstant === null ? a.originalIndex - b.originalIndex : 1;
    if (b.displayedInstant === null) return -1;
    return Date.parse(a.displayedInstant) - Date.parse(b.displayedInstant) || a.originalIndex - b.originalIndex;
  });
  const morningFixedIds = new Set(fixedByDisplayTime.flatMap(({ item, displayedInstant }) => {
    if (!displayedInstant || !day.timeZone || localDate(Date.parse(displayedInstant), day.timeZone) !== day.date) return [];
    const hour = Number(new Intl.DateTimeFormat("en-US", {
      timeZone: day.timeZone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(displayedInstant)));
    return hour < 12 ? [item.id] : [];
  }));
  const stopEntries: TimelineEntry[] = [
    ...fixedByDisplayTime
      .filter(({ item }) => morningFixedIds.has(item.id))
      .map(({ item }) => ({ kind: "fixed" as const, item, state: stateById[item.id] ?? "later" })),
    ...day.wishlist.map((place, placeIndex) => ({ kind: "place" as const, place, order: placeIndex + 1 })),
    ...fixedByDisplayTime
      .filter(({ item }) => !morningFixedIds.has(item.id))
      .map(({ item }) => ({ kind: "fixed" as const, item, state: stateById[item.id] ?? "later" })),
  ];
  // Anchors frame the day's stops; a day without stops stays empty rather than hotel → hotel.
  const timelineEntries: TimelineEntry[] = stopEntries.length ? [
    ...(lodgingAnchors.start ? [{ kind: "anchor" as const, edge: "start" as const, ...lodgingAnchors.start }] : []),
    ...stopEntries,
    ...(lodgingAnchors.end ? [{ kind: "anchor" as const, edge: "end" as const, ...lodgingAnchors.end }] : []),
  ] : [];
  const selectedItem = selectedItemId
    ? model.items.find((item) => item.id === selectedItemId) ?? null
    : null;
  function openItem(item: TodayItem, triggerKey = item.id) {
    itemReturnPosition.current = { x: window.scrollX, y: window.scrollY };
    itemReturnTrigger.current = triggerKey;
    setSelectedItemId(item.id);
  }
  function closeItem() {
    const trigger = itemReturnTrigger.current;
    const position = itemReturnPosition.current;
    setSelectedItemId(null);
    itemReturnPosition.current = null;
    itemReturnTrigger.current = null;
    window.requestAnimationFrame(() => {
      if (trigger) document.querySelector<HTMLElement>(`[data-today-item-trigger="${CSS.escape(trigger)}"]`)?.focus({ preventScroll: true });
      if (position) window.scrollTo({ left: position.x, top: position.y, behavior: "instant" });
    });
  }

  const datedTitle = day.title ? `${formattedDay}・${day.title}` : formattedDay;
  const heading = clock.phase === "before"
    ? text.departureBefore
    : selectedIsToday ? `${text.title}・${datedTitle}` : datedTitle;
  const headingContext = clock.phase === "before"
    ? `${text.before(clock.daysUntil)}・${datedTitle}`
    : day.timeZone ? `${text.localTime(day.timeZone)}・${text.version(model.tripVersion)}` : `${text.zoneUnknown}・${text.version(model.tripVersion)}`;
  const leadLabel = clock.phase === "before"
    ? text.departureBefore
    : clock.phase === "after"
      ? text.finished
      : clock.phase === "unknown" || !selectedIsToday
        ? text.selectedDay
        : leadUsesGroupFallback ? text.group : leadCurrent ? text.current : leadNext ? text.nextStop : text.personal;
  const leadTitle = clock.phase === "before"
    ? text.beforeTitle(clock.daysUntil, model.tripName)
    : clock.phase === "after"
      ? text.finished
      : clock.phase === "unknown" || !selectedIsToday
        ? text.selectedDayTitle(formattedDay)
        : leadCurrent
          ? leadCurrent.title
          : leadNext
            ? navigationPlace ? text.goTo(navigationPlace.name) : leadNext.title
            : personal.phase === "done" ? text.done : personal.phase === "unconfirmed" ? text.personalTimeUnknown : text.noPersonal;
  const selectedItemDay = selectedItem
    ? (day.itemIds.includes(selectedItem.id) ? day : model.days.find((entry) => entry.itemIds.includes(selectedItem.id)) ?? day)
    : day;
  // Same stop set as the cards: a stay that only frames this day is not 並行 with its stops.
  const selectedItemParallel = selectedItem
    ? selectedItemDay === day ? parallel.has(selectedItem.id) : parallelItemIds(dayItems(model, selectedItemDay)).has(selectedItem.id)
    : false;
  const emptyDay = stopEntries.length === 0;
  // 「今天玩法」 only for the trip's actual today; any other day reads 「這天玩法」.
  const dayPlanTitle = selectedIsToday ? text.dayPlanTitle : text.otherDayPlanTitle;
  const operationErrorHasRow = operationError
    ? day.wishlist.some((place) => place.id === operationError.stopTripPlaceId)
    : false;

  return <section className="today-workspace" aria-label={t.app.tabs.today}>
    <header className="today-pagehead">
      <div><h2>{heading}</h2><p>{headingContext}</p></div>
      <div className="today-headnav">
        <nav className="today-dayrow" aria-label={text.chooseDay}>
          <button type="button" aria-label={text.previous} disabled={index === 0} onClick={() => onDayChanged(model.days[index - 1]!.date)}><ArrowLeft size={16} /><span>{text.previous}</span></button>
          <NativeSelect aria-label={text.chooseDay} value={day.date} onChange={(event) => onDayChanged(event.target.value)}>{model.days.map((entry) => <option key={entry.id} value={entry.date}>{new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "numeric", day: "numeric", weekday: "short" }).format(new Date(`${entry.date}T12:00:00Z`))}</option>)}</NativeSelect>
          <button type="button" aria-label={text.nextDay} disabled={index === model.days.length - 1} onClick={() => onDayChanged(model.days[index + 1]!.date)}><span>{text.nextDay}</span><ArrowRight size={16} /></button>
        </nav>
        {offline || retrying ? (
          <div className="today-zone">
            <span />
            <button type="button" onClick={retry} disabled={retrying}>{retrying ? text.retrying : text.retry}</button>
          </div>
        ) : null}
      </div>
    </header>
    {offline ? <aside className="today-notice" role="status"><WifiOff size={20} /><div><strong>{text.offline}</strong><p>{text.offlineHelp}</p><small>{text.fetchedAt(snapshotTime)}</small></div></aside> : null}
    {!persisted ? <p className="today-notice" role="status">{text.storageUnavailable}</p> : null}
    <div className={`today-grid${emptyDay ? " is-empty" : ""}${reminderLines.length ? " has-reminder" : ""}${day.note ? " has-dayplan" : ""}`}>
      {!emptyDay ? (
      <section className="today-lead" aria-label={leadLabel}>
        <div className="today-lead-label">{clock.phase === "before" || !selectedIsToday ? <CalendarDays size={16} /> : leadCurrent ? <CircleDot size={16} /> : <MapPin size={16} />}{leadLabel}</div>
        <h3>{leadTitle}</h3>
        {clock.phase === "before" && firstFixed ? <div className="today-before-summary"><strong>{text.firstFixed}</strong><span>{firstFixed.title}</span></div> : null}
        {clock.phase === "before" && !firstFixed ? <p className="today-lead-time">{text.noFixed}</p> : null}
        {clock.phase === "unknown" ? <p className="today-lead-time">{text.unknownToday}</p> : null}
        {clock.phase === "after" ? <p className="today-lead-time">{text.finishedHelp}</p> : null}
        {clock.phase !== "before" && clock.phase !== "after" && !selectedIsToday ? <p className="today-lead-time">{text.selectedDayHelp(items.length)}</p> : null}
        {selectedIsToday && (routeCopy || leadHasUnknownParticipants) ? <div className="today-route">{routeCopy ? <><MapPin size={18} aria-hidden="true" /><span>{routeCopy}</span></> : null}{leadHasUnknownParticipants ? <><TriangleAlert size={18} aria-hidden="true" /><span>{text.participantsUnknownTimeline}</span></> : null}</div> : null}
        {((navigationUrl && navigationPlace) || leadItem) ? (
          <div className="today-lead-actions">
            {navigationUrl && navigationPlace ? <a className="today-primary-action" href={navigationUrl} target="_blank" rel="noopener noreferrer"><Navigation size={17} aria-hidden="true" />{text.navigateTo(navigationPlace.name)}</a> : null}
            {leadItem ? <button type="button" className="today-secondary-action" onClick={() => openItem(leadItem)}>{text.viewItemDetail(leadItem.title)}<ChevronRight size={17} aria-hidden="true" /></button> : null}
          </div>
        ) : null}
        {navigationUrl && offline ? <span className="today-navnote">{text.navigationOffline}</span> : null}
      </section>
      ) : null}
      {reminderLines.length ? <aside className="today-reminder" aria-label={text.tripReminder}>
        <span className="today-reminder-icon" aria-hidden="true"><BellRing size={17} /></span>
        <ul>{reminderLines.map((line) => <li key={line.key} className={line.emphasis ? "is-emphasis" : undefined}>{line.copy}</li>)}</ul>
      </aside> : null}
      {day.note ? <section className="today-dayplan" aria-label={dayPlanTitle}>
        <h3>{dayPlanTitle}</h3>
        <ClampedText key={day.id} text={day.note} lines={2} expandLabel={text.expandDayPlan} collapseLabel={text.collapseDayPlan} />
      </section> : null}
      <section ref={timelineRef} className="today-timeline" aria-label={text.group} tabIndex={-1}>
        {!operationErrorHasRow && operationError ? <p className="today-backups__operation-error today-backups__operation-error--global" role="alert">{operationError.message}</p> : null}
        {timelineEntries.length ? <>
          <div className="today-sectionhead">
            <h3>{clock.phase === "before" && index === 0 ? text.firstDayPlan : text.timeline}</h3>
            <div className="today-sectionhead-actions">
              <span>{text.itemCount(stopEntries.length)}</span>
              {day.wishlist.length && canArrange && onArrangeDay && !offline ? <button type="button" className="today-adjust-order" onClick={() => onArrangeDay(day.date)}><ListOrdered size={15} aria-hidden="true" />{text.adjustOrder}</button> : null}
            </div>
          </div>
          {pastItems.length ? <div className="today-past-label"><Clock3 size={15} aria-hidden="true" />{text.elapsedItems(pastItems.length)}</div> : null}
          <ol className="today-timeline-list">{timelineEntries.map((entry, entryIndex) => {
            const next = timelineEntries[entryIndex + 1] ?? null;
            const key = entry.kind === "place" ? `place:${entry.place.id}` : entry.kind === "anchor" ? `anchor-${entry.edge}:${entry.item.id}` : `fixed:${entry.item.id}`;
            const place = entry.kind === "place" ? entry.place : null;
            const alternativesOpen = Boolean(place && alternatives?.stopTripPlaceId === place.id);
            const canChooseAlternative = Boolean(
              place
              && canManageAlternatives
              && place.type
              && SUPPORTED_ALTERNATIVE_TYPES[place.type]
              && place.latitude !== null
              && place.longitude !== null,
            );
            const alternativesId = place ? `today-backups-${stopTriggerKey(place.id)}` : "";
            const operationMessage = place && operationError?.stopTripPlaceId === place.id
              ? operationError.message
              : null;
            const alternativeControl = place && canChooseAlternative && place.type ? <button
              type="button"
              className="today-route-backup-trigger"
              aria-label={alternativesOpen
                ? text.stopBackups.collapseNearby(place.name)
                : text.stopBackups.findNearby(place.name, placeTypeLabels[place.type])}
              aria-expanded={alternativesOpen}
              aria-controls={alternativesOpen ? alternativesId : undefined}
              onClick={alternativesOpen ? collapseAlternatives : () => void findAlternatives(place)}
            >
              <GitFork size={11} aria-hidden="true" />
              <span>{alternativesOpen ? text.stopBackups.collapse : text.stopBackups.trigger}</span>
            </button> : null;
            const alternativesPanel = place && alternativesOpen && alternatives ? <AlternativePanel
              id={alternativesId}
              state={alternatives}
              locale={locale}
              canManage={canManageAlternatives}
              busyProviderPlaceId={busyProviderPlaceId}
              error={operationMessage}
              retry={() => void findAlternatives(place)}
              openCandidate={openCandidate}
              swap={(candidate) => void swapAlternative(candidate)}
            /> : null;
            const activityControl = place && canSeeActivities && place.latitude !== null && place.longitude !== null ? <button
              type="button"
              className="today-route-backup-trigger"
              aria-label={text.nearbyActivities.open(place.name)}
              aria-haspopup="dialog"
              data-today-activities-trigger={stopTriggerKey(place.id)}
              onClick={() => void findActivities(place)}
            >
              <Sparkles size={11} aria-hidden="true" />
              <span>{text.nearbyActivities.trigger}</span>
            </button> : null;
            const legControls = [
              ...(alternativeControl ? [{ key: "backups", node: alternativeControl }] : []),
              ...(activityControl ? [{ key: "activities", node: activityControl }] : []),
            ];
            return <Fragment key={key}>
              {entry.kind === "fixed"
                ? <TodayCard item={entry.item} zone={day.timeZone} selectedDate={day.date} parallel={parallel.has(entry.item.id)} state={entry.state} onOpen={openItem} />
                : entry.kind === "anchor"
                  ? <TodayLodgingAnchor edge={entry.edge} item={entry.item} place={entry.place} onOpen={openItem} />
                  : <TodayPlaceCard
                    place={entry.place}
                    order={entry.order}
                    date={day.date}
                    preview={wishlistPreviews.previews.get(entry.place.id)}
                    previewsLoading={wishlistPreviews.loading}
                    openPlace={openPlace}
                    canManage={canManageAlternatives}
                    undoingReplacementId={undoingReplacementId}
                    operationError={operationMessage}
                    alternativesOpen={alternativesOpen}
                    undo={(currentPlace) => void undoReplacement(currentPlace)}
                  />}
              <TodayDirectionsLeg
                from={entry}
                to={next}
                zone={day.timeZone}
                selectedDate={day.date}
                controls={legControls}
                alternativesPanel={alternativesPanel}
              />
            </Fragment>;
          })}</ol>
        </> : <>
          <div className="today-empty">
            <CalendarDays size={28} aria-hidden="true" />
            <h3>{text.empty}</h3>
            <p>{text.emptyHelp}</p>
            {canArrange === false ? <p>{t.schedule.ownerOnly}</p> : null}
            {onArrangeDay && !offline ? <button type="button" className="today-primary-action" onClick={() => onArrangeDay(day.date)}><CalendarDays size={17} aria-hidden="true" />{text.adjustOrder}</button> : null}
          </div>
        </>}
      </section>
    </div>
    <p className="today-last-sync">{text.syncedAt(snapshotTime)}</p>
    <PlaceDetailSheet
      appearance="workspace"
      open={Boolean(selectedItem) && !selectedDetail && !selectedCandidate && !activities}
      title={selectedItem?.title ?? ""}
      onClose={closeItem}
    >
      {selectedItem ? <TodayItemDetails item={selectedItem} now={now} parallel={selectedItemParallel} memberId={model.memberId} date={selectedItemDay.date} previews={endpointPreviews.previews} previewsLoading={endpointPreviews.loading} openPlace={openPlace} /> : null}
    </PlaceDetailSheet>
    <PlaceDetailSheet
      open={Boolean(selectedDetail)}
      title={selectedDetail ? text.detailTitle(selectedDetail.name) : ""}
      titleRef={detailTitleRef}
      onClose={closeDetail}
    >
      {detail}
    </PlaceDetailSheet>
    <PlaceDetailSheet
      open={Boolean(selectedCandidate)}
      title={selectedCandidate ? text.detailTitle(selectedCandidate.candidate.name) : ""}
      onClose={closeCandidate}
      footer={candidateFooter}
    >
      {candidateDetail}
    </PlaceDetailSheet>
    <PlaceDetailSheet
      appearance="workspace"
      open={Boolean(activities)}
      title={activities ? text.nearbyActivities.title(activities.stopName) : ""}
      onClose={closeActivities}
    >
      {activities ? <NearbyActivitiesContent
        state={activities}
        timeZone={day.timeZone}
        todayDate={clock.phase === "during" ? clock.today?.date ?? null : null}
        retry={() => {
          const place = day.wishlist.find((entry) => entry.id === activities.stopTripPlaceId);
          if (place) void findActivities(place);
        }}
      /> : null}
    </PlaceDetailSheet>
  </section>;
}
