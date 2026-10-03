import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ItineraryItemDialog } from "./ItineraryItemDialog";
import { PlaceDialog } from "./PlaceDialog";

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
}

const itemTypeLabels: Record<ItineraryItemDto["type"], string> = {
  flight: "Flight",
  lodging: "Lodging",
  transport: "Transport",
  reservation: "Reservation",
  meal: "Meal",
  activity: "Activity",
  "free-time": "Free time",
};

const constraintLabels: Record<ConstraintDto["type"], string> = {
  fixed_time: "Fixed time",
  immovable: "Immovable",
  minimum_buffer: "Minimum buffer",
};

function localEndpoint(endpoint: ZonedEndpointDto, places: Map<string, PlaceDto>) {
  const place = places.get(endpoint.placeId);
  const abbreviation = new Intl.DateTimeFormat("en-US", {
    timeZone: endpoint.timeZone,
    timeZoneName: "short",
  }).formatToParts(new Date(endpoint.instant)).find((part) => part.type === "timeZoneName")?.value;
  return `${endpoint.localDateTime.replace("T", " ")} · ${endpoint.timeZone} (${abbreviation ?? endpoint.utcOffset}, ${endpoint.utcOffset}) · ${place?.name ?? "Unknown place"}`;
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

function itemDetails(item: ItineraryItemDto) {
  switch (item.type) {
    case "flight":
      return [item.details.carrier, item.details.serviceNumber, item.details.confirmationNotes].filter(Boolean).join(" · ");
    case "lodging":
      return [item.details.bookedBy ? `Booked by ${item.details.bookedBy}` : null, item.details.confirmationCode ? `Confirmation ${item.details.confirmationCode}` : null].filter(Boolean).join(" · ");
    case "transport":
      return [item.details.mode, item.details.ticketInfo].filter(Boolean).join(" · ");
    case "reservation":
    case "meal":
    case "activity":
      return [`${item.details.durationMinutes} min`, item.details.bookedBy ? `Booked by ${item.details.bookedBy}` : null, item.details.confirmationStatus].filter(Boolean).join(" · ");
    case "free-time":
      return `${item.details.durationMinutes} min`;
  }
}
function ParticipantSummary({ item }: { item: ItineraryItemDto }) {
  return (
    <div className="mt-3 text-sm" aria-label="Participants">
      <strong>Participants:</strong>{" "}
      {item.participants === null ? (
        <span className="text-muted-foreground">Pending confirmation</span>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
          {item.participants.map((participant) => (
            <li key={participant.memberId} className="min-w-0 [overflow-wrap:anywhere]">
              {participant.displayName ?? participant.email}
              {participant.removed ? " · removed" : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


function ConstraintBadge({ constraint }: { constraint: ConstraintDto }) {
  return (
    <span
      className="inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-bold"
      data-status={constraint.status}
    >
      {constraintLabels[constraint.type]}
      {constraint.type === "minimum_buffer" ? ` ${constraint.minimumBufferMinutes} min` : ""}
      {` · ${constraint.status}`}
    </span>
  );
}

function formatMinorAmount(amountMinor: number, currency: string) {
  const formatter = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amountMinor / (10 ** fractionDigits));
}

function DayAssignmentPicker({
  dayId,
  places,
  dayLabelById,
  busy,
  assign,
}: {
  dayId: string;
  places: TripPlaceDto[];
  dayLabelById: Map<string, string>;
  busy: boolean;
  assign(places: TripPlaceDto[]): Promise<void>;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectable = places.filter((place) =>
    !place.scheduled && place.assignedDayId !== dayId
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selected = selectable.filter((place) => selectedIds.includes(place.id));
    if (selected.length === 0) return;
    await assign(selected);
    setSelectedIds([]);
  }

  return (
    <details className="rounded-xl border border-ink/10 bg-surface p-3">
      <summary className="cursor-pointer font-bold">Add from shared wishlist</summary>
      {selectable.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">Every available wishlist place is already planned or scheduled.</p>
      ) : (
        <form className="mt-3 grid gap-3" onSubmit={(event) => void submit(event)}>
          <fieldset className="grid max-h-64 gap-2 overflow-y-auto">
            <legend className="sr-only">Wishlist places to add</legend>
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
                <span>
                  <strong className="block">{place.name}</strong>
                  <small className="text-muted-foreground">
                    {place.assignedDayId
                      ? `Currently planned for ${dayLabelById.get(place.assignedDayId) ?? "another day"}`
                      : place.address ?? "Address unknown"}
                  </small>
                </span>
              </label>
            ))}
          </fieldset>
          <button
            className="min-h-11 rounded-lg bg-accent px-4 font-bold text-ink-strong"
            disabled={busy || selectedIds.length === 0}
          >
            {busy ? "Adding…" : `Add selected (${selectedIds.length})`}
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
}: TripSkeletonWorkspaceProps) {
  const [skeleton, setSkeleton] = useState<TripSkeletonDto | null>(null);
  const [tripPlaces, setTripPlaces] = useState<TripPlaceDto[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [unlockingItem, setUnlockingItem] = useState<ItineraryItemDto | null>(null);
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
      setError(reason instanceof Error ? reason.message : "Could not load itinerary");
    }
  }, [request, trip.id]);

  useEffect(() => {
    setSkeleton(null);
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
    if (!skeleton) throw new Error("Itinerary is still loading");
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
    if (!window.confirm(`Delete ${place.name}? Referenced places cannot be deleted.`)) return;
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
      setError(reason instanceof Error ? reason.message : "Could not delete place");
    } finally {
      setBusyId(null);
    }
  }

  async function saveItem(input: CreateItineraryItemInput | UpdateItineraryItemInput, item?: ItineraryItemDto) {
    if (!skeleton) throw new Error("Itinerary is still loading");
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
      setError(reason instanceof Error ? reason.message : `Could not ${action} item`);
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
      setError(reason instanceof Error ? reason.message : "Could not update constraint");
    } finally {
      setBusyId(null);
    }
  }

  async function updateDayAssignments(
    tripDayId: string | null,
    places: TripPlaceDto[],
  ) {
    if (places.length === 0) return;
    const moved = tripDayId === null
      ? []
      : places.filter((place) =>
        place.assignedDayId !== null && place.assignedDayId !== tripDayId
      );
    if (
      moved.length > 0 &&
      !window.confirm(
        `Move ${moved.map((place) => place.name).join(", ")} from another day?`,
      )
    ) return;
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
      setError(reason instanceof Error ? reason.message : "Could not update planned day");
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
              {itemTypeLabels[item.type]}{continuation ? " · Continues" : ""}
            </p>
            <h4 className="mt-1 font-display text-xl text-ink-strong">{item.title}</h4>
          </div>
          {item.lockedAt ? <span className="locked-badge"><Lock className="size-3.5" /> Locked</span> : null}
        </div>
        <div className="mt-3 grid gap-1 text-sm text-muted-foreground">
          {start ? <p><strong>Start:</strong> {localEndpoint(start, placesById)}</p> : null}
          {end === "unrepresentable" ? (
            <p><strong>End:</strong> Cannot be shown because the duration exceeds the supported date range. Edit the duration.</p>
          ) : end ? (
            <p><strong>End:</strong> {localEndpoint(end, placesById)}</p>
          ) : null}
        </div>
        <ParticipantSummary item={item} />
        {!continuation ? (
          <>
            <p className="mt-3 text-sm">{itemDetails(item)}</p>
            {item.money ? (
              <p className="mt-2 text-sm font-semibold">{item.money.currency} {item.money.amountMinor} minor units</p>
            ) : null}
            {item.constraints.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {item.constraints.map((constraint) => <ConstraintBadge key={constraint.id} constraint={constraint} />)}
              </div>
            ) : null}
            {item.notes ? <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{item.notes}</p> : null}
            {item.sourceUrl ? <a className="mt-2 inline-block text-sm font-semibold text-accent-strong underline" href={item.sourceUrl} rel="noreferrer" target="_blank">Official source</a> : null}
            <div className="mt-4 flex flex-wrap gap-2">
              {item.lockedAt ? (
                <Button size="sm" variant="outline" disabled={busyId === item.id} onClick={() => setUnlockingItem(item)}><Unlock /> Unlock</Button>
              ) : (
                <>
                  <ItineraryItemDialog countryStops={trip.countryStops} members={trip.members} places={skeleton?.places ?? []} item={item} save={(input) => saveItem(input, item)} />
                  <Button size="sm" variant="outline" disabled={busyId === item.id} onClick={() => void itemAction(item, "lock")}><Lock /> Lock</Button>
                  <Button size="sm" variant="outline" disabled={busyId === item.id} onClick={() => void itemAction(item, "delete")}><Trash2 /> Delete</Button>
                </>
              )}
            </div>
            {item.constraints.map((constraint) => (
              <div key={`${constraint.id}-controls`} className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span>{constraintLabels[constraint.type]} status:</span>
                {(["confirmed", "unknown", "conflicted"] as const).map((status) => (
                  <Button key={status} size="xs" variant={constraint.status === status ? "default" : "outline"} disabled={busyId === constraint.id || item.lockedAt !== null} onClick={() => void setConstraintStatus(item, constraint, status)}>{status}</Button>
                ))}
              </div>
            ))}
          </>
        ) : null}
      </article>
    );
  }

  if (!skeleton) {
    return <section className="trip-skeleton-shell"><p role={error ? "alert" : "status"}>{error || "Loading itinerary…"}</p></section>;
  }
  const dayLabelById = new Map(skeleton.days.map((day) => [day.id, day.date]));

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

  return (
    <section className="trip-skeleton-shell" aria-labelledby="itinerary-heading">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">TRIP SKELETON</p>
          <h2 id="itinerary-heading" className="font-display text-3xl text-ink-strong">Commitments and daily timeline</h2>
          <p className="mt-2 max-w-3xl text-muted-foreground">Start with real Places, then anchor flights, stays, transport, reservations, meals, activities, and open time to local clocks.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <PlaceDialog save={(input) => savePlace(input)} />
          <ItineraryItemDialog countryStops={trip.countryStops} members={trip.members} places={skeleton.places} save={(input) => saveItem(input)} />
        </div>
      </div>

      {error ? <p role="alert" className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{error}</p> : null}

      <section className="mt-8" aria-labelledby="places-heading">
        <h3 id="places-heading" className="section-heading"><MapPin /> Places</h3>
        {skeleton.places.length === 0 ? (
          <p className="empty-state">No Places yet. Add the real airports, stations, stays, restaurants, and venues first.</p>
        ) : (
          <div className="place-grid">
            {skeleton.places.map((place) => (
              <article key={place.id} className="place-card">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-accent-strong">{place.type}</p>
                  <h4 className="mt-1 font-display text-lg">{place.name}</h4>
                  <p className="mt-2 text-sm text-muted-foreground">{place.address || "No address yet"}</p>
                  <p className="mt-1 text-sm">{place.timeZone || "No time zone yet"}</p>
                  {place.locationStatus !== "complete" ? <p className="mt-2 font-semibold text-accent-strong">位置待補充 · Location details incomplete</p> : null}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {lockedPlaceIds.has(place.id) ? (
                    <p className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                      <Lock className="size-4" /> Unlock the referencing item before editing this Place.
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
                    <Trash2 /> Delete
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="mt-10" aria-labelledby="trip-info-heading">
        <h3 id="trip-info-heading" className="section-heading"><Plane /> Trip information</h3>
        {tripInformationItems.length === 0 ? <p className="empty-state">Flights, lodging, and transport will also appear here for quick reference.</p> : (
          <div className="grid gap-3 lg:grid-cols-2">{tripInformationItems.map((item) => renderItem(item))}</div>
        )}
      </section>

      <section className="mt-10" aria-labelledby="timeline-heading">
        <h3 id="timeline-heading" className="section-heading"><CalendarDays /> Daily timeline</h3>
        <div className="timeline-grid">
          {skeleton.days.map((day, index) => {
            const assignedPlaces = tripPlaces.filter((place) =>
              !place.scheduled && place.assignedDayId === day.id
            );
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
              .map(([currency, amount]) => formatMinorAmount(amount, currency))
              .join(" + ");
            return (
            <section key={day.id} className="day-column" data-date={day.date}>
              <header className="day-heading">
                <p className="text-xs font-bold uppercase tracking-wider text-accent-strong">Day {index + 1}</p>
                <h4 className="font-display text-xl">{day.date}</h4>
                <p className="mt-2 text-sm font-semibold">
                  {assignedPlaces.length + day.entries.length} planned entries
                  {" · "}
                  {costSummary || "No known cost"}
                  {unknownCostCount > 0 ? ` · ${unknownCostCount} cost unknown` : ""}
                </p>
                {index === 0 ? (
                  <aside className="day-context" data-testid="arrival-priorities">
                    <p className="font-bold">Arrival priorities from saved commitments</p>
                    <ol className="mt-2 grid gap-2">
                      <li>
                        <strong>1 · Arrival:</strong>{" "}
                        {arrivalItems.length > 0
                          ? arrivalItems.map(({ item, endpoint }) => (
                              <span key={item.id} className="block">{item.title} · {localEndpoint(endpoint, placesById)}</span>
                            ))
                          : "No arrival endpoint anchored yet."}
                      </li>
                      <li>
                        <strong>2 · Luggage and check-in:</strong>{" "}
                        {checkInItems.length > 0
                          ? checkInItems.map(({ item, endpoint }) => (
                              <span key={item.id} className="block">{item.title} · {localEndpoint(endpoint, placesById)}</span>
                            ))
                          : "No lodging check-in anchored yet."}
                      </li>
                      <li>
                        <strong>3 · Remaining usable time:</strong>{" "}
                        {usableTimeItems.length > 0
                          ? usableTimeItems.map(({ item, endpoint }) => (
                              <span key={item.id} className="block">{item.title} · {localEndpoint(endpoint, placesById)}</span>
                            ))
                          : "No free-time block anchored yet."}
                      </li>
                    </ol>
                  </aside>
                ) : null}
                {index === skeleton.days.length - 1 ? (
                  <aside className="day-context" data-testid="departure-priorities">
                    <p className="font-bold">Departure priorities from saved commitments</p>
                    <ol className="mt-2 grid gap-2">
                      <li>
                        <strong>1 · Checkout and luggage:</strong>{" "}
                        {checkOutItems.length > 0
                          ? checkOutItems.map(({ item, endpoint }) => (
                              <span key={item.id} className="block">{item.title} · {localEndpoint(endpoint, placesById)}</span>
                            ))
                          : "No lodging checkout anchored yet."}
                      </li>
                      <li>
                        <strong>2 · Transfer and departure:</strong>{" "}
                        {departureItems.length > 0
                          ? departureItems.map(({ item, endpoint }) => (
                              <span key={item.id} className="block">{item.title} · {localEndpoint(endpoint, placesById)}</span>
                            ))
                          : "No departure endpoint anchored yet."}
                      </li>
                      <li>
                        <strong>3 · Protected buffer:</strong>{" "}
                        {confirmedDepartureBufferMinutes.length > 0
                          ? `${Math.max(...confirmedDepartureBufferMinutes)} minutes minimum`
                          : "No confirmed minimum departure buffer recorded."}
                      </li>
                      {unconfirmedDepartureBuffers.length > 0 ? (
                        <li>
                          <strong>Unconfirmed buffers:</strong>{" "}
                          {unconfirmedDepartureBuffers.map((constraint) => (
                            <span key={constraint.id} className="block">
                              {constraint.minimumBufferMinutes} minutes · {constraint.status}
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
                  <p className="empty-state">Open day. Add wishlist places, free time, or a commitment.</p>
                ) : null}
                {assignedPlaces.map((place) => (
                  <article key={place.id} className="itinerary-card" aria-label={`Planned wishlist place ${place.name}`}>
                    <p className="text-xs font-bold uppercase tracking-[0.14em] text-accent-strong">Wishlist place · time not set</p>
                    <h5 className="mt-1 font-display text-xl text-ink-strong">{place.name}</h5>
                    <p className="mt-2 text-sm text-muted-foreground">{place.address ?? "Address unknown"}</p>
                    <p className="mt-2 text-sm">
                      {place.durationMinutes ? `${place.durationMinutes} min planned` : "Duration unknown"}
                      {" · "}
                      {place.budgetAmountMinor !== null && place.budgetCurrency
                        ? formatMinorAmount(place.budgetAmountMinor, place.budgetCurrency)
                        : "Cost unknown"}
                    </p>
                    <button
                      className="mt-3 min-h-10 rounded-lg border px-3 font-bold"
                      disabled={busyId !== null}
                      onClick={() => void updateDayAssignments(null, [place])}
                    >
                      Remove from this day
                    </button>
                  </article>
                ))}
                {day.entries.map((entry) => {
                  const item = itemsById.get(entry.itemId);
                  return item ? renderItem(item, entry.projection === "continuation") : null;
                })}
                <DayAssignmentPicker
                  dayId={day.id}
                  places={tripPlaces}
                  dayLabelById={dayLabelById}
                  busy={busyId !== null}
                  assign={(places) => updateDayAssignments(day.id, places)}
                />
              </div>
            </section>
            );
          })}
        </div>
      </section>

      <section className="mt-10" aria-labelledby="activity-heading">
        <h3 id="activity-heading" className="section-heading"><Clock3 /> Recent changes</h3>
        {skeleton.events.length === 0 ? <p className="empty-state">No itinerary changes recorded yet.</p> : (
          <ol className="activity-list">
            {skeleton.events.map((event) => (
              <li key={event.id}>
                <p className="font-semibold">{event.summary}</p>
                <p className="text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString()} · {event.eventType}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <Dialog open={unlockingItem !== null} onOpenChange={(open) => { if (!open) setUnlockingItem(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unlock {unlockingItem?.title}?</DialogTitle>
            <DialogDescription>
              Unlocking restores editing and deletion. After unlocking, this commitment may be adjusted by a person or a future scheduling flow. The unlock does not alter it and is recorded in Recent changes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnlockingItem(null)}>Keep locked</Button>
            <Button disabled={!unlockingItem || busyId === unlockingItem.id} onClick={() => unlockingItem && void itemAction(unlockingItem, "unlock")}><Unlock /> Unlock item</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
