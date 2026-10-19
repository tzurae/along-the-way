import {
  parsePlanningDrafts, parsePutPlanningSettingsInput, parsePutPlanningOverrideInput, parseDeletePlanningOverrideInput,
  type PlanningDrafts, type PlanningLoadResponse, type PlanningOverrideResponse, type PlanningSettingsResponse,
  type PutPlanningSettingsInput, type PutPlanningOverrideInput, type DeletePlanningOverrideInput,
} from "@along-the-way/contracts/planning";
import type { Kysely, Transaction } from "kysely";
import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "../private-trips/private-trip-module";
import { lockMutation, recordEvent, remember, replayed, requireIdempotencyKey, requireScheduler } from "../private-trips/postgres-private-trip-store";
import { computeDayLoad } from "./day-load";
import { buildPlanningSnapshot } from "./planning-snapshot";
import { lockPlanningTrip, readPlanningSettings, requirePlanningMember, savePlanningDrafts } from "./planning-settings-store";

export interface PlanningSettingsModule {
  getSettings(userId: string, tripId: string): Promise<PlanningSettingsResponse>;
  putSettings(userId: string, tripId: string, key: string, input: PutPlanningSettingsInput): Promise<PlanningSettingsResponse>;
  getOverride(userId: string, tripId: string, dayId: string): Promise<PlanningOverrideResponse>;
  putOverride(userId: string, tripId: string, dayId: string, key: string, input: PutPlanningOverrideInput): Promise<PlanningOverrideResponse>;
  deleteOverride(userId: string, tripId: string, dayId: string, key: string, input: DeletePlanningOverrideInput): Promise<PlanningOverrideResponse>;
  getLoad(userId: string, tripId: string): Promise<PlanningLoadResponse>;
  previewLoad(userId: string, tripId: string, input: PlanningDrafts): Promise<PlanningLoadResponse>;
}

export class PostgresPlanningSettingsModule implements PlanningSettingsModule {
  private readonly database: Kysely<AlongTheWayDatabase>;
  constructor(options: { database: Kysely<AlongTheWayDatabase> }) { this.database = options.database; }

  async getSettings(userId: string, tripId: string): Promise<PlanningSettingsResponse> {
    return this.database.transaction().setIsolationLevel("repeatable read").execute(async (transaction) => {
      await requirePlanningMember(transaction, userId, tripId);
      return readPlanningSettings(transaction, tripId);
    });
  }
  async getOverride(userId: string, tripId: string, dayId: string): Promise<PlanningOverrideResponse> {
    return this.database.transaction().setIsolationLevel("repeatable read").execute(async (transaction) => {
      await requirePlanningMember(transaction, userId, tripId);
      return this.readOverride(transaction, tripId, dayId.toLowerCase());
    });
  }
  private async readOverride(transaction: Transaction<AlongTheWayDatabase>, tripId: string, dayId: string): Promise<PlanningOverrideResponse> {
    const snapshot = await buildPlanningSnapshot(transaction, tripId, { useAi: false });
    const response = snapshot.overrides[dayId];
    if (!response) throw new AppError("trip_day_not_found", "Trip day not found", 404);
    return response;
  }
  async putSettings(userId: string, tripId: string, rawKey: string, input: PutPlanningSettingsInput): Promise<PlanningSettingsResponse> {
    let parsed: PutPlanningSettingsInput;
    try { parsed = parsePutPlanningSettingsInput(input); }
    catch { throw new AppError("validation_error", "Invalid planning settings"); }
    return this.mutate(userId, tripId, rawKey, `planning-settings:${tripId}`, { draftSettings: parsed }, async (transaction) => {
      const days = await transaction.selectFrom("trip_days").select("id").where("trip_id", "=", tripId).execute();
      await recordEvent(transaction, { tripId, actorId: userId, eventType: "trip.planning_settings_updated",
        targetType: "trip", targetId: tripId, summary: "Updated trip planning settings", relatedTargetIds: days.map((day) => day.id) });
      return readPlanningSettings(transaction, tripId);
    });
  }
  async putOverride(userId: string, tripId: string, dayId: string, rawKey: string, input: PutPlanningOverrideInput): Promise<PlanningOverrideResponse> {
    let parsed: PutPlanningOverrideInput;
    try { parsed = parsePutPlanningOverrideInput(input); }
    catch { throw new AppError("validation_error", "Invalid planning override"); }
    return this.writeOverride(userId, tripId, dayId.toLowerCase(), rawKey, parsed.expectedVersion, parsed.values);
  }
  async deleteOverride(userId: string, tripId: string, dayId: string, rawKey: string, input: DeletePlanningOverrideInput): Promise<PlanningOverrideResponse> {
    let parsed: DeletePlanningOverrideInput;
    try { parsed = parseDeletePlanningOverrideInput(input); }
    catch { throw new AppError("validation_error", "Invalid planning override version"); }
    return this.writeOverride(userId, tripId, dayId.toLowerCase(), rawKey, parsed.expectedVersion, null);
  }
  private async writeOverride(userId: string, tripId: string, dayId: string, rawKey: string, expectedVersion: number, values: PutPlanningOverrideInput["values"] | null): Promise<PlanningOverrideResponse> {
    return this.mutate(userId, tripId, rawKey, `planning-override:${tripId}:${dayId}`, { draftOverrides: [{ dayId, expectedVersion, values }] }, async (transaction) => {
      await recordEvent(transaction, { tripId, actorId: userId, eventType: "trip_day.planning_override_updated",
        targetType: "trip_day", targetId: dayId, summary: values ? "Updated day planning override" : "Inherited trip planning settings", relatedTargetIds: [dayId] });
      return this.readOverride(transaction, tripId, dayId);
    });
  }
  private async mutate<T>(userId: string, tripId: string, rawKey: string, operation: string, drafts: PlanningDrafts, response: (transaction: Transaction<AlongTheWayDatabase>) => Promise<T>): Promise<T> {
    const key = requireIdempotencyKey(rawKey);
    return this.database.transaction().execute(async (transaction) => {
      await lockPlanningTrip(transaction, tripId);
      await requireScheduler(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replay as T;
      await savePlanningDrafts(transaction, userId, tripId, drafts);
      const result = await response(transaction);
      await remember(transaction, userId, operation, key, result);
      return result;
    });
  }
  async getLoad(userId: string, tripId: string): Promise<PlanningLoadResponse> {
    return this.load(userId, tripId);
  }
  async previewLoad(userId: string, tripId: string, input: PlanningDrafts): Promise<PlanningLoadResponse> {
    let drafts: PlanningDrafts;
    try { drafts = parsePlanningDrafts(input); }
    catch { throw new AppError("validation_error", "Invalid planning drafts"); }
    return this.load(userId, tripId, drafts);
  }
  private async load(userId: string, tripId: string, drafts?: PlanningDrafts): Promise<PlanningLoadResponse> {
    return this.database.transaction().setIsolationLevel("repeatable read").execute(async (transaction) => {
      if (drafts) await requireScheduler(transaction, userId, tripId);
      else await requirePlanningMember(transaction, userId, tripId);
      const snapshot = await buildPlanningSnapshot(transaction, tripId, { useAi: true, ...drafts });
      return {
        days: snapshot.input.days.map((day) => ({
          ...computeDayLoad(day, [...snapshot.input.flexiblePlaces.filter((place) => place.assignedDayId === day.id), ...day.pinned]
            .sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))),
          date: day.date, override: snapshot.overrides[day.id]!.raw, overrideVersion: snapshot.overrides[day.id]!.version,
        })),
        estimates: snapshot.estimates,
        counts: { flexible: snapshot.input.flexiblePlaces.length, fixedSelected: snapshot.fixedSelectedCount,
          days: snapshot.input.days.length, aiPending: snapshot.aiPending },
        settingsVersion: snapshot.settings.version,
      };
    });
  }
}
