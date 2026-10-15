import type { TripDto } from "@along-the-way/contracts/private-trips";

/**
 * Whether this member may arrange the itinerary: place, move, order or remove scheduled places.
 * Mirrors the API's `requireScheduler`: the owner always, editors once the owner allows it.
 */
export function canArrangeItinerary(trip: Pick<TripDto, "role" | "editorsCanSchedule">) {
  return trip.role === "owner" || trip.editorsCanSchedule;
}
