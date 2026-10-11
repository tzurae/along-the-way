import type { Kysely } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import type { ReadinessProbe } from "./private-trip-module";

const EMAIL_WORKER = "email_delivery";
const HEARTBEAT_STALE_AFTER_MS = 90_000;

export class PostgresReadinessProbe implements ReadinessProbe {
  constructor(
    private readonly database: Kysely<AlongTheWayDatabase>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async isReady() {
    const heartbeat = await this.database
      .selectFrom("worker_heartbeats")
      .select("last_seen_at")
      .where("worker_name", "=", EMAIL_WORKER)
      .executeTakeFirst();
    return Boolean(
      heartbeat &&
        new Date(heartbeat.last_seen_at).valueOf() >
          this.now().valueOf() - HEARTBEAT_STALE_AFTER_MS,
    );
  }
}
