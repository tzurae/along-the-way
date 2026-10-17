import type { Kysely } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { rateLimitRetentionRules } from "./postgres-rate-limiter";

const RETENTION_WORKER = "security_retention";
const RUN_INTERVAL_MS = 60 * 60 * 1_000;
const MUTATION_REPLAY_MS = 7 * 24 * 60 * 60 * 1_000;

/** Periodic deletion for bounded replay data and rate counters; one database row gates all workers. */
export class PostgresRetention {
  constructor(
    private readonly database: Kysely<AlongTheWayDatabase>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runIfDue() {
    const now = this.now();
    return this.database.transaction().execute(async (transaction) => {
      const inserted = await transaction.insertInto("worker_heartbeats").values({
        worker_name: RETENTION_WORKER,
        last_seen_at: now,
      }).onConflict((conflict) => conflict.column("worker_name").doNothing())
        .returning("worker_name")
        .executeTakeFirst();
      if (!inserted) {
        const heartbeat = await transaction.selectFrom("worker_heartbeats")
          .select("last_seen_at")
          .where("worker_name", "=", RETENTION_WORKER)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (new Date(heartbeat.last_seen_at).valueOf() > now.valueOf() - RUN_INTERVAL_MS) {
          return false;
        }
      }

      await transaction.deleteFrom("mutation_requests")
        .where("created_at", "<", new Date(now.valueOf() - MUTATION_REPLAY_MS))
        .execute();
      for (const rule of rateLimitRetentionRules()) {
        await transaction.deleteFrom("rate_limit_windows")
          .where("scope", "like", rule.scopePattern)
          .where("window_start", "<", new Date(now.valueOf() - rule.windowSeconds * 1_000))
          .execute();
      }
      if (!inserted) {
        await transaction.updateTable("worker_heartbeats")
          .set({ last_seen_at: now })
          .where("worker_name", "=", RETENTION_WORKER)
          .execute();
      }
      return true;
    });
  }
}
