import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Temporal } from "@js-temporal/polyfill";
import type { TripDto } from "@along-the-way/contracts/private-trips";
import {
  parseTripPlaceListResponse,
  type TripPlaceDto,
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
  type UpdateItineraryItemInput,
  type UpdatePlaceInput,
  type ZonedEndpointDto,
} from "@along-the-way/contracts/trip-skeleton";
import { CalendarDays, Clock3, Lock, MapPin, Plane, Trash2, Unlock } from "lucide-react";

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

interface RequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}

type JsonRequest = <T>(url: string, options?: RequestOptions) => Promise<T>;

interface TripSkeletonWorkspaceProps {
  trip: TripDto;
  request: JsonRequest;
  onTripChanged(): Promise<void>;
  placesRevision: number;
  onPlacesChanged(): void;
  recentChangesContainer: HTMLElement | null;
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

function formatDate(date: string, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

/** Applied route order first; places without one keep their list order at the end. */
function byDayPosition(left: TripPlaceDto, right: TripPlaceDto) {
  if (left.dayPosition === right.dayPosition) return 0;
  if (left.dayPosition === null) return 1;
  if (right.dayPosition === null) return -1;
  return left.dayPosition - right.dayPosition;
}

function DayAssignmentPicker({
  places,
  busy,
  assign,
}: {
  places: TripPlaceDto[];
  busy: boolean;
  assign(places: TripPlaceDto[]): Promise<void>;
}) {
  const { t } = useI18n();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // A place planned for one day must be removed there before another day can take it.
  const selectable = places.filter((place) => !place.scheduled && place.assignedDayId === null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selected = selectable.filter((place) => selectedIds.includes(place.id));
    if (selected.length === 0) return;
    await assign(selected);
    setSelectedIds([]);
  }

  return (
    <details className="rounded-xl border border-ink/10 bg-surface p-3">
      <summary className="cursor-pointer font-bold">{t.tripSkeleton.addFromWishlist}</summary>
      {selectable.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{t.tripSkeleton.noAvailableWishlistPlaces}</p>
      ) : (
        <form className="mt-3 grid gap-3" onSubmit={(event) => void submit(event)}>
          <fieldset className="grid max-h-64 auto-rows-min gap-2 overflow-y-auto">
            <legend className="sr-only">{t.tripSkeleton.wishlistPlacesToAdd}</legend>
            {selectable.map((place) => (
              <label key={place.id} className="flex min-h-11 items-start gap-3 rounded-lg border border-ink/10 p-3">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={selectedIds.includes(place.id)}
                  onChange={(event) => setSelectedIds((current) =>
                    event.target.checked
                      ? [...current, place.id]
                      : current.filter((id) => id !== place.id)
                  )}
                />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <strong className="block">{place.name}</strong>
                  <small className="text-muted-foreground">{place.address ?? t.tripSkeleton.addressUnknown}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <button
            className="min-h-11 rounded-lg bg-accent px-4 font-bold text-ink-strong"
            disabled={busy || selectedIds.length === 0}
          >
            {busy ? t.tripSkeleton.adding : t.tripSkeleton.addSelected(selectedIds.length)}
          </button>
        </form>
      )}
    </details>
  );
}

export function TripSkeletonWorkspace({
  trip,
  request,
  onTripChanged,
  placesRevision,
  onPlacesChanged,
  recentChangesContainer,
}: TripSkeletonWorkspaceProps) {
  const { t, locale } = useI18n();
  const [skeleton, setSkeleton] = useState<TripSkeletonDto | null>(null);
  const [tripPlaces, setTripPlaces] = useState<TripPlaceDto[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [unlockingItem, setUnlockingItem] = useState<ItineraryItemDto | null>(null);
  const [planningDay, setPlanningDay] = useState<PlannedDay | null>(null);
  const [planningTrip, setPlanningTrip] = useState(false);
  const placeCreateKey = useRef<string | null>(null);
  const itemCreateKey = useRef<string | null>(null);
  const actionKeys = useRef(new Map<string, string>());

  function actionKey(identity: string) {
    const existing = actionKeys.current.get(identity);
    if (existing) return existing;
    const created = crypto.randomUUID();
    actionKeys.current.set(identity, created);
    return created;
  }

  const load = useCallback(async () => {
    try {
      const [skeletonResponse, tripPlaceResponse] = await Promise.all([
        request<ReturnType<typeof parseTripSkeletonResponse>>(
          `/api/trips/${trip.id}/skeleton`,
          { parse: parseTripSkeletonResponse },
        ),
        request<ReturnType<typeof parseTripPlaceListResponse>>(
          `/api/trips/${trip.id}/trip-places`,
          { parse: parseTripPlaceListResponse },
        ),
      ]);
      setSkeleton(skeletonResponse.skeleton);
      setTripPlaces(tripPlaceResponse.tripPlaces);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.tripSkeleton.loadError);
    }
  }, [request, t, trip.id]);

  // Only another trip blanks the itinerary. A place change reloads behind the current view:
  // blanking it would shorten the page and drop the reader's scroll position.
  useEffect(() => {
    setSkeleton(null);
  }, [trip.id]);

  useEffect(() => {
    void load();
  }, [load, placesRevision]);

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

  async function savePlace(input: CreatePlaceInput | UpdatePlaceInput, place?: PlaceDto) {
    if (!skeleton) throw new Error(t.tripSkeleton.loadingError);
    const updateIdentity = place
      ? `update-place:${place.id}:${(input as UpdatePlaceInput).expectedVersion}`
      : null;
    await request(
      place ? `/api/trips/${trip.id}/places/${place.id}` : `/api/trips/${trip.id}/places`,
      {
        method: place ? "PATCH" : "POST",
        headers: {
          "Idempotency-Key": updateIdentity
            ? actionKey(updateIdentity)
            : placeCreateKey.current ??= crypto.randomUUID(),
        },
        body: JSON.stringify(place ? input : { ...input, expectedTripVersion: skeleton.tripVersion }),
        parse: parsePlaceResponse,
      },
    );
    if (updateIdentity) actionKeys.current.delete(updateIdentity);
    await load();
    onPlacesChanged();
    if (!place) {
      placeCreateKey.current = null;
      await onTripChanged();
    }
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

  async function saveItem(input: CreateItineraryItemInput | UpdateItineraryItemInput, item?: ItineraryItemDto) {
    if (!skeleton) throw new Error(t.tripSkeleton.loadingError);
    const updateIdentity = item
      ? `update-item:${item.id}:${(input as UpdateItineraryItemInput).expectedVersion}`
      : null;
    await request(
      item ? `/api/trips/${trip.id}/items/${item.id}` : `/api/trips/${trip.id}/items`,
      {
        method: item ? "PATCH" : "POST",
        headers: {
          "Idempotency-Key": updateIdentity
            ? actionKey(updateIdentity)
            : itemCreateKey.current ??= crypto.randomUUID(),
        },
        body: JSON.stringify(item ? input : { ...input, expectedTripVersion: skeleton.tripVersion }),
        parse: parseItineraryItemResponse,
      },
    );
    if (updateIdentity) actionKeys.current.delete(updateIdentity);
    await load();
    onPlacesChanged();
    if (!item) {
      itemCreateKey.current = null;
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
      if (action === "delete") onPlacesChanged();
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
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.tripSkeleton.constraintUpdateError);
    } finally {
      setBusyId(null);
    }
  }

  async function updateDayAssignments(
    tripDayId: string | null,
    places: TripPlaceDto[],
  ) {
    if (places.length === 0) return;
    const payload = {
      assignments: places.map((place) => ({
        tripPlaceId: place.id,
        tripDayId,
        expectedVersion: place.version,
      })),
    };
    const identity = `day-assignments:${tripDayId ?? "none"}:${places
      .map((place) => `${place.id}:${place.version}`)
      .sort()
      .join(",")}`;
    setBusyId(`day-assignment:${tripDayId ?? places[0]!.id}`);
    setError("");
    try {
      const response = await request<ReturnType<typeof parseTripPlaceListResponse>>(
        `/api/trips/${trip.id}/trip-place-day-assignments`,
        {
          method: "PUT",
          headers: { "Idempotency-Key": actionKey(identity) },
          body: JSON.stringify(payload),
          parse: parseTripPlaceListResponse,
        },
      );
      actionKeys.current.delete(identity);
      setTripPlaces(response.tripPlaces);
      onPlacesChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.tripSkeleton.plannedDayUpdateError);
    } finally {
      setBusyId(null);
    }
  }

  function renderItem(item: ItineraryItemDto, continuation = false) {
    const start = itemEndpoint(item, "start");
    const end = displayedEndEndpoint(item, start);
    return (
      <article key={`${item.id}-${continuation ? "continuation" : "full"}`} className="itinerary-card" data-item-id={item.id}>
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
                <Button size="sm" variant="outline" disabled={busyId === item.id} onClick={() => setUnlockingItem(item)}><Unlock /> {t.tripSkeleton.unlock}</Button>
              ) : (
                <>
                  <ItineraryItemDialog countryStops={trip.countryStops} members={trip.members} places={skeleton?.places ?? []} item={item} save={(input) => saveItem(input, item)} />
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

  if (!skeleton) {
    const status = <section className="trip-skeleton-shell"><p role={error ? "alert" : "status"}>{error || t.tripSkeleton.loadingItinerary}</p></section>;
    return (
      <>
        {status}
        {recentChangesContainer ? createPortal(status, recentChangesContainer) : null}
      </>
    );
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

  // Keep one skeleton request/state owner while placing its live event list in the sibling tab panel.
  const recentChanges = (
    <section className="trip-skeleton-shell" aria-labelledby="activity-heading">
      <h3 id="activity-heading" className="section-heading"><Clock3 /> {t.tripSkeleton.recentChanges}</h3>
      {skeleton.events.length === 0 ? <p className="empty-state">{t.tripSkeleton.noRecentChanges}</p> : (
        <ol className="activity-list">
          {skeleton.events.map((event) => (
            <li key={event.id}>
              <p className="font-semibold">{t.tripSkeleton.events[event.eventType] ?? event.summary}</p>
              <p className="text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString(locale)}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );

  return (
    <>
      <section className="trip-skeleton-shell" aria-labelledby="itinerary-heading">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">{t.tripSkeleton.eyebrow}</p>
          <h2 id="itinerary-heading" className="font-display text-3xl text-ink-strong">{t.tripSkeleton.heading}</h2>
          <p className="mt-2 max-w-3xl text-muted-foreground">{t.tripSkeleton.introduction}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <PlaceDialog save={(input) => savePlace(input)} />
          <ItineraryItemDialog countryStops={trip.countryStops} members={trip.members} places={skeleton.places} save={(input) => saveItem(input)} />
        </div>
      </div>

      {error ? <p role="alert" className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{error}</p> : null}

      <section className="mt-8" aria-labelledby="places-heading">
        <h3 id="places-heading" className="section-heading"><MapPin /> {t.tripSkeleton.places}</h3>
        {skeleton.places.length === 0 ? (
          <p className="empty-state">{t.tripSkeleton.noPlaces}</p>
        ) : (
          <div className="place-grid">
            {skeleton.places.map((place) => (
              <article key={place.id} className="place-card">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-accent-strong">{t.tripSkeleton.placeTypes[place.type]}</p>
                  <h4 className="mt-1 font-display text-lg">{place.name}</h4>
                  <p className="mt-2 text-sm text-muted-foreground">{place.address || t.tripSkeleton.noAddress}</p>
                  <p className="mt-1 text-sm">{place.timeZone || t.tripSkeleton.noTimeZone}</p>
                  {place.locationStatus !== "complete" ? <p className="mt-2 font-semibold text-accent-strong">{t.tripSkeleton.locationIncomplete}</p> : null}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {lockedPlaceIds.has(place.id) ? (
                    <p className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                      <Lock className="size-4" /> {t.tripSkeleton.lockedPlace}
                    </p>
                  ) : (
                    <PlaceDialog place={place} save={(input) => savePlace(input, place)} />
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
      </section>

      <section className="mt-10" aria-labelledby="trip-info-heading">
        <h3 id="trip-info-heading" className="section-heading"><Plane /> {t.tripSkeleton.tripInformation}</h3>
        {tripInformationItems.length === 0 ? <p className="empty-state">{t.tripSkeleton.noTripInformation}</p> : (
          <div className="grid gap-3 lg:grid-cols-2">{tripInformationItems.map((item) => renderItem(item))}</div>
        )}
      </section>

      <section className="mt-10" aria-labelledby="timeline-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h3 id="timeline-heading" className="section-heading"><CalendarDays /> {t.tripSkeleton.dailyTimeline}</h3>
          {tripPlaces.some((place) =>
            !place.scheduled && place.assignedDayId === null && place.latitude !== null && place.longitude !== null) ? (
            <button
              className="min-h-10 rounded-lg border border-accent px-3 font-bold"
              disabled={busyId !== null}
              onClick={() => setPlanningTrip(true)}
            >
              {t.tripSkeleton.planWholeTrip}
            </button>
          ) : null}
        </div>
        <div className="timeline-grid">
          {skeleton.days.map((day, index) => {
            const assignedPlaces = tripPlaces.filter((place) =>
              !place.scheduled && place.assignedDayId === day.id
            ).sort(byDayPosition);
            const fullItems = day.entries.flatMap((entry) => {
              const item = itemsById.get(entry.itemId);
              return entry.projection === "full" && item ? [item] : [];
            });
            const knownCosts = new Map<string, number>();
            for (const entry of [
              ...assignedPlaces.map((place) => place.budgetAmountMinor === null || place.budgetCurrency === null
                ? null
                : { amountMinor: place.budgetAmountMinor, currency: place.budgetCurrency }),
              ...fullItems.map((item) => item.money),
            ]) {
              if (entry) {
                knownCosts.set(
                  entry.currency,
                  (knownCosts.get(entry.currency) ?? 0) + entry.amountMinor,
                );
              }
            }
            const unknownCostCount =
              assignedPlaces.filter((place) => place.budgetAmountMinor === null).length
              + fullItems.filter((item) => item.money === null).length;
            const costSummary = [...knownCosts.entries()]
              .map(([currency, amount]) => formatMinorAmount(amount, currency, locale))
              .join("＋");
            return (
            <section key={day.id} className="day-column" data-date={day.date}>
              <header className="day-heading">
                <p className="text-xs font-bold uppercase tracking-wider text-accent-strong">{t.tripSkeleton.dayLabel(index + 1)}</p>
                <h4 className="font-display text-xl">{formatDate(day.date, locale)}</h4>
                <p className="mt-2 text-sm font-semibold">
                  {t.tripSkeleton.plannedEntries(assignedPlaces.length + day.entries.length)}
                  {"・"}
                  {costSummary || t.tripSkeleton.noKnownCost}
                  {unknownCostCount > 0 ? `・${t.tripSkeleton.unknownCosts(unknownCostCount)}` : ""}
                </p>
                {index === 0 ? (
                  <aside className="day-context" data-testid="arrival-priorities">
                    <p className="font-bold">{t.tripSkeleton.arrivalPriorities}</p>
                    <ol className="mt-2 grid gap-2">
                      <li>
                        <strong>{t.tripSkeleton.arrival}</strong>{" "}
                        {arrivalItems.length > 0
                          ? arrivalItems.map(({ item, endpoint }) => (
                              <span key={item.id} className="block">{item.title} · {localEndpoint(endpoint, placesById, t.tripSkeleton)}</span>
                            ))
                          : t.tripSkeleton.noArrival}
                      </li>
                      <li>
                        <strong>{t.tripSkeleton.luggageAndCheckIn}</strong>{" "}
                        {checkInItems.length > 0
                          ? checkInItems.map(({ item, endpoint }) => (
                              <span key={item.id} className="block">{item.title} · {localEndpoint(endpoint, placesById, t.tripSkeleton)}</span>
                            ))
                          : t.tripSkeleton.noCheckIn}
                      </li>
                      <li>
                        <strong>{t.tripSkeleton.remainingTime}</strong>{" "}
                        {usableTimeItems.length > 0
                          ? usableTimeItems.map(({ item, endpoint }) => (
                              <span key={item.id} className="block">{item.title} · {localEndpoint(endpoint, placesById, t.tripSkeleton)}</span>
                            ))
                          : t.tripSkeleton.noFreeTime}
                      </li>
                    </ol>
                  </aside>
                ) : null}
                {index === skeleton.days.length - 1 ? (
                  <aside className="day-context" data-testid="departure-priorities">
                    <p className="font-bold">{t.tripSkeleton.departurePriorities}</p>
                    <ol className="mt-2 grid gap-2">
                      <li>
                        <strong>{t.tripSkeleton.checkoutAndLuggage}</strong>{" "}
                        {checkOutItems.length > 0
                          ? checkOutItems.map(({ item, endpoint }) => (
                              <span key={item.id} className="block">{item.title} · {localEndpoint(endpoint, placesById, t.tripSkeleton)}</span>
                            ))
                          : t.tripSkeleton.noCheckout}
                      </li>
                      <li>
                        <strong>{t.tripSkeleton.transferAndDeparture}</strong>{" "}
                        {departureItems.length > 0
                          ? departureItems.map(({ item, endpoint }) => (
                              <span key={item.id} className="block">{item.title} · {localEndpoint(endpoint, placesById, t.tripSkeleton)}</span>
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
                            <span key={constraint.id} className="block">
                              {t.tripSkeleton.minimumBufferMinutes(constraint.minimumBufferMinutes!)}・{t.tripSkeleton.constraintStatuses[constraint.status]}
                            </span>
                          ))}
                        </li>
                      ) : null}
                    </ol>
                  </aside>
                ) : null}
              </header>
              <div className="grid gap-3">
                {day.entries.length === 0 && assignedPlaces.length === 0 ? (
                  <p className="empty-state">{t.tripSkeleton.openDay}</p>
                ) : null}
                {assignedPlaces.length > 0 ? (
                  <button
                    className="min-h-10 rounded-lg border border-accent px-3 font-bold"
                    disabled={busyId !== null}
                    onClick={() => setPlanningDay({ id: day.id, date: day.date, label: t.tripSkeleton.dayLabel(index + 1) })}
                  >
                    {t.tripSkeleton.planThisDay}
                  </button>
                ) : null}
                {assignedPlaces.map((place) => (
                  <article key={place.id} className="itinerary-card" aria-label={t.tripSkeleton.plannedWishlistPlace(place.name)}>
                    <p className="text-xs font-bold uppercase tracking-[0.14em] text-accent-strong">{t.tripSkeleton.wishlistTimeUnset}</p>
                    <h5 className="mt-1 font-display text-xl text-ink-strong">{place.name}</h5>
                    <p className="mt-2 text-sm text-muted-foreground">{place.address ?? t.tripSkeleton.addressUnknown}</p>
                    <p className="mt-2 text-sm">
                      {place.durationMinutes ? t.tripSkeleton.plannedDuration(place.durationMinutes) : t.tripSkeleton.durationUnknown}
                      {"・"}
                      {place.budgetAmountMinor !== null && place.budgetCurrency
                        ? formatMinorAmount(place.budgetAmountMinor, place.budgetCurrency, locale)
                        : t.tripSkeleton.costUnknown}
                    </p>
                    <button
                      className="mt-3 min-h-10 rounded-lg border px-3 font-bold"
                      disabled={busyId !== null}
                      onClick={() => void updateDayAssignments(null, [place])}
                    >
                      {t.tripSkeleton.removeFromDay}
                    </button>
                  </article>
                ))}
                {day.entries.map((entry) => {
                  const item = itemsById.get(entry.itemId);
                  return item ? renderItem(item, entry.projection === "continuation") : null;
                })}
                <DayAssignmentPicker
                  places={tripPlaces}
                  busy={busyId !== null}
                  assign={(places) => updateDayAssignments(day.id, places)}
                />
              </div>
            </section>
            );
          })}
        </div>
      </section>


      <Dialog open={unlockingItem !== null} onOpenChange={(open) => { if (!open) setUnlockingItem(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{unlockingItem ? t.tripSkeleton.unlockTitle(unlockingItem.title) : ""}</DialogTitle>
            <DialogDescription>{t.tripSkeleton.unlockDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnlockingItem(null)}>{t.tripSkeleton.keepLocked}</Button>
            <Button disabled={!unlockingItem || busyId === unlockingItem.id} onClick={() => unlockingItem && void itemAction(unlockingItem, "unlock")}><Unlock /> {t.tripSkeleton.unlockItem}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DayPlanDialog
        tripId={trip.id}
        day={planningDay}
        request={request}
        onClose={() => setPlanningDay(null)}
        onOrderSaved={load}
      />

      <TripPlanDialog
        tripId={trip.id}
        open={planningTrip}
        dayLabels={new Map(skeleton.days.map((day, index) => [day.id, t.tripSkeleton.dayLabel(index + 1)]))}
        request={request}
        onClose={() => setPlanningTrip(false)}
        onApplied={() => {
          setPlanningTrip(false);
          onPlacesChanged();
        }}
      />
      </section>
      {recentChangesContainer ? createPortal(recentChanges, recentChangesContainer) : null}
    </>
  );
}
