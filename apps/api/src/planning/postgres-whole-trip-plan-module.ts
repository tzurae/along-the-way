import { randomUUID } from "node:crypto";
import {
  parseWholeTripPlanPreviewInput,
  type ApplyWholeTripPlanResponse,
  type WholeTripPlanPreviewInput,
  type WholeTripPlanProposalDto,
} from "@along-the-way/contracts/planning";
import type { Kysely, Selectable } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "../private-trips/private-trip-module";
import {
  isoTimestamp,
  lockMutation,
  recordEvent,
  remember,
  replayed,
  requireIdempotencyKey,
  requireScheduler,
} from "../private-trips/postgres-private-trip-store";
import {
  PLANNER_MAX_DAYS,
  PLANNER_MAX_FLEXIBLE_PLACES,
  type PlannerFrozenEstimates,
  type PlannerResult,
} from "./planner-model";
import {
  changedPlanningEntityIds,
  planningInputRevision,
  type PlanningRevisionInput,
} from "./planning-input-revision";
import { buildPlanningSnapshot } from "./planning-snapshot";
import { lockPlanningTrip, savePlanningDrafts } from "./planning-settings-store";
import { solveWholeTrip } from "./whole-trip-solver";
import { validateWholeTripPlan } from "./whole-trip-validator";
import { writeWholeTripPlan } from "./write-whole-trip-plan";

const PROPOSAL_LIFETIME_MS = 30 * 60 * 1_000;
const INPUT_TOO_LARGE_MESSAGE = "這趟行程超過自動排程支援的範圍（30 天、150 個地點）。可以先減少已選地點，或手動安排。";

interface StoredProposal {
  schemaVersion: 1;
  request: WholeTripPlanPreviewInput;
  revisionInput: PlanningRevisionInput;
  estimates: PlannerFrozenEstimates;
  result: PlannerResult;
}

type ProposalRow = Selectable<AlongTheWayDatabase["whole_trip_plan_proposals"]>;

export interface WholeTripPlanModule {
  preview(userId: string, tripId: string, input: unknown, consumeRateLimit: () => Promise<void>): Promise<WholeTripPlanProposalDto>;
  getProposal(userId: string, tripId: string, proposalId: string): Promise<WholeTripPlanProposalDto>;
  apply(userId: string, tripId: string, proposalId: string, idempotencyKey: string): Promise<ApplyWholeTripPlanResponse>;
}

/** Proposal storage is the only preview write. All itinerary writes live inside apply's transaction. */
export class PostgresWholeTripPlanModule implements WholeTripPlanModule {
  private readonly database: Kysely<AlongTheWayDatabase>;
  private readonly now: () => Date;

  constructor(options: { database: Kysely<AlongTheWayDatabase>; now?: () => Date }) {
    this.database = options.database;
    this.now = options.now ?? (() => new Date());
  }

  async preview(
    userId: string,
    tripId: string,
    rawInput: unknown,
    consumeRateLimit: () => Promise<void>,
  ): Promise<WholeTripPlanProposalDto> {
    let request: WholeTripPlanPreviewInput;
    try {
      request = parseWholeTripPlanPreviewInput(rawInput);
    } catch {
      throw new AppError("validation_error", "自動排程設定格式不正確");
    }
    await requireScheduler(this.database, userId, tripId);
    await consumeRateLimit();
    // One MVCC snapshot, without the legacy read/reconcile writers or an itinerary row lock.
    return this.database.transaction().setIsolationLevel("repeatable read").execute(async (transaction) => {
      await requireScheduler(transaction, userId, tripId);
      const snapshot = await buildPlanningSnapshot(transaction, tripId, request);
      if (snapshot.input.days.length > PLANNER_MAX_DAYS
        || snapshot.input.flexiblePlaces.length > PLANNER_MAX_FLEXIBLE_PLACES) {
        throw new AppError("planner_input_too_large", INPUT_TOO_LARGE_MESSAGE, 422);
      }
      const estimates = snapshot.estimates;
      const result = solveWholeTrip(snapshot.input);
      if (result.status === "complete" && !validateWholeTripPlan(snapshot.input, result).valid) {
        throw new Error("Whole-trip solver produced an invalid complete result");
      }
      const createdAt = this.now();
      const payload: StoredProposal = { schemaVersion: 1, request, revisionInput: snapshot.revisionInput, estimates, result };
      const row = await transaction.insertInto("whole_trip_plan_proposals").values({
        id: randomUUID(),
        trip_id: tripId,
        created_by: userId,
        input_revision: planningInputRevision(snapshot.revisionInput),
        payload,
        created_at: createdAt,
        expires_at: new Date(createdAt.valueOf() + PROPOSAL_LIFETIME_MS),
      }).returningAll().executeTakeFirstOrThrow();
      return this.proposalDto(row, payload);
    });
  }

  async getProposal(userId: string, tripId: string, proposalId: string): Promise<WholeTripPlanProposalDto> {
    // Join membership to the lookup so removal cannot race an earlier access check.
    const row = await this.database.selectFrom("whole_trip_plan_proposals as proposal")
      .innerJoin("trip_members as member", "member.trip_id", "proposal.trip_id")
      .selectAll("proposal")
      .where("proposal.trip_id", "=", tripId).where("proposal.id", "=", proposalId)
      .where("proposal.expires_at", ">", this.now())
      .where("member.user_id", "=", userId).where("member.removed_at", "is", null)
      .executeTakeFirst();
    if (!row) throw new AppError("whole_trip_plan_not_found", "排程草稿不存在或已過期，請重新建立草稿", 404);
    const payload = this.storedProposal(row);
    return this.proposalDto(row, payload);
  }

  async apply(userId: string, tripId: string, proposalId: string, rawKey: string): Promise<ApplyWholeTripPlanResponse> {
    const key = requireIdempotencyKey(rawKey);
    const operation = `wtp:apply:${tripId.toLowerCase()}:${proposalId.toLowerCase()}`;
    return this.database.transaction().execute(async (transaction) => {
      // First row lock is always the trip, matching every itinerary/settings writer.
      await lockPlanningTrip(transaction, tripId);
      await requireScheduler(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const row = await transaction.selectFrom("whole_trip_plan_proposals").selectAll()
        .where("trip_id", "=", tripId).where("id", "=", proposalId)
        .where("expires_at", ">", this.now()).forUpdate().executeTakeFirst();
      if (!row) throw new AppError("whole_trip_plan_not_found", "排程草稿不存在或已過期，請重新建立草稿", 404);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return replay as ApplyWholeTripPlanResponse;
      const payload = this.storedProposal(row);
      if (payload.result.status !== "complete") {
        throw new AppError("plan_not_complete", "只有全部地點都排好且符合設定的草稿可以套用", 409);
      }
      // Canonical provider facts are shared across trips; their writers do not all hold this trip lock.
      await transaction.selectFrom("place_identities").select("id")
        .where("id", "in", transaction.selectFrom("trip_places").select("place_id")
          .where("trip_id", "=", tripId).where("archived_at", "is", null))
        .orderBy("id").forShare().execute();
      // Compare saved inputs before touching drafts: even a deleted draft day must report plan_stale.
      const current = await buildPlanningSnapshot(transaction, tripId, { mode: payload.request.mode, useAi: false });
      if (planningInputRevision(current.revisionInput) !== row.input_revision) {
        throw new AppError("plan_stale", "行程在你看草稿時被改過了", 409, undefined, undefined, undefined,
          changedPlanningEntityIds(payload.revisionInput, current.revisionInput, tripId));
      }
      const hasDrafts = Boolean(payload.request.draftSettings || payload.request.draftOverrides?.length);
      if (hasDrafts) await savePlanningDrafts(transaction, userId, tripId, payload.request);
      // Validate the values actually saved by the draft writer, never a second AI publication.
      const snapshot = await buildPlanningSnapshot(transaction, tripId, {
        mode: payload.request.mode, useAi: false, frozenEstimates: payload.estimates,
      });
      const validation = validateWholeTripPlan(snapshot.input, payload.result);
      if (!validation.valid) throw new Error("Stored whole-trip proposal failed independent apply validation");
      const appliedAt = this.now();
      const written = await writeWholeTripPlan(transaction, userId, tripId, snapshot.input, payload.result, appliedAt);
      // Verify the persisted projection too; any trigger/snapshot mismatch rolls back every write.
      const appliedSnapshot = await buildPlanningSnapshot(transaction, tripId, {
        mode: payload.request.mode, useAi: false, frozenEstimates: payload.estimates,
      });
      if (!validateWholeTripPlan(appliedSnapshot.input, payload.result).valid) {
        throw new Error("Persisted whole-trip plan failed independent apply validation");
      }
      // The validator checks the stored result against rebuilt days; also prove the rows now say
      // exactly that result (day and order), so a trigger rewrite cannot slip through.
      const persisted = [...appliedSnapshot.input.flexiblePlaces, ...appliedSnapshot.input.excludedPlaces];
      for (const day of payload.result.days) {
        const persistedOrder = persisted
          .filter((place) => place.assignedDayId === day.dayId)
          .sort((left, right) => (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER))
          .map((place) => place.id);
        if (persistedOrder.join("\n") !== day.orderedPlaceIds.join("\n")) {
          throw new Error("Persisted whole-trip plan does not match the applied proposal");
        }
      }
      const dayIds = new Set(written.affectedDayIds);
      if (payload.request.draftSettings) {
        for (const day of snapshot.input.days) dayIds.add(day.id);
      }
      for (const override of payload.request.draftOverrides ?? []) dayIds.add(override.dayId);
      const response: ApplyWholeTripPlanResponse = {
        proposalId: row.id,
        placedCount: snapshot.input.flexiblePlaces.length,
        dayIds: [...dayIds].sort(),
      };
      // Settings, overrides and placements share one aggregate event and one rollback boundary.
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "whole_trip_plan.applied",
        targetType: "trip",
        targetId: tripId,
        summary: `Applied a complete whole-trip plan for ${response.placedCount} places`,
        relatedTargetIds: [...response.dayIds, ...written.changedPlaceIds],
      });
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  private storedProposal(row: ProposalRow): StoredProposal {
    const payload = row.payload as StoredProposal;
    if (payload?.schemaVersion !== 1 || !payload.request || !payload.revisionInput || !payload.estimates || !payload.result) {
      throw new Error("Unsupported whole-trip proposal payload");
    }
    return payload;
  }

  private proposalDto(row: ProposalRow, payload: StoredProposal): WholeTripPlanProposalDto {
    return {
      id: row.id,
      tripId: row.trip_id,
      createdAt: isoTimestamp(row.created_at),
      expiresAt: isoTimestamp(row.expires_at),
      inputRevision: row.input_revision,
      ...payload.request,
      estimates: payload.estimates,
      result: payload.result,
    };
  }
}
