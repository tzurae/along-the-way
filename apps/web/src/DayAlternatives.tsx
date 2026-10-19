import { useState } from "react";
import type { TripPlaceDto } from "@along-the-way/contracts/trip-places";
import {
  MAX_TRIP_DAY_ALTERNATIVES,
  parseTripDayAlternativesResponse,
  type TimelineDayDto,
  type TripDayAlternativesResponse,
} from "@along-the-way/contracts/trip-skeleton";
import { CalendarPlus, GitFork, MapPin, Plus, Search, X } from "lucide-react";

import { ApiRequestError } from "./api-error";
import { useI18n } from "./i18n";
import { PlaceDetailSheet } from "./PlaceDetailSheet";
import { placeArea } from "./PlaceFilters";

type JsonRequest = <T>(url: string, options?: RequestInit & { parse?: (value: unknown) => unknown }) => Promise<T>;

/** Replaces the day's whole 備案 list; the caller re-reads the itinerary afterwards. */
export async function saveDayAlternatives(
  request: JsonRequest,
  tripId: string,
  day: Pick<TimelineDayDto, "id" | "alternativesVersion">,
  tripPlaceIds: string[],
) {
  await request<TripDayAlternativesResponse>(`/api/trips/${tripId}/days/${day.id}/alternatives`, {
    method: "PUT",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ expectedVersion: day.alternativesVersion, tripPlaceIds }),
    parse: parseTripDayAlternativesResponse,
  });
}

/** 口袋名單 places that may become a 備案: not chosen for the itinerary and on no day. */
export function alternativeCandidates(places: TripPlaceDto[], day: TimelineDayDto) {
  const taken = new Set(day.alternativeTripPlaceIds);
  return places.filter((place) =>
    !place.selectedForItinerary && !place.scheduled && place.assignedDayId === null && !taken.has(place.id)
  );
}

/**
 * A day's 「備案」: places kept as on-the-spot alternatives (say, three more lunch spots near the
 * planned one). They are not stops, so they never join the day's order, route or load.
 */
export function DayAlternatives({
  tripId,
  day,
  places,
  canArrange,
  disabled,
  request,
  onChanged,
  placeOnDay,
  searchNew,
}: {
  tripId: string;
  day: TimelineDayDto;
  places: TripPlaceDto[];
  canArrange: boolean;
  disabled: boolean;
  request: JsonRequest;
  /** Re-reads the itinerary after the list changed or a save conflicted. */
  onChanged(): Promise<void>;
  /** Puts the place on this day as a stop; resolves false when that failed (error already shown). */
  placeOnDay(place: TripPlaceDto): Promise<boolean>;
  /** Opens Google Maps search / manual entry; the new place becomes a 備案 of this day. */
  searchNew(): void;
}) {
  const { t } = useI18n();
  const copy = t.tripSkeleton;
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const byId = new Map(places.map((place) => [place.id, place]));
  // A 備案 that has since become a stop of this very day is shown with the stops, not twice.
  const shown = day.alternativeTripPlaceIds
    .map((id) => byId.get(id))
    .filter((place): place is TripPlaceDto => place !== undefined && place.assignedDayId !== day.id);
  const candidates = alternativeCandidates(places, day);
  const full = shown.length >= MAX_TRIP_DAY_ALTERNATIVES;

  if (shown.length === 0 && !canArrange) return null;

  async function save(tripPlaceIds: string[]) {
    setBusy(true);
    setError("");
    try {
      await saveDayAlternatives(request, tripId, day, tripPlaceIds);
      await onChanged();
      return true;
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.code === "conflict") await onChanged();
      setError(reason instanceof ApiRequestError && reason.code === "conflict"
        ? copy.alternativesConflict
        : reason instanceof ApiRequestError && (reason.code === "forbidden" || reason.status === 403)
          ? t.schedule.ownerOnlyAction
          : reason instanceof Error ? reason.message : copy.alternativesSaveError);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const remaining = (placeId: string) => shown.map((place) => place.id).filter((id) => id !== placeId);

  return (
    <section className="plan-alternatives" aria-label={copy.alternativesTitle}>
      {shown.length > 0 ? (
        <>
          <h4>
            <GitFork aria-hidden="true" />
            {copy.alternativesTitle}
            <span>{copy.alternativesHint}</span>
          </h4>
          <ul>
            {shown.map((place) => {
              const area = placeArea(place.address);
              const located = place.latitude !== null && place.longitude !== null;
              return (
                <li key={place.id}>
                  <div className="plan-alternative-main">
                    <strong>{place.name}</strong>
                    <span>{[copy.placeTypes[place.type], area].filter(Boolean).join("・")}</span>
                  </div>
                  {canArrange ? (
                    <div className="plan-alternative-actions">
                      {located ? (
                        <button
                          type="button"
                          className="plan-route-link"
                          disabled={busy || disabled}
                          onClick={async () => {
                            setBusy(true);
                            setError("");
                            const placed = await placeOnDay(place);
                            setBusy(false);
                            // Once it is a stop it is no longer a 備案; the list drops it.
                            if (placed) await save(remaining(place.id));
                          }}
                        >
                          <CalendarPlus aria-hidden="true" />
                          {copy.useAlternative}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="plan-icon-button"
                        aria-label={copy.removeAlternative(place.name)}
                        disabled={busy || disabled}
                        onClick={() => void save(remaining(place.id))}
                      >
                        <X aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {error ? <p role="alert" className="plan-row-error">{error}</p> : null}
      {canArrange && !full ? (
        <button
          type="button"
          className="plan-route-link plan-alternatives-add"
          disabled={busy || disabled}
          onClick={() => {
            setError("");
            setPicking(true);
          }}
        >
          <Plus aria-hidden="true" />
          {copy.addAlternative}
        </button>
      ) : null}
      {picking ? (
        <PlaceDetailSheet
          appearance="workspace"
          open
          title={copy.addAlternativeTitle}
          description={copy.addAlternativeHelper}
          onClose={() => setPicking(false)}
        >
          <button
            type="button"
            className="plan-outline-button plan-add-new-place"
            disabled={busy}
            onClick={() => {
              setPicking(false);
              searchNew();
            }}
          >
            <Search aria-hidden="true" />
            {copy.addNewPlace}
          </button>
          <section className="plan-source">
            <h3>{copy.pocketSourceTitle}</h3>
            {candidates.length === 0 ? (
              <div className="plan-source-empty">
                <MapPin aria-hidden="true" />
                <span>{copy.noAlternativeCandidates}</span>
              </div>
            ) : (
              <ul className="plan-source-list">
                {candidates.map((place) => (
                  <li key={place.id} className="plan-source-row">
                    <div className="plan-place-main">
                      <div className="plan-place-name">
                        <strong>{place.name}</strong>
                        <span className="plan-kind-chip">{copy.placeTypes[place.type]}</span>
                      </div>
                      {placeArea(place.address) ? (
                        <div className="plan-place-meta"><span>{placeArea(place.address)}</span></div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="plan-schedule-button"
                      disabled={busy}
                      onClick={async () => {
                        if (await save([...shown.map((entry) => entry.id), place.id])) setPicking(false);
                      }}
                    >
                      <GitFork aria-hidden="true" />
                      {copy.makeAlternative}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {error ? <p role="alert" className="plan-row-error">{error}</p> : null}
          </section>
        </PlaceDetailSheet>
      ) : null}
    </section>
  );
}
