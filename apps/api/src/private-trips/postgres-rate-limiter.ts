import { createHmac } from "node:crypto";

import type { Kysely } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "./private-trip-module";

export type RateLimitedAction =
  | "magic_link"
  | "magic_link_consume"
  | "trip_invite"
  | "trip_create"
  | "trip_content"
  | "place_photo"
  | "place_photo_metadata";
export interface RateLimiter {
  consume(action: RateLimitedAction, clientIp: string, account?: string, cost?: number): Promise<void>;
  consumePlanning(account: string, tripId: string, cost: number): Promise<void>;
}

interface Rule {
  windowSeconds: number;
  ipLimit: number;
  accountLimit?: number;
}

const RULES: Record<RateLimitedAction, Rule> = {
  magic_link: { windowSeconds: 15 * 60, ipLimit: 30, accountLimit: 5 },
  magic_link_consume: { windowSeconds: 10 * 60, ipLimit: 30 },
  trip_invite: { windowSeconds: 60 * 60, ipLimit: 100, accountLimit: 20 },
  trip_create: { windowSeconds: 60 * 60, ipLimit: 100, accountLimit: 20 },
  trip_content: { windowSeconds: 60 * 60, ipLimit: 600, accountLimit: 300 },
  place_photo: { windowSeconds: 60 * 60, ipLimit: 1_200, accountLimit: 600 },
  place_photo_metadata: { windowSeconds: 60 * 60, ipLimit: 12_000, accountLimit: 6_000 },
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

  async consume(action: RateLimitedAction, clientIp: string, account = "", cost = 1) {
    if (!Number.isSafeInteger(cost) || cost < 1 || cost > 100) {
      throw new Error("Rate limit cost must be an integer from 1 to 100");
    }
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
      ...(rule.accountLimit === undefined
        ? []
        : [{
            scope: `${action}:account`,
            key: account.trim().toLowerCase(),
            limit: rule.accountLimit,
          }]),
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
            request_count: cost,
          })
          .onConflict((conflict) =>
            conflict
              .columns(["scope", "key_hash", "window_start"])
              .doUpdateSet((expression) => ({
                request_count: expression("rate_limit_windows.request_count", "+", cost),
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

  async consumePlanning(account: string, tripId: string, cost: number) {
    if (!Number.isSafeInteger(cost) || cost < 1 || cost > 100) {
      throw new Error("Rate limit cost must be an integer from 1 to 100");
    }
    const now = this.now();
    const attempts = [
      {
        scope: "planning_provider:account",
        key: account.trim().toLowerCase(),
        limit: 40,
        windowSeconds: 60 * 60,
      },
      {
        scope: "planning_provider:trip",
        key: tripId.trim().toLowerCase(),
        limit: 120,
        windowSeconds: 24 * 60 * 60,
      },
    ];
    const retryAfterSeconds = await this.database.transaction().execute(async (transaction) => {
      let retryAfter = 0;
      for (const attempt of attempts) {
        const windowMilliseconds = attempt.windowSeconds * 1_000;
        const windowStart = new Date(
          Math.floor(now.valueOf() / windowMilliseconds) * windowMilliseconds,
        );
        const result = await transaction
          .insertInto("rate_limit_windows")
          .values({
            scope: attempt.scope,
            key_hash: this.keyHash(attempt.scope, attempt.key),
            window_start: windowStart,
            request_count: cost,
          })
          .onConflict((conflict) =>
            conflict
              .columns(["scope", "key_hash", "window_start"])
              .doUpdateSet((expression) => ({
                request_count: expression("rate_limit_windows.request_count", "+", cost),
              })),
          )
          .returning("request_count")
          .executeTakeFirstOrThrow();
        if (result.request_count > attempt.limit) {
          retryAfter = Math.max(
            retryAfter,
            Math.ceil((windowStart.valueOf() + windowMilliseconds - now.valueOf()) / 1_000),
          );
        }
      }
      await transaction
        .deleteFrom("rate_limit_windows")
        .where("window_start", "<", new Date(now.valueOf() - 2 * 24 * 60 * 60 * 1_000))
        .execute();
      return retryAfter;
    });
    if (retryAfterSeconds > 0) {
      throw new AppError(
        "rate_limited",
        "Planning provider quota reached. Try again later.",
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
