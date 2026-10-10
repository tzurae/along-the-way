import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  type CreateItineraryItemInput,
  type CreatePlaceInput,
  type ItineraryItemDto,
  type PlaceDto,
  type TripSkeletonDto,
  type TripSkeletonResponse,
  type UpdateItineraryItemInput,
  type UpdatePlaceInput,
  type ZonedEndpointDto,
} from "@along-the-way/contracts/trip-skeleton";
import { CalendarClock, CalendarDays, CalendarMinus, CalendarPlus, ChevronDown, Clock3, Lock, MapPin, MapPinOff, Plane, Plus, Route, StickyNote, Trash2, Unlock, Wallet } from "lucide-react";

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
import { TripPlanDialog } from "./TripPlanDialog";
import { useI18n, type Messages } from "./i18n";
import { ApiRequestError } from "./api-error";
import "./plan-route.css";
import { PlaceDetailSheet } from "./PlaceDetailSheet";

interface RequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}

type CreateAttempt = { input: string; key: string; version: number };

type JsonRequest = <T>(url: string, options?: RequestOptions) => Promise<T>;

interface TripSkeletonWorkspaceProps {
  trip: TripDto;
  request: JsonRequest;
  onTripChanged(): Promise<void>;
  placesRevision: number;
  onPlacesChanged(): void;
  onTravelEdit(type: "flight" | "lodging"): void;
  arrangeDate?: string | null;
  onArrangeOpened?(): void;
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


function byEndpointInstant(
  left: { endpoint: ZonedEndpointDto },
  right: { endpoint: ZonedEndpointDto },
) {
  return left.endpoint.instant.localeCompare(right.endpoint.instant);
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
              {participant.displayName ?? participant.email}
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
  onTripChanged,
  placesRevision,
  onPlacesChanged,
  onTravelEdit,
  arrangeDate,
  onArrangeOpened,
}: TripSkeletonWorkspaceProps) {
  const { t, locale } = useI18n();
  const [skeleton, setSkeleton] = useState<TripSkeletonDto | null>(null);
  const [tripPlaces, setTripPlaces] = useState<TripPlaceDto[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [unlockingItem, setUnlockingItem] = useState<ItineraryItemDto | null>(null);
  const [planningDay, setPlanningDay] = useState<PlannedDay | null>(null);
  const [planningTrip, setPlanningTrip] = useState(false);
  const [viewingItem, setViewingItem] = useState<{ itemId: string; continuation: boolean } | null>(null);
  const [assignmentDayId, setAssignmentDayId] = useState<string | null>(null);
  const [assignmentErrorPlaceId, setAssignmentErrorPlaceId] = useState<string | null>(null);
  const [managementOpen, setManagementOpen] = useState(false);
  const [placeInventoryOpen, setPlaceInventoryOpen] = useState(false);
  const assignmentErrorPlaceIdRef = useRef<string | null>(null);
  const [viewingAssignedPlaceId, setViewingAssignedPlaceId] = useState<string | null>(null);
  const viewingAssignedPlace = viewingAssignedPlaceId ? tripPlaces.find((place) => place.id === viewingAssignedPlaceId) : undefined;
  const placeCreateAttempt = useRef<CreateAttempt | null>(null);
  const itemCreateAttempt = useRef<CreateAttempt | null>(null);
  const actionKeys = useRef(new Map<string, string>());
  const editorOpen = useRef(false);
  const latestSkeleton = useRef<TripSkeletonDto | null>(null);
  const managementPlacesSummaryRef = useRef<HTMLElement | null>(null);
  const managePlacesHandled = useRef(false);
  const loadGeneration = useRef(0);
  const updateAssignmentErrorPlaceId = useCallback((placeId: string | null) => {
    assignmentErrorPlaceIdRef.current = placeId;
    setAssignmentErrorPlaceId(placeId);
  }, []);

  const openPlaceManagement = useCallback(() => {
    setAssignmentDayId(null);
    updateAssignmentErrorPlaceId(null);
    setError("");
    setManagementOpen(true);
    setPlaceInventoryOpen(true);
    window.requestAnimationFrame(() => {
      const summary = managementPlacesSummaryRef.current;
      summary?.scrollIntoView({ block: "start", behavior: "smooth" });
      summary?.focus({ preventScroll: true });
    });
  }, [updateAssignmentErrorPlaceId]);

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

  // Only another trip blanks the itinerary. A place change reloads behind the current view:
  // blanking it would shorten the page and drop the reader's scroll position.
  useEffect(() => {
    setSkeleton(null);
    managePlacesHandled.current = false;
  }, [trip.id]);

  useEffect(() => {
    void load();
  }, [load, placesRevision]);

  useEffect(() => {
    if (!arrangeDate || !skeleton) return;
    const day = skeleton.days.find((entry) => entry.date === arrangeDate);
    if (!day) return;
    setAssignmentDayId(day.id);
    updateAssignmentErrorPlaceId(null);
    setError("");
    onArrangeOpened?.();
  }, [arrangeDate, skeleton, onArrangeOpened, updateAssignmentErrorPlaceId]);

  useEffect(() => {
    if (!skeleton || managePlacesHandled.current) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("manage") !== "places") return;
    managePlacesHandled.current = true;
    openPlaceManagement();
    url.searchParams.delete("manage");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [openPlaceManagement, skeleton]);

  const placesById = useMemo(
    () => new Map(skeleton?.places.map((place) => [place.id, place]) ?? []),
    [skeleton?.places],
  );
  const itemsById = useMemo(
    () => new Map(skeleton?.items.map((item) => [item.id, item]) ?? []),
    [skeleton?.items],
  );
  const lockedPlaceIds = useMemo(
    () => new Set(
      skeleton?.items
        .filter((item) => item.lockedAt !== null)
        .flatMap((item) => item.endpoints.map((endpoint) => endpoint.placeId)) ?? [],
    ),
    [skeleton?.items],
  );

  async function savePlace(input: CreatePlaceInput | UpdatePlaceInput, place?: PlaceDto, conflictBase?: number) {
    if (!skeleton) throw new Error(t.tripSkeleton.loadingError);
    const serializedInput = JSON.stringify(input);
    if (!place && placeCreateAttempt.current?.input !== serializedInput) {
      placeCreateAttempt.current = { input: serializedInput, key: crypto.randomUUID(), version: Math.max(trip.version, (latestSkeleton.current ?? skeleton).tripVersion) };
    }
    const updateIdentity = place
      ? `update-place:${place.id}:${serializedInput}`
      : null;
    await request(
      place ? `/api/trips/${trip.id}/places/${place.id}` : `/api/trips/${trip.id}/places`,
      {
        method: place ? "PATCH" : "POST",
        headers: {
          "Idempotency-Key": updateIdentity
            ? actionKey(updateIdentity)
            : placeCreateAttempt.current!.key,
          ...(conflictBase ? { "Conflict-Base-Version": String(conflictBase) } : {}),
        },
        body: JSON.stringify(place ? input : { ...input, expectedTripVersion: placeCreateAttempt.current!.version }),
        parse: parsePlaceResponse,
      },
    ).catch(async (reason: unknown) => {
      if (!place && reason instanceof ApiRequestError && reason.code === "conflict" && reason.currentVersion !== undefined) {
        placeCreateAttempt.current = null;
        await readForConflict();
      }
      throw reason;
    });
    if (updateIdentity) actionKeys.current.delete(updateIdentity);
    await load();
    onPlacesChanged();
    if (!place) {
      placeCreateAttempt.current = null;
      await onTripChanged();
    }
  }

  function renderLocationEditor(tripPlace: TripPlaceDto) {
    const place = placesById.get(tripPlace.placeId);
    if (!place) {
      return (
        <>
          <button
            type="button"
            className="plan-schedule-button"
            disabled={busyId !== null}
            onClick={openPlaceManagement}
          >
            <MapPinOff aria-hidden="true" />
            {t.tripSkeleton.completeLocation}
          </button>
          <p className="plan-location-recovery-note">
            {t.tripSkeleton.locationRecoveryHelper}
          </p>
        </>
      );
    }
    return (
      <PlaceDialog
        place={place}
        editingChanged={editingChanged}
        focusLocationOnOpen
        triggerClassName="plan-schedule-button"
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

  async function deletePlace(place: PlaceDto) {
    if (!window.confirm(t.tripSkeleton.deletePlaceConfirm(place.name))) return;
    const identity = `delete-place:${place.id}:${place.version}`;
    setBusyId(place.id);
    try {
      await request(`/api/trips/${trip.id}/places/${place.id}`, {
        method: "DELETE",
        headers: { "Idempotency-Key": actionKey(identity) },
        body: JSON.stringify({ expectedVersion: place.version }),
      });
      actionKeys.current.delete(identity);
      await load();
      onPlacesChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.tripSkeleton.deletePlaceError);
    } finally {
      setBusyId(null);
    }
  }

  async function saveItem(input: CreateItineraryItemInput | UpdateItineraryItemInput, item?: ItineraryItemDto, conflictBase?: number) {
    if (!skeleton) throw new Error(t.tripSkeleton.loadingError);
    const serializedInput = JSON.stringify(input);
    if (!item && itemCreateAttempt.current?.input !== serializedInput) {
      itemCreateAttempt.current = { input: serializedInput, key: crypto.randomUUID(), version: Math.max(trip.version, (latestSkeleton.current ?? skeleton).tripVersion) };
    }
    const updateIdentity = item
      ? `update-item:${item.id}:${serializedInput}`
      : null;
    await request(
      item ? `/api/trips/${trip.id}/items/${item.id}` : `/api/trips/${trip.id}/items`,
      {
        method: item ? "PATCH" : "POST",
        headers: {
          "Idempotency-Key": updateIdentity
            ? actionKey(updateIdentity)
            : itemCreateAttempt.current!.key,
          ...(conflictBase ? { "Conflict-Base-Version": String(conflictBase) } : {}),
        },
        body: JSON.stringify(item ? input : { ...input, expectedTripVersion: itemCreateAttempt.current!.version }),
        parse: parseItineraryItemResponse,
      },
    ).catch(async (reason: unknown) => {
      if (!item && reason instanceof ApiRequestError && reason.code === "conflict" && reason.currentVersion !== undefined) {
        itemCreateAttempt.current = null;
        await readForConflict();
      }
      throw reason;
    });
    if (updateIdentity) actionKeys.current.delete(updateIdentity);
    await load();
    onPlacesChanged();
    if (!item) {
      itemCreateAttempt.current = null;
      await onTripChanged();
    }
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
    } catch (reason) {
      const failure = reason instanceof Error ? reason.message : t.tripSkeleton.plannedDayUpdateError;
      const assignmentError = removedOriginalDay
        ? t.tripSkeleton.removedBeforeReassignError(failure)
        : failure;
      if (reason instanceof ApiRequestError && reason.code === "conflict") {
        await load();
      }
      // Keep the mutation failure visible after a conflict refresh replaces the stale row/version.
      setError(assignmentError);
      updateAssignmentErrorPlaceId(place.id);
      if (removedOriginalDay) onPlacesChanged();
    } finally {
      setBusyId(null);
    }
  }

  function itemDetail(item: ItineraryItemDto, continuation = false) {
    const start = itemEndpoint(item, "start");
    const end = displayedEndEndpoint(item, start);
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
            {item.sourceUrl ? <a className="mt-2 inline-block text-sm font-semibold text-accent-strong underline" href={item.sourceUrl} rel="noreferrer" target="_blank">{t.tripSkeleton.officialSource}</a> : null}
            <div className="mt-4 flex flex-wrap gap-2">
              {item.lockedAt ? (
                <Button size="sm" variant="outline" disabled={busyId === item.id} onClick={() => { setError(""); setUnlockingItem(item); }}><Unlock /> {t.tripSkeleton.unlock}</Button>
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
            <strong>{item.title}</strong>
            <span className={`plan-kind-chip${item.lockedAt ? " plan-kind-chip-fixed" : ""}`}>
              {item.lockedAt ? <Lock aria-hidden="true" /> : null}
              {item.lockedAt ? t.tripSkeleton.fixed : t.tripSkeleton.itemTypes[item.type]}
            </span>
          </span>
          <small>
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

  const tripInformationItems = skeleton.tripInformationItemIds
    .map((id) => itemsById.get(id))
    .filter((item): item is ItineraryItemDto => Boolean(item));
  const firstDate = skeleton.days.at(0)?.date;
  const lastDate = skeleton.days.at(-1)?.date;
  const arrivalItems = skeleton.items.flatMap((item) => {
    const endpoint = itemEndpoint(item, "end");
    return firstDate
      && endpoint?.localDateTime.startsWith(firstDate)
      && (item.type === "flight" || item.type === "transport")
      ? [{ item, endpoint }]
      : [];
  }).sort(byEndpointInstant);
  const checkInItems = skeleton.items.flatMap((item) => {
    const endpoint = itemEndpoint(item, "start");
    return firstDate && endpoint?.localDateTime.startsWith(firstDate) && item.type === "lodging"
      ? [{ item, endpoint }]
      : [];
  }).sort(byEndpointInstant);
  const usableTimeItems = skeleton.items.flatMap((item) => {
    const endpoint = itemEndpoint(item, "start");
    return firstDate && endpoint?.localDateTime.startsWith(firstDate) && item.type === "free-time"
      ? [{ item, endpoint }]
      : [];
  }).sort(byEndpointInstant);
  const checkOutItems = skeleton.items.flatMap((item) => {
    const endpoint = itemEndpoint(item, "end");
    return lastDate && endpoint?.localDateTime.startsWith(lastDate) && item.type === "lodging"
      ? [{ item, endpoint }]
      : [];
  }).sort(byEndpointInstant);
  const departureItems = skeleton.items.flatMap((item) => {
    const endpoint = itemEndpoint(item, "start");
    return lastDate
      && endpoint?.localDateTime.startsWith(lastDate)
      && (item.type === "flight" || item.type === "transport")
      ? [{ item, endpoint }]
      : [];
  }).sort(byEndpointInstant);
  const departureBufferConstraints = departureItems.flatMap(({ item }) =>
    item.constraints.filter(
      (constraint) =>
        constraint.type === "minimum_buffer"
        && constraint.minimumBufferMinutes !== null,
    ),
  );
  const confirmedDepartureBufferMinutes = departureBufferConstraints
    .filter((constraint) => constraint.status === "confirmed")
    .map((constraint) => constraint.minimumBufferMinutes!);
  const unconfirmedDepartureBuffers = departureBufferConstraints.filter(
    (constraint) => constraint.status !== "confirmed",
  );
  const assignmentDay = skeleton.days.find((day) => day.id === assignmentDayId);
  const pendingPlaces = tripPlaces.filter((place) =>
    place.selectedForItinerary && !place.scheduled && place.assignedDayId === null
  );


  return (
    <>
      <section className="trip-skeleton-shell plan-workspace" aria-labelledby="itinerary-heading">
        <header className="plan-pagehead">
          <h2 id="itinerary-heading">{t.tripSkeleton.heading}</h2>
          <p>{t.tripSkeleton.introduction}</p>
        </header>

        {error && assignmentErrorPlaceId === null ? (
          <p role="alert" className="plan-page-error">{error}</p>
        ) : null}

        <details className="plan-pending" open>
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
                      {blocked ? renderLocationEditor(place) : (
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
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </details>

        <details
          className="plan-management"
          open={managementOpen}
          onToggle={(event) => setManagementOpen(event.currentTarget.open)}
        >
          <summary>
            <span>
              <strong>{t.tripSkeleton.managementTitle}</strong>
              <small>{t.tripSkeleton.managementHelper}</small>
            </span>
            <ChevronDown aria-hidden="true" />
          </summary>
          <div className="plan-management-body">
            <div className="plan-management-actions">
              <PlaceDialog editingChanged={editingChanged} save={(input) => savePlace(input)} />
              <ItineraryItemDialog
                editingChanged={editingChanged}
                countryStops={trip.countryStops}
                members={trip.members}
                places={skeleton.places}
                save={(input) => saveItem(input)}
              />
              {tripPlaces.some((place) =>
                !place.scheduled
                && place.assignedDayId === null
                && place.latitude !== null
                && place.longitude !== null
              ) ? (
                <button
                  type="button"
                  className="plan-outline-button"
                  disabled={busyId !== null}
                  onClick={() => setPlanningTrip(true)}
                >
                  {t.tripSkeleton.planWholeTrip}
                </button>
              ) : null}
            </div>

            <details
              className="plan-inventory"
              aria-labelledby="places-heading"
              open={placeInventoryOpen}
              onToggle={(event) => setPlaceInventoryOpen(event.currentTarget.open)}
            >
              <summary id="places-heading" ref={managementPlacesSummaryRef} tabIndex={-1}>
                <MapPin aria-hidden="true" />
                {t.tripSkeleton.places}
              </summary>
              {skeleton.places.length === 0 ? (
                <p className="empty-state">{t.tripSkeleton.noPlaces}</p>
              ) : (
                <div className="place-grid">
                  {skeleton.places.map((place) => (
                    <article key={place.id} className="place-card">
                      <div>
                        <p className="text-xs font-bold uppercase tracking-wider text-accent-strong">
                          {t.tripSkeleton.placeTypes[place.type]}
                        </p>
                        <h4 className="mt-1 font-display text-lg">{place.name}</h4>
                        <p className="mt-2 text-sm text-muted-foreground">
                          {place.address || t.tripSkeleton.noAddress}
                        </p>
                        <p className="mt-1 text-sm">{place.timeZone || t.tripSkeleton.noTimeZone}</p>
                        {place.locationStatus !== "complete" ? (
                          <p className="mt-2 font-semibold text-accent-strong">
                            {t.tripSkeleton.locationIncomplete}
                          </p>
                        ) : null}
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {lockedPlaceIds.has(place.id) ? (
                          <p className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                            <Lock className="size-4" /> {t.tripSkeleton.lockedPlace}
                          </p>
                        ) : (
                          <PlaceDialog
                            place={place}
                            editingChanged={editingChanged}
                            load={async () =>
                              (await readForConflict()).places.find((entry) => entry.id === place.id) ?? null
                            }
                            save={(input, conflictBase) => savePlace(input, place, conflictBase)}
                          />
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId === place.id || lockedPlaceIds.has(place.id)}
                          onClick={() => void deletePlace(place)}
                        >
                          <Trash2 /> {t.tripSkeleton.delete}
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </details>

            <details className="plan-inventory" aria-labelledby="trip-info-heading">
              <summary id="trip-info-heading">
                <Plane aria-hidden="true" />
                {t.tripSkeleton.tripInformation}
              </summary>
              {tripInformationItems.length === 0 ? (
                <p className="empty-state">{t.tripSkeleton.noTripInformation}</p>
              ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {tripInformationItems.map((item) => renderItem(item))}
                </div>
              )}
            </details>

            <div className="plan-management-context">
              <section>
                <h3>{t.tripSkeleton.arrivalPriorities}</h3>
                <ol>
                  <li>
                    <strong>{t.tripSkeleton.arrival}</strong>{" "}
                    {arrivalItems.length > 0
                      ? arrivalItems.map(({ item, endpoint }) => (
                          <span key={item.id}>{item.title} · {localEndpoint(endpoint, placesById, t.tripSkeleton)}</span>
                        ))
                      : t.tripSkeleton.noArrival}
                  </li>
                  <li>
                    <strong>{t.tripSkeleton.luggageAndCheckIn}</strong>{" "}
                    {checkInItems.length > 0
                      ? checkInItems.map(({ item, endpoint }) => (
                          <span key={item.id}>{item.title} · {localEndpoint(endpoint, placesById, t.tripSkeleton)}</span>
                        ))
                      : t.tripSkeleton.noCheckIn}
                  </li>
                  <li>
                    <strong>{t.tripSkeleton.remainingTime}</strong>{" "}
                    {usableTimeItems.length > 0
                      ? usableTimeItems.map(({ item, endpoint }) => (
                          <span key={item.id}>{item.title} · {localEndpoint(endpoint, placesById, t.tripSkeleton)}</span>
                        ))
                      : t.tripSkeleton.noFreeTime}
                  </li>
                </ol>
              </section>
              <section>
                <h3>{t.tripSkeleton.departurePriorities}</h3>
                <ol>
                  <li>
                    <strong>{t.tripSkeleton.checkoutAndLuggage}</strong>{" "}
                    {checkOutItems.length > 0
                      ? checkOutItems.map(({ item, endpoint }) => (
                          <span key={item.id}>{item.title} · {localEndpoint(endpoint, placesById, t.tripSkeleton)}</span>
                        ))
                      : t.tripSkeleton.noCheckout}
                  </li>
                  <li>
                    <strong>{t.tripSkeleton.transferAndDeparture}</strong>{" "}
                    {departureItems.length > 0
                      ? departureItems.map(({ item, endpoint }) => (
                          <span key={item.id}>{item.title} · {localEndpoint(endpoint, placesById, t.tripSkeleton)}</span>
                        ))
                      : t.tripSkeleton.noDeparture}
                  </li>
                  <li>
                    <strong>{t.tripSkeleton.protectedBuffer}</strong>{" "}
                    {confirmedDepartureBufferMinutes.length > 0
                      ? t.tripSkeleton.minimumMinutes(Math.max(...confirmedDepartureBufferMinutes))
                      : t.tripSkeleton.noConfirmedBuffer}
                  </li>
                  {unconfirmedDepartureBuffers.length > 0 ? (
                    <li>
                      <strong>{t.tripSkeleton.unconfirmedBuffers}</strong>{" "}
                      {unconfirmedDepartureBuffers.map((constraint) => (
                        <span key={constraint.id}>
                          {t.tripSkeleton.minimumBufferMinutes(constraint.minimumBufferMinutes!)}
                          ・{t.tripSkeleton.constraintStatuses[constraint.status]}
                        </span>
                      ))}
                    </li>
                  ) : null}
                </ol>
              </section>
            </div>
          </div>
        </details>
        <div className="plan-days">
          {skeleton.days.map((day, index) => {
            const assignedPlaces = tripPlaces.filter((place) =>
              !place.scheduled && place.assignedDayId === day.id
            ).sort(byDayPosition);
            const chronologicalEntries = [...day.entries].sort(
              (left, right) => left.sortInstant.localeCompare(right.sortInstant),
            );
            const itemCount = assignedPlaces.length + day.entries.length;
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
                        className="plan-route-link"
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
                    <button
                      type="button"
                      className="plan-outline-button"
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
                  </div>
                </header>
                <ul className="plan-day-list">
                  {itemCount === 0 ? (
                    <li className="plan-no-plan">
                      <CalendarDays aria-hidden="true" />
                      <span>{t.tripSkeleton.emptyDay}</span>
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
                  {assignedPlaces.map((place) => (
                    <li key={place.id}>
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
                  ))}
                </ul>
              </section>
            );
          })}
        </div>


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
        {assignmentDayId !== null && assignmentDay ? (
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
              assign={(place) => updateDayAssignment(assignmentDayId, place)}
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
            footer={(
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
            )}
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
              <div className="plan-assigned-detail-row">
                <Wallet aria-hidden="true" />
                <div>
                  <dt>{t.tripSkeleton.assignmentCostLabel}</dt>
                  <dd>
                    {viewingAssignedPlace.budgetAmountMinor !== null && viewingAssignedPlace.budgetCurrency
                      ? formatMinorAmount(
                          viewingAssignedPlace.budgetAmountMinor,
                          viewingAssignedPlace.budgetCurrency,
                          locale,
                        )
                      : t.tripSkeleton.costUnknown}
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
          onOrderSaved={async () => {
            await load();
            onPlacesChanged();
          }}
        />

        <TripPlanDialog
          tripId={trip.id}
          open={planningTrip}
          dayLabels={new Map(
            skeleton.days.map((day, index) => [day.id, t.tripSkeleton.dayLabel(index + 1)])
          )}
          request={request}
          onClose={() => setPlanningTrip(false)}
          onApplied={() => {
            setPlanningTrip(false);
            onPlacesChanged();
          }}
        />
      </section>
    </>
  );
}
