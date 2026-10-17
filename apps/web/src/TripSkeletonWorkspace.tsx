import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Temporal } from "@js-temporal/polyfill";
import type { TripDto } from "@along-the-way/contracts/private-trips";
import {
  parseTripPlaceListResponse,
  type TripPlaceDto,
  type TripPlaceListResponse,
} from "@along-the-way/contracts/trip-places";
import {
  parseItineraryItemResponse,
  parsePlaceResponse,
  parseTripSkeletonResponse,
  type ConstraintDto,
  type ConstraintStatus,
  type ItineraryItemDto,
  type PlaceDto,
  type TripSkeletonDto,
  type TripSkeletonResponse,
  type UpdateItineraryItemInput,
  type UpdatePlaceInput,
  type ZonedEndpointDto,
} from "@along-the-way/contracts/trip-skeleton";
import { BedDouble, CalendarClock, CalendarDays, CalendarMinus, CalendarPlus, ChevronDown, Clock3, GripVertical, Lock, Luggage, MapPin, MapPinOff, Plus, Route, StickyNote, Trash2, Unlock } from "lucide-react";
import { parseDayRouteResponse, type DayRouteResponse } from "@along-the-way/contracts/day-plans";
import { lodgingForNight } from "@along-the-way/contracts/day-time-zone";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DayPlanDialog, type PlannedDay } from "./DayPlanDialog";
import { ItineraryItemDialog } from "./ItineraryItemDialog";
import { PlaceDialog } from "./PlaceDialog";
import { useI18n, type Messages } from "./i18n";
import { canArrangeItinerary } from "./trip-permissions";
import { ApiRequestError } from "./api-error";
import { safeExternalUrl } from "./external-url";
import "./plan-route.css";
import { PlaceDetailSheet } from "./PlaceDetailSheet";
import { readTripOverviewFilter, TRIP_OVERVIEW_FILTER_CHANGE_EVENT, writeTripOverviewFilter } from "./trip-location";

interface RequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}


type JsonRequest = <T>(url: string, options?: RequestOptions) => Promise<T>;

interface TripSkeletonWorkspaceProps {
  trip: TripDto;
  request: JsonRequest;
  placesRevision: number;
  onPlacesChanged(): void;
  onTravelEdit(type: "flight" | "lodging"): void;
}


function localEndpoint(endpoint: ZonedEndpointDto, places: Map<string, PlaceDto>, t: Messages["tripSkeleton"]) {
  const place = places.get(endpoint.placeId);
  const abbreviation = new Intl.DateTimeFormat("en-US", {
    timeZone: endpoint.timeZone,
    timeZoneName: "short",
  }).formatToParts(new Date(endpoint.instant)).find((part) => part.type === "timeZoneName")?.value;
  return `${endpoint.localDateTime.replace("T", " ")} · ${endpoint.timeZone} (${abbreviation ?? endpoint.utcOffset}, ${endpoint.utcOffset}) · ${place?.name ?? t.unknownPlace}`;
}

function itemEndpoint(item: ItineraryItemDto, role: ZonedEndpointDto["role"]) {
  return item.endpoints.find((endpoint) => endpoint.role === role);
}
// Temporal instants are limited to ±10^8 days from the epoch.
const MAX_EPOCH_NANOSECONDS = 8_640_000_000_000_000_000_000n;

function displayedEndEndpoint(
  item: ItineraryItemDto,
  start: ZonedEndpointDto | undefined,
) {
  const explicitEnd = itemEndpoint(item, "end");
  if (explicitEnd || !start) return explicitEnd;
  let durationMinutes: number;
  switch (item.type) {
    case "reservation":
    case "meal":
    case "activity":
    case "free-time":
      durationMinutes = item.details.durationMinutes;
      break;
    default:
      return undefined;
  }
  const endNanoseconds = Temporal.Instant.from(start.instant).epochNanoseconds
    + BigInt(durationMinutes) * 60_000_000_000n;
  // Data written before the trip-range rule may exceed Temporal's range; report it on this card only.
  if (endNanoseconds > MAX_EPOCH_NANOSECONDS || endNanoseconds < -MAX_EPOCH_NANOSECONDS) {
    return "unrepresentable" as const;
  }
  const instant = Temporal.Instant.fromEpochNanoseconds(endNanoseconds);
  const local = instant.toZonedDateTimeISO(start.timeZone);
  return {
    ...start,
    role: "end" as const,
    localDateTime: local.toPlainDateTime().toString({ smallestUnit: "minute" }),
    utcOffset: local.offset,
    instant: instant.toString(),
  };
}




function itemDetails(item: ItineraryItemDto, t: Messages["tripSkeleton"]) {
  switch (item.type) {
    case "flight":
      return [item.details.carrier, item.details.serviceNumber, item.details.confirmationNotes].filter(Boolean).join("・");
    case "lodging":
      return [
        item.details.bookedBy ? t.bookedBy(item.details.bookedBy) : null,
        item.details.confirmationCode ? t.confirmation(item.details.confirmationCode) : null,
      ].filter(Boolean).join("・");
    case "transport":
      return [item.details.mode, item.details.ticketInfo].filter(Boolean).join("・");
    case "reservation":
    case "meal":
    case "activity":
      return [
        t.durationMinutes(item.details.durationMinutes),
        item.details.bookedBy ? t.bookedBy(item.details.bookedBy) : null,
        item.details.confirmationStatus,
      ].filter(Boolean).join("・");
    case "free-time":
      return t.durationMinutes(item.details.durationMinutes);
  }
}
function ParticipantSummary({ item }: { item: ItineraryItemDto }) {
  const { t } = useI18n();
  return (
    <div className="mt-3 text-sm" aria-label={t.tripSkeleton.participants}>
      <strong>{t.tripSkeleton.participantsLabel}</strong>{" "}
      {item.participants === null ? (
        <span className="text-muted-foreground">{t.tripSkeleton.participantsPending}</span>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {item.participants.map((participant) => (
            <li key={participant.memberId} className="min-w-0 [overflow-wrap:anywhere]">
              {participant.displayName ?? participant.email ?? (participant.removed ? "前成員" : "成員")}
              {participant.removed ? `・${t.tripSkeleton.participantRemoved}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


function ConstraintBadge({ constraint }: { constraint: ConstraintDto }) {
  const { t } = useI18n();
  return (
    <span
      className="inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-bold"
      data-status={constraint.status}
    >
      {t.tripSkeleton.constraintTypes[constraint.type]}
      {constraint.type === "minimum_buffer" && constraint.minimumBufferMinutes !== null
        ? ` ${t.tripSkeleton.minimumBufferMinutes(constraint.minimumBufferMinutes)}`
        : ""}
      {`・${t.tripSkeleton.constraintStatuses[constraint.status]}`}
    </span>
  );
}

function formatMinorAmount(amountMinor: number, currency: string, locale: string) {
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amountMinor / (10 ** fractionDigits));
}


function formatPlanDate(date: string, locale: string) {
  const instant = new Date(`${date}T00:00:00Z`);
  const calendarDate = new Intl.DateTimeFormat(locale, {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(instant);
  const weekday = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    timeZone: "UTC",
  }).format(instant);
  return `${calendarDate}（${weekday}）`;
}

function formatPlanShortDate(date: string, locale: string) {
  const instant = new Date(`${date}T00:00:00Z`);
  return {
    date: new Intl.DateTimeFormat(locale, {
      month: "numeric",
      day: "numeric",
      timeZone: "UTC",
    }).format(instant),
    weekday: new Intl.DateTimeFormat(locale, {
      weekday: "short",
      timeZone: "UTC",
    }).format(instant),
  };
}

/** A place row being dragged by its handle, and where it would land if released now. */
interface PlaceDrag {
  placeId: string;
  name: string;
  fromDayId: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  /** Past the tap slop: only then does a drop move anything. */
  moved: boolean;
  targetDayId: string;
  /** Index among the target day's untimed places, the dragged place excluded. */
  targetIndex: number;
}

/** Applied route order first; places without one keep their list order at the end. */
function byDayPosition(left: TripPlaceDto, right: TripPlaceDto) {
  if (left.dayPosition === right.dayPosition) return 0;
  if (left.dayPosition === null) return 1;
  if (right.dayPosition === null) return -1;
  return left.dayPosition - right.dayPosition;
}

function defaultAssignmentDayId(
  place: TripPlaceDto,
  days: TripSkeletonDto["days"],
) {
  if (days.length === 0) return null;
  const priorDate = place.unplacedFromDate;
  if (priorDate === null) return days[0]!.id;
  let nextDay: TripSkeletonDto["days"][number] | undefined;
  for (const day of days) {
    if (
      day.date > priorDate
      && (nextDay === undefined || day.date < nextDay.date)
    ) {
      nextDay = day;
    }
  }
  return nextDay?.id ?? days[0]!.id;
}

function DayAssignmentPicker({
  places,
  busyPlaceId,
  errorPlaceId,
  error,
  assign,
  editLocation,
}: {
  places: TripPlaceDto[];
  busyPlaceId: string | null;
  errorPlaceId: string | null;
  error: string;
  assign(place: TripPlaceDto): Promise<void>;
  editLocation(place: TripPlaceDto): ReactNode;
}) {
  const { t, locale } = useI18n();
  const pending = places.filter((place) =>
    place.selectedForItinerary && !place.scheduled && place.assignedDayId === null
  );
  const pocket = places.filter((place) =>
    !place.selectedForItinerary && !place.scheduled && place.assignedDayId === null
  );
  const errorHasVisibleRow = errorPlaceId !== null
    && (pending.some((place) => place.id === errorPlaceId)
      || pocket.some((place) => place.id === errorPlaceId));


  function sourceRows(source: "pending" | "pocket", sourcePlaces: TripPlaceDto[]) {
    return (
      <ul className="plan-source-list">
        {sourcePlaces.map((place) => {
          const blocked = place.latitude === null || place.longitude === null;
          const rowBusy = busyPlaceId === place.id;
          return (
            <li key={place.id} className="plan-source-row">
              <div className="plan-place-main">
                <div className="plan-place-name">
                  <strong>{place.name}</strong>
                  <span className="plan-kind-chip">{t.tripSkeleton.placeTypes[place.type]}</span>
                </div>
                <div className="plan-place-meta">
                  <span className="plan-place-status">
                    {blocked ? <MapPinOff aria-hidden="true" /> : <CalendarClock aria-hidden="true" />}
                    {blocked
                      ? t.tripSkeleton.locationRequired
                      : source === "pending"
                        ? t.tripSkeleton.pendingArrangement
                        : t.tripSkeleton.notScheduled}
                  </span>
                  {source === "pending" ? (
                    <span>
                      {place.unplacedFromDate === null
                        ? t.tripSkeleton.priorDateUnknown
                        : t.tripSkeleton.priorDate(formatPlanDate(place.unplacedFromDate, locale))}
                    </span>
                  ) : null}
                  <span>
                    {place.durationMinutes
                      ? t.tripSkeleton.plannedDuration(place.durationMinutes)
                      : t.tripSkeleton.durationUnknown}
                  </span>
                </div>
              </div>
              {blocked ? editLocation(place) : (
                <button
                  type="button"
                  className="plan-schedule-button"
                  disabled={busyPlaceId !== null}
                  onClick={() => void assign(place)}
                >
                  <CalendarPlus aria-hidden="true" />
                  {rowBusy ? t.tripSkeleton.scheduling : t.tripSkeleton.scheduleThisDay}
                </button>
              )}
              {errorPlaceId === place.id && error ? (
                <p role="alert" className="plan-row-error">{error}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <>
      {errorPlaceId !== null && error && !errorHasVisibleRow ? (
        <p role="alert" className="plan-row-error">{error}</p>
      ) : null}
      <section className="plan-source">
        <h3>{t.tripSkeleton.pendingSourceTitle}</h3>
        <p>{t.tripSkeleton.pendingSourceHelper}</p>
        {pending.length === 0 ? (
          <div className="plan-source-empty">
            <CalendarDays aria-hidden="true" />
            <span>{t.tripSkeleton.pendingSourceEmpty}</span>
          </div>
        ) : sourceRows("pending", pending)}
      </section>
      <section className="plan-source">
        <h3>{t.tripSkeleton.pocketSourceTitle}</h3>
        <p>{t.tripSkeleton.pocketSourceHelper}</p>
        {pocket.length === 0 ? (
          <div className="plan-source-empty">
            <MapPin aria-hidden="true" />
            <span>{t.tripSkeleton.noAvailableWishlistPlaces}</span>
          </div>
        ) : sourceRows("pocket", pocket)}
      </section>
    </>
  );
}

export function TripSkeletonWorkspace({
  trip,
  request,
  placesRevision,
  onPlacesChanged,
  onTravelEdit,
}: TripSkeletonWorkspaceProps) {
  const { t, locale } = useI18n();
  // Owner always; editors when the owner turned on 「編輯者可以安排行程」.
  const canArrange = canArrangeItinerary(trip);
  const [overviewFilter, setOverviewFilter] = useState(readTripOverviewFilter);
  const [skeleton, setSkeleton] = useState<TripSkeletonDto | null>(null);
  const [tripPlaces, setTripPlaces] = useState<TripPlaceDto[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [unlockingItem, setUnlockingItem] = useState<ItineraryItemDto | null>(null);
  const [planningDay, setPlanningDay] = useState<PlannedDay | null>(null);
  const [viewingItem, setViewingItem] = useState<{ itemId: string; continuation: boolean } | null>(null);
  const [assignmentDayId, setAssignmentDayId] = useState<string | null>(null);
  const [assignmentErrorPlaceId, setAssignmentErrorPlaceId] = useState<string | null>(null);
  const assignmentErrorPlaceIdRef = useRef<string | null>(null);
  const [viewingAssignedPlaceId, setViewingAssignedPlaceId] = useState<string | null>(null);
  const [repairingPlaceId, setRepairingPlaceId] = useState<string | null>(null);
  const viewingAssignedPlace = viewingAssignedPlaceId ? tripPlaces.find((place) => place.id === viewingAssignedPlaceId) : undefined;
  const repairingPlace = repairingPlaceId ? tripPlaces.find((place) => place.id === repairingPlaceId) : undefined;
  const actionKeys = useRef(new Map<string, string>());
  const editorOpen = useRef(false);
  const latestSkeleton = useRef<TripSkeletonDto | null>(null);
  const loadGeneration = useRef(0);
  const updateAssignmentErrorPlaceId = useCallback((placeId: string | null) => {
    assignmentErrorPlaceIdRef.current = placeId;
    setAssignmentErrorPlaceId(placeId);
  }, []);


  const editingChanged = useCallback((open: boolean) => {
    editorOpen.current = open;
    if (!open && latestSkeleton.current) setSkeleton(latestSkeleton.current);
  }, []);
  async function readForConflict() {
    const latest = parseTripSkeletonResponse(await request(`/api/trips/${trip.id}/skeleton`)).skeleton;
    latestSkeleton.current = latest;
    return latest;
  }

  function actionKey(identity: string) {
    const existing = actionKeys.current.get(identity);
    if (existing) return existing;
    const created = crypto.randomUUID();
    actionKeys.current.set(identity, created);
    return created;
  }

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      const [skeletonResponse, tripPlaceResponse] = await Promise.all([
        request<TripSkeletonResponse>(
          `/api/trips/${trip.id}/skeleton`,
          { parse: parseTripSkeletonResponse },
        ),
        request<TripPlaceListResponse>(
          `/api/trips/${trip.id}/trip-places`,
          { parse: parseTripPlaceListResponse },
        ),
      ]);
      if (generation !== loadGeneration.current) return;
      latestSkeleton.current = skeletonResponse.skeleton;
      // Keep an open editor mounted if another member moves, locks or deletes its row.
      if (!editorOpen.current) setSkeleton(skeletonResponse.skeleton);
      setTripPlaces(tripPlaceResponse.tripPlaces);
      if (assignmentErrorPlaceIdRef.current === null) setError("");
    } catch (reason) {
      if (generation !== loadGeneration.current) return;
      if (assignmentErrorPlaceIdRef.current === null) {
        setError(reason instanceof Error ? reason.message : t.tripSkeleton.loadError);
      }
    }
  }, [request, t, trip.id]);

  // Only another trip blanks the itinerary. A place change reloads behind the current page:
  // blanking it would shorten the page and drop the reader's scroll position.
  useEffect(() => {
    setSkeleton(null);
    setTripPlaces([]);
  }, [trip.id]);

  useEffect(() => {
    void load();
  }, [load, placesRevision]);

  useEffect(() => {
    const synchronizeOverviewFilter = () => setOverviewFilter(readTripOverviewFilter());
    window.addEventListener("popstate", synchronizeOverviewFilter);
    window.addEventListener(TRIP_OVERVIEW_FILTER_CHANGE_EVENT, synchronizeOverviewFilter);
    return () => {
      window.removeEventListener("popstate", synchronizeOverviewFilter);
      window.removeEventListener(TRIP_OVERVIEW_FILTER_CHANGE_EVENT, synchronizeOverviewFilter);
    };
  }, []);

  // After a filter change the shown days fade and slide in one after another, so the list
  // visibly changes instead of jumping; days the filter hides simply leave.
  const filterSignature = overviewFilter.days.join(",");
  const previousFilterSignature = useRef(filterSignature);
  useEffect(() => {
    if (previousFilterSignature.current === filterSignature) return;
    previousFilterSignature.current = filterSignature;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    document.querySelectorAll<HTMLElement>(".plan-workspace .day-column")
      .forEach((element, index) => element.animate?.(
        [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }],
        { duration: 250, delay: Math.min(index, 6) * 40, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "backwards" },
      ));
  }, [filterSignature]);

  useEffect(() => {
    if (!skeleton) return;
    const url = new URL(window.location.href);
    const repairPlaceId = url.searchParams.get("repair");
    if (!repairPlaceId) return;
    const place = tripPlaces.find((entry) => entry.id === repairPlaceId);
    if (!place) return;
    setRepairingPlaceId(place.id);
    url.searchParams.delete("repair");
    window.history.replaceState({}, "", url);
  }, [skeleton, tripPlaces]);



  const placesById = useMemo(
    () => new Map(skeleton?.places.map((place) => [place.id, place]) ?? []),
    [skeleton?.places],
  );
  const itemsById = useMemo(
    () => new Map(skeleton?.items.map((item) => [item.id, item]) ?? []),
    [skeleton?.items],
  );

  async function savePlace(input: UpdatePlaceInput, place: PlaceDto, conflictBase?: number) {
    if (!skeleton) throw new Error(t.tripSkeleton.loadingError);
    const updateIdentity = `update-place:${place.id}:${JSON.stringify(input)}`;
    await request(
      `/api/trips/${trip.id}/places/${place.id}`,
      {
        method: "PATCH",
        headers: {
          "Idempotency-Key": actionKey(updateIdentity),
          ...(conflictBase ? { "Conflict-Base-Version": String(conflictBase) } : {}),
        },
        body: JSON.stringify(input),
        parse: parsePlaceResponse,
      },
    );
    actionKeys.current.delete(updateIdentity);
    await load();
    onPlacesChanged();
  }

  function renderLocationEditor(tripPlace: TripPlaceDto, initiallyOpen = false) {
    const place = tripPlace.legacyPlaceId ? placesById.get(tripPlace.legacyPlaceId) : undefined;
    if (!place) {
      return <p className="plan-location-recovery-note">{t.tripSkeleton.locationRecoveryHelper}</p>;
    }
    return (
      <PlaceDialog
        place={place}
        initiallyOpen={initiallyOpen}
        editingChanged={(open) => {
          editingChanged(open);
          if (!open && initiallyOpen) setRepairingPlaceId(null);
        }}
        focusLocationOnOpen
        triggerClassName={initiallyOpen ? "sr-only" : "plan-schedule-button"}
        triggerDisabled={busyId !== null}
        triggerLabel={(
          <>
            <MapPinOff aria-hidden="true" />
            {t.tripSkeleton.completeLocation}
          </>
        )}
        load={async () =>
          (await readForConflict()).places.find((entry) => entry.id === place.id) ?? null
        }
        save={(input, conflictBase) => savePlace(input, place, conflictBase)}
      />
    );
  }


  async function saveItem(input: UpdateItineraryItemInput, item: ItineraryItemDto, conflictBase?: number) {
    if (!skeleton) throw new Error(t.tripSkeleton.loadingError);
    const updateIdentity = `update-item:${item.id}:${JSON.stringify(input)}`;
    await request(
      `/api/trips/${trip.id}/items/${item.id}`,
      {
        method: "PATCH",
        headers: {
          "Idempotency-Key": actionKey(updateIdentity),
          ...(conflictBase ? { "Conflict-Base-Version": String(conflictBase) } : {}),
        },
        body: JSON.stringify(input),
        parse: parseItineraryItemResponse,
      },
    );
    actionKeys.current.delete(updateIdentity);
    await load();
    onPlacesChanged();
  }

  async function itemAction(item: ItineraryItemDto, action: "lock" | "unlock" | "delete") {
    const identity = `${action}-item:${item.id}:${item.version}`;
    setBusyId(item.id);
    setError("");
    try {
      if (action === "delete") {
        await request(`/api/trips/${trip.id}/items/${item.id}`, {
          method: "DELETE",
          headers: { "Idempotency-Key": actionKey(identity) },
          body: JSON.stringify({ expectedVersion: item.version }),
        });
      } else {
        await request(`/api/trips/${trip.id}/items/${item.id}/${action}`, {
          method: "POST",
          headers: { "Idempotency-Key": actionKey(identity) },
          body: JSON.stringify({ expectedVersion: item.version }),
          parse: parseItineraryItemResponse,
        });
      }
      actionKeys.current.delete(identity);
      setUnlockingItem(null);
      await load();
      onPlacesChanged();
    } catch (reason) {
      setError(reason instanceof Error
        ? reason.message
        : t.tripSkeleton.itemActionError(t.tripSkeleton.actionNames[action]));
    } finally {
      setBusyId(null);
    }
  }

  async function setConstraintStatus(item: ItineraryItemDto, constraint: ConstraintDto, status: ConstraintStatus) {
    const identity = `update-constraint:${constraint.id}:${constraint.version}:${status}`;
    setBusyId(constraint.id);
    try {
      await request(`/api/trips/${trip.id}/items/${item.id}/constraints/${constraint.id}`, {
        method: "PATCH",
        headers: { "Idempotency-Key": actionKey(identity) },
        body: JSON.stringify({
          type: constraint.type,
          status,
          minimumBufferMinutes: constraint.minimumBufferMinutes,
          expectedItemVersion: item.version,
          expectedVersion: constraint.version,
        }),
        parse: parseItineraryItemResponse,
      });
      actionKeys.current.delete(identity);
      await load();
      onPlacesChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.tripSkeleton.constraintUpdateError);
    } finally {
      setBusyId(null);
    }
  }

  async function updateDayAssignment(
    tripDayId: string | null,
    place: TripPlaceDto,
  ) {
    if (!canArrange) {
      setError(t.schedule.ownerOnlyAction);
      updateAssignmentErrorPlaceId(place.id);
      return false;
    }
    const operation = `day-assignment:${place.id}`;
    setBusyId(operation);
    setError("");
    updateAssignmentErrorPlaceId(null);
    let removedOriginalDay = false;
    try {
      async function assign(targetDayId: string | null, expectedVersion: number) {
        const payload = {
          assignments: [{
            tripPlaceId: place.id,
            tripDayId: targetDayId,
            expectedVersion,
          }],
        };
        const identity = `${operation}:${targetDayId ?? "none"}:${expectedVersion}`;
        const response = await request<TripPlaceListResponse>(
          `/api/trips/${trip.id}/trip-place-day-assignments`,
          {
            method: "PUT",
            headers: { "Idempotency-Key": actionKey(identity) },
            body: JSON.stringify(payload),
            parse: parseTripPlaceListResponse,
          },
        );
        actionKeys.current.delete(identity);
        const updated = response.tripPlaces.find((entry) => entry.id === place.id);
        if (!updated) throw new Error(t.tripSkeleton.plannedDayUpdateError);
        // A mutation response is newer than every read already in flight.
        loadGeneration.current += 1;
        setTripPlaces(response.tripPlaces);
        // A removed assignment no longer belongs to this sheet; keep another opened place untouched.
        setViewingAssignedPlaceId((current) =>
          response.tripPlaces.find((entry) => entry.id === current)?.assignedDayId ? current : null
        );
        return updated;
      }

      let current = place;
      // The versioned API requires removal before moving between two assigned days.
      // Do not remove an unassigned place, and use the server-returned version for step two.
      if (current.assignedDayId && tripDayId && current.assignedDayId !== tripDayId) {
        current = await assign(null, current.version);
        removedOriginalDay = true;
      }
      if (current.assignedDayId !== tripDayId) {
        await assign(tripDayId, current.version);
      }
      onPlacesChanged();
      return true;
    } catch (reason) {
      const forbidden = reason instanceof ApiRequestError
        && (reason.code === "forbidden" || reason.status === 403);
      const failure = forbidden
        ? t.schedule.ownerOnlyAction
        : reason instanceof Error
          ? reason.message
          : t.tripSkeleton.plannedDayUpdateError;
      const assignmentError = removedOriginalDay && !forbidden
        ? t.tripSkeleton.removedBeforeReassignError(failure)
        : failure;
      if (reason instanceof ApiRequestError && reason.code === "conflict") {
        await load();
      }
      // Keep the mutation failure visible after a conflict refresh replaces the stale row/version.
      setError(assignmentError);
      updateAssignmentErrorPlaceId(place.id);
      if (removedOriginalDay) onPlacesChanged();
      return false;
    } finally {
      setBusyId(null);
    }
  }

  /** Untimed places of a day in their applied order: the rows that can be dragged. */
  function dayPlaces(dayId: string) {
    return tripPlaces.filter((place) => !place.scheduled && place.assignedDayId === dayId).sort(byDayPosition);
  }

  async function saveDayOrder(dayId: string, orderedTripPlaceIds: string[]) {
    const operation = `day-order:${dayId}`;
    setBusyId(operation);
    setError("");
    updateAssignmentErrorPlaceId(null);
    // Show the new order at once; a failure reloads the server's order.
    setTripPlaces((current) => current.map((place) => {
      const index = orderedTripPlaceIds.indexOf(place.id);
      return index < 0 ? place : { ...place, dayPosition: index };
    }));
    try {
      // The order writer uses the day's route version for optimistic concurrency.
      const { route } = await request<DayRouteResponse>(`/api/trips/${trip.id}/days/${dayId}/route`, {
        method: "POST",
        body: JSON.stringify({ order: "current" }),
        parse: parseDayRouteResponse,
      });
      const identity = `${operation}:${route.version}:${orderedTripPlaceIds.join(",")}`;
      await request<{ orderedTripPlaceIds: string[]; version: number }>(
        `/api/trips/${trip.id}/days/${dayId}/place-order`,
        {
          method: "PUT",
          headers: { "Idempotency-Key": actionKey(identity) },
          body: JSON.stringify({ orderedTripPlaceIds, expectedVersion: route.version }),
        },
      );
      actionKeys.current.delete(identity);
      onPlacesChanged();
    } catch (reason) {
      // Reload first: a successful reload clears errors, and this one must stay on screen.
      await load();
      setError(reason instanceof ApiRequestError && (reason.code === "forbidden" || reason.status === 403)
        ? t.schedule.ownerOnlyAction
        : reason instanceof Error ? reason.message : t.tripSkeleton.dragOrderError);
    } finally {
      setBusyId(null);
    }
  }

  /** Drops `place` at `index` among the target day's other untimed places. */
  async function movePlace(place: TripPlaceDto, targetDayId: string, index: number) {
    const others = dayPlaces(targetDayId).filter((entry) => entry.id !== place.id).map((entry) => entry.id);
    const ordered = [...others.slice(0, index), place.id, ...others.slice(index)];
    if (place.assignedDayId === targetDayId) {
      const before = dayPlaces(targetDayId).map((entry) => entry.id);
      if (before.join() !== ordered.join()) await saveDayOrder(targetDayId, ordered);
      return;
    }
    if (!await updateDayAssignment(targetDayId, place)) return;
    if (ordered.length > 1) await saveDayOrder(targetDayId, ordered);
  }

  // Pointer drag on a row's handle (mouse, pen and touch alike). The row stays in place,
  // dimmed; a line marks where it will land and a label follows the pointer.
  const [drag, setDrag] = useState<PlaceDrag | null>(null);
  const dragRef = useRef<PlaceDrag | null>(null);
  const autoScroll = useRef<number | null>(null);

  function updateDrag(next: PlaceDrag | null) {
    dragRef.current = next;
    setDrag(next);
  }

  function dropTarget(x: number, y: number, placeId: string): Pick<PlaceDrag, "targetDayId" | "targetIndex"> | null {
    const list = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-day]");
    if (!list?.dataset.dropDay) return null;
    const rows = [...list.querySelectorAll<HTMLElement>("[data-drag-place]")]
      .filter((row) => row.dataset.dragPlace !== placeId);
    const index = rows.filter((row) => {
      const box = row.getBoundingClientRect();
      return box.top + box.height / 2 < y;
    }).length;
    return { targetDayId: list.dataset.dropDay, targetIndex: index };
  }

  function stopAutoScroll() {
    if (autoScroll.current !== null) cancelAnimationFrame(autoScroll.current);
    autoScroll.current = null;
  }

  // Near the top or bottom edge the page scrolls, so a place can reach a day off screen.
  function runAutoScroll() {
    const current = dragRef.current;
    if (!current?.moved) { stopAutoScroll(); return; }
    const edge = 88;
    const speed = current.y < edge ? -(edge - current.y) / 4 : current.y > window.innerHeight - edge ? (current.y - window.innerHeight + edge) / 4 : 0;
    if (speed !== 0) {
      window.scrollBy(0, speed);
      const target = dropTarget(current.x, current.y, current.placeId);
      if (target) updateDrag({ ...current, ...target });
    }
    autoScroll.current = requestAnimationFrame(runAutoScroll);
  }

  function dragHandlers(place: TripPlaceDto, dayId: string, index: number) {
    return {
      // Move/up are followed on the window: re-rendering rows during the drag must not lose them.
      onPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
        if (!canArrange || busyId !== null || event.button !== 0) return;
        event.preventDefault();
        updateDrag({
          placeId: place.id, name: place.name, fromDayId: dayId, startX: event.clientX, startY: event.clientY,
          x: event.clientX, y: event.clientY, moved: false, targetDayId: dayId, targetIndex: index,
        });
        const pointerId = event.pointerId;
        const move = (moveEvent: PointerEvent) => {
          const current = dragRef.current;
          if (moveEvent.pointerId !== pointerId || !current) return;
          // A small slop keeps a tap on the handle from counting as a drag.
          const moved = current.moved || Math.hypot(moveEvent.clientX - current.startX, moveEvent.clientY - current.startY) > 6;
          const target = moved ? dropTarget(moveEvent.clientX, moveEvent.clientY, place.id) : null;
          updateDrag({ ...current, x: moveEvent.clientX, y: moveEvent.clientY, moved, ...(target ?? {}) });
          if (moved && autoScroll.current === null) autoScroll.current = requestAnimationFrame(runAutoScroll);
        };
        const finish = (endEvent: PointerEvent) => {
          if (endEvent.pointerId !== pointerId) return;
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", finish);
          window.removeEventListener("pointercancel", finish);
          const current = dragRef.current;
          stopAutoScroll();
          updateDrag(null);
          if (endEvent.type === "pointerup" && current?.moved) void movePlace(place, current.targetDayId, current.targetIndex);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", finish);
      },
      // Keyboard: ↑/↓ move the place one row within its day.
      onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
        if (!canArrange || busyId !== null) return;
        const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
        if (step === 0) return;
        event.preventDefault();
        const next = index + step;
        if (next < 0 || next >= dayPlaces(dayId).length) return;
        // Reordering moves the row's DOM node, which drops focus; put it back on this handle.
        void movePlace(place, dayId, next).then(() => requestAnimationFrame(() =>
          document.querySelector<HTMLButtonElement>(`[data-drag-place="${place.id}"] .plan-drag-handle`)?.focus()));
      },
    };
  }

  function itemDetail(item: ItineraryItemDto, continuation = false) {
    const start = itemEndpoint(item, "start");
    const end = displayedEndEndpoint(item, start);
    const sourceHref = safeExternalUrl(item.sourceUrl);
    return (
      <article key={`${item.id}-${continuation ? "continuation" : "full"}`} className="itinerary-card" data-item-id={item.id}>
        {error ? <p role="alert" className="pd-notice">{error}</p> : null}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.14em] text-accent-strong">
              {t.tripSkeleton.itemTypes[item.type]}{continuation ? `・${t.tripSkeleton.continues}` : ""}
            </p>
            <h4 className="mt-1 font-display text-xl text-ink-strong">{item.title}</h4>
          </div>
          {item.lockedAt ? <span className="locked-badge"><Lock className="size-3.5" /> {t.tripSkeleton.locked}</span> : null}
        </div>
        <div className="mt-3 grid gap-1 text-sm text-muted-foreground">
          {start ? <p><strong>{t.tripSkeleton.start}</strong> {localEndpoint(start, placesById, t.tripSkeleton)}</p> : null}
          {end === "unrepresentable" ? (
            <p><strong>{t.tripSkeleton.end}</strong> {t.tripSkeleton.unsupportedEndDate}</p>
          ) : end ? (
            <p><strong>{t.tripSkeleton.end}</strong> {localEndpoint(end, placesById, t.tripSkeleton)}</p>
          ) : null}
        </div>
        <ParticipantSummary item={item} />
        {!continuation ? (
          <>
            <p className="mt-3 text-sm">{itemDetails(item, t.tripSkeleton)}</p>
            {item.money ? (
              <p className="mt-2 text-sm font-semibold">{formatMinorAmount(item.money.amountMinor, item.money.currency, locale)}</p>
            ) : null}
            {item.constraints.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {item.constraints.map((constraint) => <ConstraintBadge key={constraint.id} constraint={constraint} />)}
              </div>
            ) : null}
            {item.notes ? <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{item.notes}</p> : null}
            {item.sourceUrl
              ? sourceHref
                ? <a className="mt-2 inline-block text-sm font-semibold text-accent-strong underline" href={sourceHref} rel="noreferrer" target="_blank">{t.tripSkeleton.officialSource}</a>
                : <span className="mt-2 inline-block text-sm font-semibold">{t.tripSkeleton.officialSource}</span>
              : null}
            <div className="mt-4 flex flex-wrap gap-2">
              {item.lockedAt ? (
                trip.role === "owner" ? (
                  <Button size="sm" variant="outline" disabled={busyId === item.id} onClick={() => { setError(""); setUnlockingItem(item); }}><Unlock /> {t.tripSkeleton.unlock}</Button>
                ) : null
              ) : (
                <>
                  {item.type === "flight" || item.type === "lodging" ? (
                    <Button size="sm" variant="outline" onClick={() => { setViewingItem(null); onTravelEdit(item.type as "flight" | "lodging"); }}>
                      {item.type === "flight" ? t.travel.editInOverview : t.travel.editInLodging}
                    </Button>
                  ) : <ItineraryItemDialog countryStops={trip.countryStops} members={trip.members} places={skeleton?.places ?? []} item={item} editingChanged={editingChanged}
                    load={async () => (await readForConflict()).items.find((entry) => entry.id === item.id) ?? null}
                    save={(input, conflictBase) => saveItem(input, item, conflictBase)} />}
                  <Button size="sm" variant="outline" disabled={busyId === item.id} onClick={() => void itemAction(item, "lock")}><Lock /> {t.tripSkeleton.lock}</Button>
                  <Button size="sm" variant="outline" disabled={busyId === item.id} onClick={() => void itemAction(item, "delete")}><Trash2 /> {t.tripSkeleton.delete}</Button>
                </>
              )}
            </div>
            {item.constraints.map((constraint) => (
              <div key={`${constraint.id}-controls`} className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span>{t.tripSkeleton.constraintStatus(t.tripSkeleton.constraintTypes[constraint.type])}</span>
                {(["confirmed", "unknown", "conflicted"] as const).map((status) => (
                  <Button key={status} size="xs" variant={constraint.status === status ? "default" : "outline"} disabled={busyId === constraint.id || item.lockedAt !== null} onClick={() => void setConstraintStatus(item, constraint, status)}>{t.tripSkeleton.constraintStatuses[status]}</Button>
                ))}
              </div>
            ))}
          </>
        ) : null}
      </article>
    );
  }
  function renderItem(item: ItineraryItemDto, continuation = false, dayDate?: string) {
    const start = itemEndpoint(item, "start");
    const end = continuation ? displayedEndEndpoint(item, start) : undefined;
    const localEnd = end !== "unrepresentable" && end?.localDateTime.startsWith(`${dayDate}T`)
      ? end
      : undefined;
    const displayedTime = continuation
      ? localEnd?.localDateTime.slice(11, 16) ?? t.tripSkeleton.continues
      : start?.localDateTime.slice(11, 16) ?? t.tripSkeleton.timePending;
    return (
      <button
        key={`${item.id}-${continuation ? "continuation" : "full"}`}
        className="plan-item-row"
        data-item-id={item.id}
        onClick={() => {
          setError("");
          setViewingItem({ itemId: item.id, continuation });
        }}
      >
        <span className="plan-item-copy">
          <span className="plan-place-name">
            {item.type === "lodging" ? (
              // Check-out carries luggage out; check-in and nights in between show the bed.
              <span className={`lodging-mark${continuation && localEnd ? " lodging-mark--out" : ""}`} aria-hidden="true">
                {continuation && localEnd ? <Luggage /> : <BedDouble />}
              </span>
            ) : null}
            <strong>{item.title}</strong>
            <span className={`plan-kind-chip${item.lockedAt ? " plan-kind-chip-fixed" : ""}`}>
              {item.lockedAt ? <Lock aria-hidden="true" /> : null}
              {item.lockedAt ? t.tripSkeleton.fixed : t.tripSkeleton.itemTypes[item.type]}
            </span>
          </span>
          <small>
            {/* A lodging shows on its check-in day and again on its check-out day: say which this row is. */}
            {item.type === "lodging" ? <strong className="lodging-role">{!continuation ? t.tripSkeleton.checkIn : localEnd ? t.tripSkeleton.checkOut : t.tripSkeleton.staying}</strong> : null}
            <time>{displayedTime}</time>
            {item.lockedAt ? `・${t.tripSkeleton.itemTypes[item.type]}` : ""}
            {continuation && localEnd ? `・${t.tripSkeleton.continues}` : ""}
          </small>
        </span>
      </button>
    );
  }

  if (!skeleton) {
    const status = <section className="trip-skeleton-shell"><p role={error ? "alert" : "status"}>{error || t.tripSkeleton.loadingItinerary}</p></section>;
    return status;
  }

  const tripDays = skeleton.days;
  const assignmentDay = skeleton.days.find((day) => day.id === assignmentDayId);
  const pendingPlaces = tripPlaces.filter((place) =>
    place.selectedForItinerary && !place.scheduled && place.assignedDayId === null
  );
  const allDaysActive = !tripDays.some((day) => overviewFilter.days.includes(day.date));

  function selectedTripDayDates() {
    return tripDays
      .filter((day) => overviewFilter.days.includes(day.date))
      .map((day) => day.date);
  }

  function updateOverviewFilter(days: string[]) {
    setOverviewFilter({ days });
    writeTripOverviewFilter(days);
  }
  return (
    <>
      <section className="trip-skeleton-shell plan-workspace" aria-labelledby="itinerary-heading">
        <header className="plan-pagehead">
          <h2 id="itinerary-heading">{t.tripSkeleton.heading}</h2>
          <p>{t.tripSkeleton.introduction}</p>
        </header>

        {!canArrange ? (
          <p className="mb-4 rounded-xl border border-ink/10 bg-surface-subtle p-3 text-sm text-muted-foreground">
            {t.schedule.ownerOnly}
          </p>
        ) : null}

        {error && assignmentErrorPlaceId === null ? (
          <p role="alert" className="plan-page-error">{error}</p>
        ) : null}

        <details className="plan-pending">
          <summary>
            <span className="plan-pending-title">
              <strong>{t.tripSkeleton.pendingTitle}</strong>
              <span>{t.tripSkeleton.pendingHelper}</span>
            </span>
            <span
              className="plan-pending-count"
              aria-label={t.tripSkeleton.pendingCount(pendingPlaces.length)}
            >
              {pendingPlaces.length}
            </span>
            <ChevronDown aria-hidden="true" className="plan-pending-chevron" />
          </summary>
          <div className="plan-pending-body">
            {pendingPlaces.length === 0 ? (
              <div className="plan-pending-empty">
                <CalendarDays aria-hidden="true" />
                <span>{t.tripSkeleton.pendingEmpty}</span>
              </div>
            ) : (
              <ul className="plan-source-list plan-pending-list">
                {pendingPlaces.map((place) => {
                  const blocked = place.latitude === null || place.longitude === null;
                  const targetDayId = defaultAssignmentDayId(place, skeleton.days);
                  return (
                    <li key={place.id} className="plan-source-row">
                      <div className="plan-place-main">
                        <div className="plan-place-name">
                          <strong>{place.name}</strong>
                          <span className="plan-kind-chip">{t.tripSkeleton.placeTypes[place.type]}</span>
                        </div>
                        <div className="plan-place-meta">
                          <span>
                            {place.unplacedFromDate === null
                              ? t.tripSkeleton.priorDateUnknown
                              : t.tripSkeleton.priorDate(formatPlanDate(place.unplacedFromDate, locale))}
                          </span>
                          <span>
                            {place.durationMinutes
                              ? t.tripSkeleton.plannedDuration(place.durationMinutes)
                              : t.tripSkeleton.durationUnknown}
                          </span>
                        </div>
                      </div>
                      {blocked ? renderLocationEditor(place) : canArrange ? (
                        <button
                          type="button"
                          className="plan-schedule-button"
                          disabled={busyId !== null || targetDayId === null}
                          onClick={() => {
                            if (targetDayId === null) return;
                            setError("");
                            updateAssignmentErrorPlaceId(null);
                            setAssignmentDayId(targetDayId);
                          }}
                        >
                          <CalendarPlus aria-hidden="true" />
                          {t.tripSkeleton.arrangePending}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </details>

        <div
          className="plan-day-filter"
          role="group"
          aria-label={t.tripSkeleton.dayFilterLabel}
        >
          <button
            type="button"
            aria-pressed={allDaysActive}
            onClick={() => updateOverviewFilter([])}
          >
            {t.tripSkeleton.allDays}
          </button>
          {skeleton.days.map((day) => {
            const label = formatPlanShortDate(day.date, locale);
            const selected = overviewFilter.days.includes(day.date);
            return (
              <button
                key={day.id}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  const currentDays = selectedTripDayDates();
                  updateOverviewFilter(
                    selected
                      ? currentDays.filter((date) => date !== day.date)
                      : [...currentDays, day.date],
                  );
                }}
              >
                {label.date} {label.weekday}
              </button>
            );
          })}
        </div>

        <div className="plan-days">
          {skeleton.days.map((day, index) => {
            if (!allDaysActive && !overviewFilter.days.includes(day.date)) return null;
            const assignedPlaces = tripPlaces.filter((place) =>
              !place.scheduled && place.assignedDayId === day.id
            ).sort(byDayPosition);
            const chronologicalEntries = [...day.entries].sort(
              (left, right) => left.sortInstant.localeCompare(right.sortInstant),
            );
            const itemCount = assignedPlaces.length + day.entries.length;
            const previousDate = Temporal.PlainDate.from(day.date).subtract({ days: 1 }).toString();
            // Lodging booked for a night but saved without a map location cannot be routed from either.
            const bookedFor = (date: string) => skeleton.items.find((item) => {
              if (item.type !== "lodging") return false;
              const start = item.endpoints.find((endpoint) => endpoint.role === "start");
              const end = item.endpoints.find((endpoint) => endpoint.role === "end");
              return Boolean(start && end && start.localDateTime.slice(0, 10) <= date && end.localDateTime.slice(0, 10) > date);
            }) ?? null;
            const nights = [
              ...(index > 0 ? [previousDate] : []),
              ...(index < skeleton.days.length - 1 ? [day.date] : []),
            ].filter((date) => lodgingForNight(skeleton, date) === null);
            const unlocatedLodging = nights.map(bookedFor).find((item) => item !== null) ?? null;
            const missingLodging = nights.length > 0;
            return (
              <section key={day.id} className="day-column" data-date={day.date}>
                <header className="day-heading">
                  <div>
                    <h3>{formatPlanDate(day.date, locale)}</h3>
                    <p>
                      {itemCount > 0
                        ? t.tripSkeleton.plannedEntries(itemCount)
                        : t.tripSkeleton.noPlannedPlaces}
                    </p>
                  </div>
                  <div className="plan-day-actions">
                    {assignedPlaces.length === 0 ? (
                      <span className="plan-route-unavailable">
                        {t.tripSkeleton.optimizeRouteNeedsPlace}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="plan-route-link min-h-11"
                        disabled={busyId !== null}
                        onClick={() => setPlanningDay({
                          id: day.id,
                          date: day.date,
                          label: t.tripSkeleton.dayLabel(index + 1),
                        })}
                      >
                        <Route aria-hidden="true" />
                        {t.tripSkeleton.optimizeRoute}
                      </button>
                    )}
                    {canArrange ? (
                      <button
                        type="button"
                        className="plan-outline-button min-h-11"
                        disabled={busyId !== null}
                        onClick={() => {
                          setError("");
                          updateAssignmentErrorPlaceId(null);
                          setAssignmentDayId(day.id);
                        }}
                      >
                        <CalendarPlus aria-hidden="true" />
                        {t.tripSkeleton.arrangeThisDay}
                      </button>
                    ) : null}
                  </div>
                </header>
                {missingLodging ? (
                  <aside className="plan-lodging-notice">
                    <BedDouble aria-hidden="true" />
                    <p>{unlocatedLodging
                      ? t.tripSkeleton.unlocatedLodgingNotice(unlocatedLodging.title)
                      : t.tripSkeleton.missingNightsNotice(
                        nights.map((date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`),
                        nights.includes(previousDate),
                        nights.includes(day.date),
                      )}</p>
                    <button
                      type="button"
                      className="plan-route-link"
                      onClick={() => onTravelEdit("lodging")}
                    >
                      {unlocatedLodging ? t.tripSkeleton.locateLodging : t.tripSkeleton.setLodging}
                    </button>
                  </aside>
                ) : null}
                <ul className={`plan-day-list${drag?.moved && drag.targetDayId === day.id ? " is-drop-target" : ""}`} data-drop-day={day.id}>
                  {itemCount === 0 ? (
                    <li className="plan-no-plan">
                      <CalendarDays aria-hidden="true" />
                      <span>{t.tripSkeleton.emptyDay}</span>
                      {canArrange ? (
                        <button
                          type="button"
                          className="plan-row-button"
                          disabled={busyId !== null}
                          onClick={() => {
                            setError("");
                            updateAssignmentErrorPlaceId(null);
                            setAssignmentDayId(day.id);
                          }}
                        >
                          <Plus aria-hidden="true" />
                          {t.tripSkeleton.addPlace}
                        </button>
                      ) : null}
                    </li>
                  ) : null}
                  {chronologicalEntries.map((entry) => {
                    const item = itemsById.get(entry.itemId);
                    return item ? (
                      <li key={`${entry.itemId}-${entry.projection}`}>
                        {renderItem(item, entry.projection === "continuation", day.date)}
                      </li>
                    ) : null;
                  })}
                  {(() => {
                    // The landing spot is drawn on an existing row (line above it, or below the last),
                    // so no element is inserted or moved while the pointer is down.
                    const dropping = drag?.moved && drag.targetDayId === day.id ? drag.targetIndex : null;
                    const others = assignedPlaces.filter((place) => !(drag?.moved && place.id === drag.placeId));
                    return assignedPlaces.map((place, placeIndex) => {
                      const dragged = drag?.moved && drag.placeId === place.id;
                      const slot = others.indexOf(place);
                      const marker = dropping === null || dragged
                        ? ""
                        : slot === dropping ? " drop-before" : slot === others.length - 1 && dropping >= others.length ? " drop-after" : "";
                      return (
                        <li
                          key={place.id}
                          data-drag-place={place.id}
                          className={`plan-draggable${dragged ? " is-dragging" : ""}${marker}`}
                        >
                          {canArrange ? (
                            <button
                              type="button"
                              className="plan-drag-handle"
                              aria-label={t.tripSkeleton.dragHandle(place.name)}
                              // Not `disabled`: a keyboard move would drop focus while it saves. The handlers ignore input while busy.
                              aria-disabled={busyId !== null}
                              {...dragHandlers(place, day.id, placeIndex)}
                            >
                              <GripVertical aria-hidden="true" />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="plan-item-row"
                            aria-label={t.tripSkeleton.plannedWishlistPlace(place.name)}
                            onClick={() => {
                              setError("");
                              setViewingAssignedPlaceId(place.id);
                            }}
                          >
                            <span className="plan-item-copy">
                              <span className="plan-place-name">
                                <strong>{place.name}</strong>
                                <span className="plan-kind-chip">
                                  {t.tripSkeleton.placeTypes[place.type]}
                                </span>
                              </span>
                              <small>
                                <time>{t.tripSkeleton.timePending}</time>
                                {"・"}
                                {place.durationMinutes
                                  ? t.tripSkeleton.plannedDuration(place.durationMinutes)
                                  : t.tripSkeleton.durationUnknown}
                              </small>
                            </span>
                          </button>
                        </li>
                      );
                    });
                  })()}
                </ul>
              </section>
            );
          })}
        </div>
        {drag?.moved ? (
          <div className="plan-drag-ghost" style={{ left: drag.x, top: drag.y }} aria-hidden="true">
            <GripVertical aria-hidden="true" />
            {drag.name}
          </div>
        ) : null}


        {viewingItem && itemsById.get(viewingItem.itemId) ? (
          <PlaceDetailSheet
            appearance="workspace"
            open
            title={itemsById.get(viewingItem.itemId)!.title}
            onClose={() => setViewingItem(null)}
          >
            {itemDetail(itemsById.get(viewingItem.itemId)!, viewingItem.continuation)}
          </PlaceDetailSheet>
        ) : null}
        {canArrange && assignmentDayId !== null && assignmentDay ? (
          <PlaceDetailSheet
            appearance="workspace"
            open
            title={t.tripSkeleton.arrangeDay(formatPlanDate(assignmentDay.date, locale))}
            description={t.tripSkeleton.arrangeSheetHelper}
            onClose={() => {
              setAssignmentDayId(null);
              updateAssignmentErrorPlaceId(null);
            }}
          >
            <div className="plan-assignment-days" aria-label={t.tripSkeleton.choosePlanDate}>
              {skeleton.days.map((day) => {
                const label = formatPlanShortDate(day.date, locale);
                return (
                  <button
                    key={day.id}
                    type="button"
                    aria-pressed={assignmentDayId === day.id}
                    disabled={busyId !== null}
                    onClick={() => {
                      setAssignmentDayId(day.id);
                      setError("");
                      updateAssignmentErrorPlaceId(null);
                    }}
                  >
                    <span>{label.date}</span>
                    <small>{label.weekday}</small>
                  </button>
                );
              })}
            </div>
            <DayAssignmentPicker
              places={tripPlaces}
              busyPlaceId={busyId?.startsWith("day-assignment:") ? busyId.slice("day-assignment:".length) : null}
              errorPlaceId={assignmentErrorPlaceId}
              error={error}
              assign={async (place) => { await updateDayAssignment(assignmentDayId, place); }}
              editLocation={renderLocationEditor}
            />
          </PlaceDetailSheet>
        ) : null}
        {viewingAssignedPlace ? (
          <PlaceDetailSheet
            appearance="workspace"
            open
            title={viewingAssignedPlace.name}
            onClose={() => {
              setViewingAssignedPlaceId(null);
              updateAssignmentErrorPlaceId(null);
            }}
            footer={canArrange ? (
              <button
                type="button"
                className="plan-remove-button"
                disabled={busyId !== null}
                onClick={() => {
                  if (!window.confirm(t.tripSkeleton.removeFromDayConfirm(viewingAssignedPlace.name))) return;
                  void updateDayAssignment(null, viewingAssignedPlace);
                }}
              >
                <CalendarMinus aria-hidden="true" />
                {t.tripSkeleton.removeFromDay}
              </button>
            ) : undefined}
          >
            <dl className="plan-assigned-detail">
              <div className="plan-assigned-detail-row">
                <CalendarClock aria-hidden="true" />
                <div>
                  <dt>{t.tripSkeleton.assignmentStatusLabel}</dt>
                  <dd>{t.tripSkeleton.wishlistTimeUnset}</dd>
                </div>
              </div>
              <div className="plan-assigned-detail-row">
                <MapPin aria-hidden="true" />
                <div>
                  <dt>{t.tripSkeleton.assignmentAddressLabel}</dt>
                  <dd>{viewingAssignedPlace.address ?? t.tripSkeleton.addressUnknown}</dd>
                </div>
              </div>
              <div className="plan-assigned-detail-row">
                <Clock3 aria-hidden="true" />
                <div>
                  <dt>{t.tripSkeleton.assignmentDurationLabel}</dt>
                  <dd>
                    {viewingAssignedPlace.durationMinutes
                      ? t.tripSkeleton.plannedDuration(viewingAssignedPlace.durationMinutes)
                      : t.tripSkeleton.durationUnknown}
                  </dd>
                </div>
              </div>
              <div className="plan-assigned-detail-row plan-assigned-detail-notes">
                <StickyNote aria-hidden="true" />
                <div>
                  <dt>{t.tripSkeleton.assignmentNotesLabel}</dt>
                  <dd>{viewingAssignedPlace.notes ?? t.tripSkeleton.notesEmpty}</dd>
                </div>
              </div>
            </dl>
            {viewingAssignedPlace.latitude === null || viewingAssignedPlace.longitude === null
              ? renderLocationEditor(viewingAssignedPlace)
              : null}
            {assignmentErrorPlaceId === viewingAssignedPlace.id && error ? (
              <p role="alert" className="plan-row-error">{error}</p>
            ) : null}
          </PlaceDetailSheet>
        ) : null}
        <Dialog
          open={unlockingItem !== null}
          onOpenChange={(open) => {
            if (!open) setUnlockingItem(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{unlockingItem ? t.tripSkeleton.unlockTitle(unlockingItem.title) : ""}</DialogTitle>
              <DialogDescription>{t.tripSkeleton.unlockDescription}</DialogDescription>
              {error ? <p role="alert" className="pd-notice">{error}</p> : null}
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setUnlockingItem(null)}>
                {t.tripSkeleton.keepLocked}
              </Button>
              <Button
                disabled={!unlockingItem || busyId === unlockingItem.id}
                onClick={() => unlockingItem && void itemAction(unlockingItem, "unlock")}
              >
                <Unlock /> {t.tripSkeleton.unlockItem}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <DayPlanDialog
          tripId={trip.id}
          day={planningDay}
          request={request}
          onClose={() => setPlanningDay(null)}
          canArrange={canArrange}
          onOrderSaved={async () => {
            await load();
            onPlacesChanged();
          }}
        />

        {repairingPlace ? renderLocationEditor(repairingPlace, true) : null}

      </section>
    </>
  );
}
