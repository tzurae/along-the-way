import {
  DEFAULT_PLANNING_SETTINGS, EMPTY_PLANNING_OVERRIDE, OVERRIDABLE_PLANNING_FIELDS, PACE_PRESETS,
  parsePlanningSettings, parsePlanningOverride, resolvePlanningSettings, validatePlanningCrossFields,
  type PlanningOverride, type PlanningSettings, type PlanningDrafts,
} from "@along-the-way/contracts/planning";
import type { Selectable, Transaction } from "kysely";
import type { AlongTheWayDatabase, TripDayPlanningOverrideTable, TripPlanningSettingsTable } from "../database/database";
import { AppError } from "../private-trips/private-trip-module";
import type { DatabaseExecutor } from "../private-trips/postgres-private-trip-store";

export function planningSettingsFromRow(row: Selectable<TripPlanningSettingsTable>): PlanningSettings {
  return { pacePreset: row.pace_preset, targetPlacesPerDay: row.target_places_per_day,
    maxPlacesPerDay: row.max_places_per_day, dayStart: row.day_start, dayEnd: row.day_end,
    maxEffortPerDay: row.max_effort_per_day, mealReserveMinutes: row.meal_reserve_minutes,
    restMinutes: row.rest_minutes, slackPercent: row.slack_percent, travelProfile: row.travel_profile,
    speedKmh: row.speed_kmh, detourFactor: row.detour_factor, perLegMinutes: row.per_leg_minutes,
    lightTravelDays: row.light_travel_days };
}
export function planningOverrideFromRow(row: Selectable<TripDayPlanningOverrideTable>): PlanningOverride | null {
  const values: PlanningOverride = { targetPlacesPerDay: row.target_places_per_day, maxPlacesPerDay: row.max_places_per_day,
    dayStart: row.day_start, dayEnd: row.day_end, maxEffortPerDay: row.max_effort_per_day,
    // max_daily_straight_km / max_hop_straight_km are no longer read (km caps removed 2026-10-19).
    mealReserveMinutes: row.meal_reserve_minutes, restMinutes: row.rest_minutes, slackPercent: row.slack_percent };
  return Object.values(values).every((value) => value === null) ? null : values;
}
function overrideColumns(value: PlanningOverride) {
  return { target_places_per_day: value.targetPlacesPerDay, max_places_per_day: value.maxPlacesPerDay,
    day_start: value.dayStart, day_end: value.dayEnd, max_effort_per_day: value.maxEffortPerDay,
    // Unused km columns stay null (owner decision 2026-10-19: keep columns, no new migration yet).
    max_daily_straight_km: null, max_hop_straight_km: null,
    meal_reserve_minutes: value.mealReserveMinutes, rest_minutes: value.restMinutes, slack_percent: value.slackPercent };
}
export async function readPlanningSettings(executor: DatabaseExecutor, tripId: string) {
  const row = await executor.selectFrom("trip_planning_settings").selectAll().where("trip_id", "=", tripId).executeTakeFirst();
  const raw = row ? planningSettingsFromRow(row) : null;
  return { raw, resolved: raw ?? { ...DEFAULT_PLANNING_SETTINGS }, defaults: { ...DEFAULT_PLANNING_SETTINGS }, version: row?.version ?? 0 };
}
export async function requirePlanningMember(executor: DatabaseExecutor, userId: string, tripId: string): Promise<void> {
  const member = await executor.selectFrom("trip_members").select("id").where("trip_id", "=", tripId)
    .where("user_id", "=", userId).where("removed_at", "is", null).executeTakeFirst();
  if (!member) throw new AppError("trip_not_found", "Trip not found", 404);
}
export async function lockPlanningTrip(transaction: Transaction<AlongTheWayDatabase>, tripId: string): Promise<void> {
  const trip = await transaction.selectFrom("trips").select("id").where("id", "=", tripId).forUpdate().executeTakeFirst();
  if (!trip) throw new AppError("trip_not_found", "Trip not found", 404);
}

/** Caller owns trip-first lock, authorization, idempotency and the single aggregate event. */
export async function savePlanningDrafts(transaction: Transaction<AlongTheWayDatabase>, userId: string, tripId: string, drafts: PlanningDrafts): Promise<void> {
  const settings = await readPlanningSettings(transaction, tripId);
  const rows = await transaction.selectFrom("trip_day_planning_overrides").selectAll().where("trip_id", "=", tripId).execute();
  const byDay = new Map(rows.map((row) => [row.day_id, row]));
  const dayRows = await transaction.selectFrom("trip_days").select("id").where("trip_id", "=", tripId).execute();
  const dayIds = new Set(dayRows.map((row) => row.id));
  const values = drafts.draftSettings?.values ?? settings.resolved;
  if (drafts.draftSettings && drafts.draftSettings.expectedVersion !== settings.version) {
    throw new AppError("conflict", "Planning settings changed", 409, undefined, settings.version, tripId);
  }
  for (const draft of drafts.draftOverrides ?? []) {
    if (!dayIds.has(draft.dayId)) throw new AppError("trip_day_not_found", "Trip day not found", 404);
    const currentVersion = byDay.get(draft.dayId)?.version ?? 0;
    if (draft.expectedVersion !== currentVersion) throw new AppError("conflict", "Planning override changed", 409, undefined, currentVersion, draft.dayId);
  }
  try {
    parsePlanningSettings(values);
    for (const dayId of dayIds) {
      const draft = drafts.draftOverrides?.find((entry) => entry.dayId === dayId);
      const row = byDay.get(dayId);
      const override = draft ? draft.values : row ? planningOverrideFromRow(row) : null;
      if (override) parsePlanningOverride(override);
      validatePlanningCrossFields(resolvePlanningSettings(values, override, false));
    }
  } catch { throw new AppError("validation_error", "Planning values must leave a positive budget, with target at most maximum and start before end"); }
  const now = new Date();
  if (drafts.draftSettings) {
    let pacePreset = values.pacePreset;
    if (pacePreset !== "custom") {
      const preset = PACE_PRESETS[pacePreset];
      const changedTravel = values.travelProfile !== settings.resolved.travelProfile
        || values.speedKmh !== settings.resolved.speedKmh || values.detourFactor !== settings.resolved.detourFactor
        || values.perLegMinutes !== settings.resolved.perLegMinutes || values.lightTravelDays !== settings.resolved.lightTravelDays;
      if (OVERRIDABLE_PLANNING_FIELDS.some((key) => values[key] !== preset[key]) || changedTravel) pacePreset = "custom";
    }
    const columns = {
      target_places_per_day: values.targetPlacesPerDay, max_places_per_day: values.maxPlacesPerDay,
      day_start: values.dayStart, day_end: values.dayEnd, max_effort_per_day: values.maxEffortPerDay,
      // Unused since the km caps were removed (2026-10-19). The columns are NOT NULL in 037, so
      // they get the old maxima until a cleanup migration drops them.
      max_daily_straight_km: 100, max_hop_straight_km: 50,
      meal_reserve_minutes: values.mealReserveMinutes, rest_minutes: values.restMinutes, slack_percent: values.slackPercent,
      pace_preset: pacePreset, travel_profile: values.travelProfile, speed_kmh: values.speedKmh,
      detour_factor: values.detourFactor, per_leg_minutes: values.perLegMinutes, light_travel_days: values.lightTravelDays,
      version: settings.version + 1, updated_by: userId, updated_at: now,
    };
    await transaction.insertInto("trip_planning_settings").values({ trip_id: tripId, ...columns })
      .onConflict((conflict) => conflict.column("trip_id").doUpdateSet(columns)).execute();
  }
  for (const draft of drafts.draftOverrides ?? []) {
    const columns = { ...overrideColumns(draft.values ?? EMPTY_PLANNING_OVERRIDE),
      version: (byDay.get(draft.dayId)?.version ?? 0) + 1, updated_by: userId, updated_at: now };
    await transaction.insertInto("trip_day_planning_overrides").values({ day_id: draft.dayId, trip_id: tripId, ...columns })
      .onConflict((conflict) => conflict.column("day_id").doUpdateSet(columns)).execute();
  }
}
