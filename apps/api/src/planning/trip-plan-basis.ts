import { createHash } from "node:crypto";

import type { DatabaseExecutor } from "../private-trips/postgres-private-trip-store";

/**
 * A fingerprint of everything a trip plan depends on: the trip version, every itinerary item
 * and its place (fixed times, lodging, buffers), every wishlist place's version, which day
 * each place is on, in what position and reached how, and each day's hours and way of travel.
 * A plan may only be used while the fingerprint is unchanged.
 */
export async function tripPlanBasis(executor: DatabaseExecutor, tripId: string) {
  const [trip, items, constraints, itemPlaces, places, assignments, days] = await Promise.all([
    executor.selectFrom("trips").select("version").where("id", "=", tripId).executeTakeFirst(),
    // Item and buffer edits bump their own versions, not the trip's.
    executor.selectFrom("itinerary_items").select(["id", "version"])
      .where("trip_id", "=", tripId).orderBy("id").execute(),
    executor.selectFrom("itinerary_constraints").select(["id", "version"])
      .where("trip_id", "=", tripId).orderBy("id").execute(),
    executor.selectFrom("places").select(["id", "version"])
      .where("trip_id", "=", tripId).orderBy("id").execute(),
    executor.selectFrom("trip_places").select(["id", "version"])
      .where("trip_id", "=", tripId).where("archived_at", "is", null).orderBy("id").execute(),
    executor.selectFrom("trip_place_day_assignments").select(["trip_place_id", "trip_day_id", "day_position", "arrival_mode"])
      .where("trip_id", "=", tripId).orderBy("trip_place_id").execute(),
    executor.selectFrom("trip_days").select(["id", "day_start_minute", "day_end_minute", "travel_mode", "walk_limit_minutes"])
      .where("trip_id", "=", tripId).orderBy("id").execute(),
  ]);
  const snapshot = JSON.stringify([
    trip?.version ?? null,
    items.map((row) => [row.id, row.version]),
    constraints.map((row) => [row.id, row.version]),
    itemPlaces.map((row) => [row.id, row.version]),
    places.map((row) => [row.id, row.version]),
    assignments.map((row) => [row.trip_place_id, row.trip_day_id, row.day_position, row.arrival_mode]),
    days.map((row) => [row.id, row.day_start_minute, row.day_end_minute, row.travel_mode, row.walk_limit_minutes]),
  ]);
  return createHash("sha256").update(snapshot).digest("hex");
}
