import {
  DISCOVERY_STAGES,
  type DiscoveryJobDto,
  type DiscoveryStage,
  type DiscoveryStageState,
} from "@along-the-way/contracts/discovery";
import { sql, type Kysely, type Selectable } from "kysely";

import type { AlongTheWayDatabase, DiscoveryJobTable } from "../database/database";

/** A running job that stopped reporting for this long died with its process (deploy, crash). */
const JOB_HEARTBEAT_STALE_MS = 3 * 60 * 1_000;
/** A queued job nobody picked up for this long is dropped (worker down). */
const JOB_QUEUE_EXPIRY_MS = 10 * 60 * 1_000;

export interface ClaimedDiscoveryJob {
  id: string;
  tripId: string;
  briefVersion: number;
  createdBy: string;
  clientIp: string;
}

type StageRecord = DiscoveryJobDto["stages"];

export function emptyStages(): StageRecord {
  return Object.fromEntries(DISCOVERY_STAGES.map((stage) => [stage, { state: "pending", startedAt: null, endedAt: null }])) as StageRecord;
}

function storedStages(value: unknown): StageRecord {
  const stages = emptyStages();
  if (value && typeof value === "object") {
    for (const stage of DISCOVERY_STAGES) {
      const entry = (value as Record<string, unknown>)[stage];
      if (entry && typeof entry === "object") stages[stage] = { ...stages[stage], ...(entry as StageRecord[DiscoveryStage]) };
    }
  }
  return stages;
}

function iso(value: Date | string | null) {
  return value === null ? null : new Date(value).toISOString();
}

export function discoveryJobDto(row: Selectable<DiscoveryJobTable>): DiscoveryJobDto {
  return {
    id: row.id,
    briefVersion: row.brief_version,
    status: row.status,
    stage: row.stage,
    stages: storedStages(row.stages),
    errorCode: row.error_code,
    addedCount: row.added_count,
    createdAt: iso(row.created_at)!,
    finishedAt: iso(row.finished_at),
    acknowledged: row.acknowledged_at !== null,
  };
}

/** Writes one job's stage progress; every write also refreshes the heartbeat. */
export class DiscoveryJobProgress {
  constructor(
    private readonly database: Kysely<AlongTheWayDatabase>,
    private readonly jobId: string,
    private readonly now: () => Date,
  ) {}

  private async update(stage: DiscoveryStage, patch: Partial<StageRecord[DiscoveryStage]>, current: DiscoveryStage | null) {
    const now = this.now();
    await sql`
      update discovery_jobs
      set stages = jsonb_set(stages, ${sql.raw(`'{${stage}}'`)}, coalesce(stages->${stage}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb, true),
        stage = ${current}, heartbeat_at = ${now}
      where id = ${this.jobId} and status = 'running'
    `.execute(this.database);
  }

  start(stage: DiscoveryStage) {
    return this.update(stage, { state: "running", startedAt: this.now().toISOString() }, stage);
  }

  finish(stage: DiscoveryStage, state: Extract<DiscoveryStageState, "done" | "partial"> = "done") {
    return this.update(stage, { state, endedAt: this.now().toISOString() }, stage);
  }

  /**
   * Ends the job as succeeded and, in the same transaction, removes the checklist it used, so the
   * next 調查 asks fresh questions. Atomic: a client that sees "succeeded" never reads the used
   * checklist, and a job that ends up failed instead keeps its answers for 重新調查.
   */
  async succeed(checklist: { tripId: string; briefVersion: number }) {
    await this.database.transaction().execute(async (transaction) => {
      const ended = await transaction.updateTable("discovery_jobs").set({
        status: "succeeded", finished_at: this.now(), heartbeat_at: this.now(), client_ip: null,
      }).where("id", "=", this.jobId).where("status", "=", "running").returning("id").executeTakeFirst();
      if (!ended) return;
      await transaction.deleteFrom("discovery_clarifications")
        .where("trip_id", "=", checklist.tripId).where("brief_version", "=", checklist.briefVersion)
        .execute();
    });
  }

  /** Marks the running stage failed and ends the job. */
  async fail(code: string) {
    const now = this.now();
    await sql`
      update discovery_jobs
      set status = 'failed', error_code = ${code.slice(0, 40)}, finished_at = ${now}, client_ip = null,
        stages = case when stage is null then stages
          else jsonb_set(stages, array[stage::text], coalesce(stages->stage, '{}'::jsonb) || jsonb_build_object('state', 'failed', 'endedAt', ${now.toISOString()}::text), true) end
      where id = ${this.jobId} and status = 'running'
    `.execute(this.database);
  }
}

/** Fails jobs that can no longer finish, so a trip is never stuck with an "active" job. */
export async function sweepStaleDiscoveryJobs(database: Kysely<AlongTheWayDatabase>, now: Date) {
  await sql`
    update discovery_jobs
    set status = 'failed', finished_at = ${now}, client_ip = null,
      error_code = case when status = 'running' then 'interrupted' else 'expired' end
    where (status = 'running' and coalesce(heartbeat_at, created_at) < ${new Date(now.valueOf() - JOB_HEARTBEAT_STALE_MS)})
      or (status = 'queued' and created_at < ${new Date(now.valueOf() - JOB_QUEUE_EXPIRY_MS)})
  `.execute(database);
}

/** Claims the oldest queued job (SKIP LOCKED: safe with several workers) and marks it running. */
export async function claimNextDiscoveryJob(database: Kysely<AlongTheWayDatabase>, now: Date): Promise<ClaimedDiscoveryJob | null> {
  return database.transaction().execute(async (transaction) => {
    const job = await transaction.selectFrom("discovery_jobs")
      .select(["id", "trip_id", "brief_version", "created_by", "client_ip"])
      .where("status", "=", "queued")
      .orderBy("created_at")
      .limit(1)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (!job) return null;
    await transaction.updateTable("discovery_jobs")
      .set({ status: "running", heartbeat_at: now })
      .where("id", "=", job.id)
      .execute();
    return {
      id: job.id,
      tripId: job.trip_id,
      briefVersion: job.brief_version,
      createdBy: job.created_by,
      clientIp: job.client_ip ?? "unknown",
    };
  });
}
