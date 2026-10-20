import { sql, type Transaction } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "../private-trips/private-trip-module";
import { PostgresTripPlaceModule } from "../trip-places/postgres-trip-place-module";
import type { PlannerInput, PlannerResult } from "./planner-model";

/** Caller owns the trip lock, freshness check and validation; no nested transaction or event. */
export async function writeWholeTripPlan(
  transaction: Transaction<AlongTheWayDatabase>,
  userId: string,
  tripId: string,
  input: PlannerInput,
  result: PlannerResult,
  appliedAt: Date,
): Promise<{ affectedDayIds: string[]; changedPlaceIds: string[] }> {
  if (result.status !== "complete") throw new Error("Bulk planning writes require a complete proposal");
  const flexible = new Map(input.flexiblePlaces.map((place) => [place.id, place]));
  const pinned = new Map(input.days.flatMap((day) => day.pinned.map((place) => [place.id, day.id] as const)));
  const placements = new Map<string, { dayId: string; position: number }>();
  const dayIds = new Set(input.days.map((day) => day.id));
  const outputDays = new Set<string>();
  for (const day of result.days) {
    if (!dayIds.has(day.dayId) || outputDays.has(day.dayId)) throw new Error("Invalid planner output day");
    outputDays.add(day.dayId);
    for (const [position, id] of day.orderedPlaceIds.entries()) {
      if (placements.has(id) || (!flexible.has(id) && !pinned.has(id))) {
        throw new Error("Invalid planner output place");
      }
      if (pinned.has(id) && pinned.get(id) !== day.dayId) throw new Error("Pinned places cannot move days");
      const place = flexible.get(id);
      if (input.mode === "keep" && place?.assignedDayId && place.assignedDayId !== day.dayId) {
        throw new Error("Keep mode cannot move an existing assignment");
      }
      placements.set(id, { dayId: day.dayId, position });
    }
  }
  if (outputDays.size !== dayIds.size || placements.size !== flexible.size + pinned.size) {
    throw new Error("Partial planner output cannot be applied");
  }
  const ids = [...placements.keys()].sort();
  if (ids.length === 0) return { affectedDayIds: [], changedPlaceIds: [] };

  const days = await transaction.selectFrom("trip_days").select("id")
    .where("trip_id", "=", tripId).orderBy("id").forUpdate().execute();
  if (days.length !== dayIds.size || days.some((day) => !dayIds.has(day.id))) {
    throw new AppError("plan_stale", "行程在你看草稿時被改過了", 409, undefined, undefined, undefined, [...dayIds]);
  }
  const places = await transaction.selectFrom("trip_places")
    .select(["id", "legacy_place_id", "selected_for_itinerary", "unplaced_from_date"])
    .where("trip_id", "=", tripId).where("id", "in", ids).where("archived_at", "is", null)
    .orderBy("id").forUpdate().execute();
  if (places.length !== ids.length || places.some((place) => !place.selected_for_itinerary)) {
    throw new AppError("plan_stale", "行程在你看草稿時被改過了", 409, undefined, undefined, undefined, ids);
  }
  // Never bypass the timed-endpoint guard, even for an order-only write.
  const scheduled = await transaction.selectFrom("itinerary_endpoints").select("place_id")
    .where("trip_id", "=", tripId).where("place_id", "in", places.map((place) => place.legacy_place_id))
    .executeTakeFirst();
  if (scheduled) {
    throw new AppError("plan_stale", "行程在你看草稿時被改過了", 409, undefined, undefined, undefined,
      places.filter((place) => place.legacy_place_id === scheduled.place_id).map((place) => place.id));
  }
  const assignments = await transaction.selectFrom("trip_place_day_assignments")
    .select(["trip_place_id", "trip_day_id", "day_position"])
    .where("trip_id", "=", tripId).where("trip_place_id", "in", ids)
    .orderBy("trip_place_id").forUpdate().execute();
  const assignmentById = new Map(assignments.map((assignment) => [assignment.trip_place_id, assignment]));
  const affectedDays = new Set<string>();
  const changedPlaceIds: string[] = [];
  const movedIds: string[] = [];
  for (const place of places) {
    const placement = placements.get(place.id)!;
    const previous = assignmentById.get(place.id);
    if (pinned.has(place.id) && previous?.trip_day_id !== placement.dayId) {
      throw new AppError("plan_stale", "行程在你看草稿時被改過了", 409, undefined, undefined, undefined, [place.id]);
    }
    const moved = previous?.trip_day_id !== placement.dayId;
    if (!moved && previous?.day_position === placement.position && place.unplaced_from_date === null) continue;
    changedPlaceIds.push(place.id);
    if (moved) movedIds.push(place.id);
    if (previous) affectedDays.add(previous.trip_day_id);
    affectedDays.add(placement.dayId);
  }
  // 007's trigger owns the assignment rows. Rewriting only its projection would be lost on the next edit.
  if (movedIds.length > 0) {
    await transaction.deleteFrom("trip_place_desired_days")
      .where("trip_id", "=", tripId).where("trip_place_id", "in", movedIds).execute();
    await transaction.insertInto("trip_place_desired_days").values(movedIds.map((id) => ({
      trip_id: tripId,
      trip_place_id: id,
      trip_day_id: placements.get(id)!.dayId,
    }))).execute();
  }
  for (const id of changedPlaceIds) {
    const placement = placements.get(id)!;
    // 020 bumps and tracks old/new/order-only day versions for every assignment mutation.
    const assignment = await transaction.updateTable("trip_place_day_assignments").set({
      day_position: placement.position,
      assigned_by: userId,
      assigned_at: appliedAt,
    }).where("trip_id", "=", tripId).where("trip_place_id", "=", id)
      .where("trip_day_id", "=", placement.dayId).returning("trip_place_id").executeTakeFirst();
    if (!assignment) throw new Error("Desired-day trigger did not produce the planned assignment");
  }
  if (changedPlaceIds.length > 0) {
    await transaction.updateTable("trip_places").set({
      selected_for_itinerary: true,
      unplaced_from_date: null,
      version: sql`version + 1`,
      updated_at: appliedAt,
    }).where("trip_id", "=", tripId).where("id", "in", changedPlaceIds).execute();
  }
  await PostgresTripPlaceModule.supersedeInvalidStopReplacements(transaction, tripId, movedIds, appliedAt);
  return { affectedDayIds: [...affectedDays].sort(), changedPlaceIds };
}
