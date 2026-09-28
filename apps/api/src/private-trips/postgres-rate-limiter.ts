import { createHmac } from "node:crypto";

import type { Kysely } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "./private-trip-module";

export type RateLimitedAction =
  | "magic_link"
  | "trip_invite"
  | "trip_create"
  | "trip_content";

export interface RateLimiter {
  consume(action: RateLimitedAction, clientIp: string, account: string): Promise<void>;
}

interface Rule {
  windowSeconds: number;
  ipLimit: number;
  accountLimit: number;
}

const RULES: Record<RateLimitedAction, Rule> = {
  magic_link: { windowSeconds: 15 * 60, ipLimit: 30, accountLimit: 5 },
  trip_invite: { windowSeconds: 60 * 60, ipLimit: 100, accountLimit: 20 },
  trip_create: { windowSeconds: 60 * 60, ipLimit: 100, accountLimit: 20 },
  trip_content: { windowSeconds: 60 * 60, ipLimit: 600, accountLimit: 300 },
};

export class PostgresRateLimiter implements RateLimiter {
  private readonly secret: Buffer;

  constructor(
    private readonly database: Kysely<AlongTheWayDatabase>,
    secret: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.secret = Buffer.from(secret);
    if (this.secret.byteLength < 32) {
      throw new Error("TOKEN_SECRET must contain at least 32 bytes");
    }
  }

  async consume(action: RateLimitedAction, clientIp: string, account: string) {
    const rule = RULES[action];
    const now = this.now();
    const windowMilliseconds = rule.windowSeconds * 1_000;
    const windowStart = new Date(
      Math.floor(now.valueOf() / windowMilliseconds) * windowMilliseconds,
    );
    const attempts = [
      {
        scope: `${action}:ip`,
        key: clientIp || "unknown",
        limit: rule.ipLimit,
      },
      {
        scope: `${action}:account`,
        key: account.trim().toLowerCase(),
        limit: rule.accountLimit,
      },
    ];

    const limited = await this.database.transaction().execute(async (transaction) => {
      let exceeded = false;
      for (const attempt of attempts) {
        const result = await transaction
          .insertInto("rate_limit_windows")
          .values({
            scope: attempt.scope,
            key_hash: this.keyHash(attempt.scope, attempt.key),
            window_start: windowStart,
            request_count: 1,
          })
          .onConflict((conflict) =>
            conflict
              .columns(["scope", "key_hash", "window_start"])
              .doUpdateSet((expression) => ({
                request_count: expression("rate_limit_windows.request_count", "+", 1),
              })),
          )
          .returning("request_count")
          .executeTakeFirstOrThrow();
        exceeded ||= result.request_count > attempt.limit;
      }
      await transaction
        .deleteFrom("rate_limit_windows")
        .where("window_start", "<", new Date(now.valueOf() - 2 * 24 * 60 * 60 * 1_000))
        .execute();
      return exceeded;
    });

    if (limited) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((windowStart.valueOf() + windowMilliseconds - now.valueOf()) / 1_000),
      );
      throw new AppError(
        "rate_limited",
        "Too many requests. Try again later.",
        429,
        retryAfterSeconds,
      );
    }
  }

  private keyHash(scope: string, key: string) {
    return createHmac("sha256", this.secret)
      .update(`${scope}:${key}`)
      .digest("hex");
  }
}
