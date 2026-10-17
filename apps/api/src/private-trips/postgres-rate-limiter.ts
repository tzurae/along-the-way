import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";

import type { Kysely } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "./private-trip-module";

export type RateLimitedAction =
  | "magic_link"
  | "magic_link_consume"
  | "magic_link_code"
  | "email_send"
  | "email_delivery"
  | "trip_invite"
  | "trip_create"
  | "trip_content"
  | "rapidapi_keys"
  | "place_photo"
  | "place_photo_metadata"
  | "discovery_ai"
  | "route_planning";
export type PaidProvider = "google_places" | "google_routes" | "navitime";
export interface RateLimiter {
  consume(action: RateLimitedAction, clientIp: string, account?: string, cost?: number): Promise<void>;
  claimDiscoveryAiRun(account: string, tripId: string): Promise<void>;
  withPaidProviderIdentity<T>(clientIp: string, account: string, work: () => Promise<T>): Promise<T>;
}

interface Rule {
  windowSeconds: number;
  ipLimit: number;
  accountLimit?: number;
}

const RULES: Record<RateLimitedAction, Rule> = {
  magic_link: { windowSeconds: 15 * 60, ipLimit: 30, accountLimit: 5 },
  magic_link_consume: { windowSeconds: 10 * 60, ipLimit: 30 },
  magic_link_code: { windowSeconds: 15 * 60, ipLimit: 30, accountLimit: 10 },
  email_send: { windowSeconds: 24 * 60 * 60, ipLimit: 300 },
  email_delivery: { windowSeconds: 24 * 60 * 60, ipLimit: 300 },
  trip_invite: { windowSeconds: 24 * 60 * 60, ipLimit: 100, accountLimit: 10 },
  trip_create: { windowSeconds: 24 * 60 * 60, ipLimit: 100, accountLimit: 5 },
  trip_content: { windowSeconds: 60 * 60, ipLimit: 600, accountLimit: 300 },
  rapidapi_keys: { windowSeconds: 60 * 60, ipLimit: 600, accountLimit: 300 },
  place_photo: { windowSeconds: 60 * 60, ipLimit: 1_200, accountLimit: 600 },
  place_photo_metadata: { windowSeconds: 60 * 60, ipLimit: 600, accountLimit: 300 },
  discovery_ai: { windowSeconds: 60 * 60, ipLimit: 6, accountLimit: 10 },
  route_planning: { windowSeconds: 60 * 60, ipLimit: 600, accountLimit: 300 },
};

// Google: below the project's 1000/day quota. One planning session (a week of days, a few drafts
// and drops each) makes several hundred lookups, so an account may use half of the day's budget:
// enough for the owner to plan, while one other account cannot take all of it.
// NAVITIME reserves 15 requests per UTC day for each hashed key, not per account or IP.
const PAID_PROVIDER_DAILY_LIMITS: Record<Exclude<PaidProvider, "navitime">, { global: number; account: number; ip: number }> = {
  google_places: { global: 900, account: 450, ip: 600 },
  google_routes: { global: 900, account: 450, ip: 600 },
};
const PAID_PROVIDER_WINDOW_SECONDS = 24 * 60 * 60;
const DISCOVERY_AI_REFUSED = Symbol("discovery AI budget refused");
const PAID_PROVIDER_REFUSED = Symbol("paid provider budget refused");
/** Rate-window families and their exact lifetime, used by the hourly retention worker. */
export function rateLimitRetentionRules() {
  return [
    ...Object.entries(RULES).map(([action, rule]) => ({
      scopePattern: `${action}:%`,
      windowSeconds: rule.windowSeconds,
    })),
    {
      scopePattern: "paid_provider:%",
      windowSeconds: PAID_PROVIDER_WINDOW_SECONDS,
    },
  ];
}

export class PostgresRateLimiter implements RateLimiter {
  private readonly secret: Buffer;
  private readonly paidProviderIdentity = new AsyncLocalStorage<{
    account: string;
    clientIp: string;
  }>();

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

    const countRequests = async (transaction: Kysely<AlongTheWayDatabase>) => {
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
      return exceeded;
    };
    // Enqueue callers already hold a transaction; use its connection and rollback boundary.
    const limited = this.database.isTransaction
      ? await countRequests(this.database)
      : await this.database.transaction().execute(countRequests);

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

  /**
   * Counts model starts independently of idempotency replay rows. Conditional upserts and the
   * rollback sentinel ensure a refused attempt is not counted as a model call.
   */
  async claimDiscoveryAiRun(account: string, tripId: string) {
    const rule = RULES.discovery_ai;
    const now = this.now();
    const windowMilliseconds = rule.windowSeconds * 1_000;
    const windowStart = new Date(Math.floor(now.valueOf() / windowMilliseconds) * windowMilliseconds);
    const attempts = [
      { scope: "discovery_ai:account", key: account.trim().toLowerCase(), limit: rule.accountLimit! },
      { scope: "discovery_ai:trip", key: tripId.trim().toLowerCase(), limit: rule.ipLimit },
    ];
    if (!attempts[0]!.key || !attempts[1]!.key) {
      throw new Error("Discovery AI accounting requires an account and trip");
    }
    try {
      await this.database.transaction().execute(async (transaction) => {
        for (const attempt of attempts) {
          const reserved = await transaction.insertInto("rate_limit_windows")
            .values({
              scope: attempt.scope,
              key_hash: this.keyHash(attempt.scope, attempt.key),
              window_start: windowStart,
              request_count: 1,
            })
            .onConflict((conflict) => conflict
              .columns(["scope", "key_hash", "window_start"])
              .doUpdateSet((expression) => ({
                request_count: expression("rate_limit_windows.request_count", "+", 1),
              }))
              .where("rate_limit_windows.request_count", "<", attempt.limit))
            .returning("request_count")
            .executeTakeFirst();
          if (!reserved) throw DISCOVERY_AI_REFUSED;
        }
      });
    } catch (error) {
      if (error !== DISCOVERY_AI_REFUSED) throw error;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((windowStart.valueOf() + windowMilliseconds - now.valueOf()) / 1_000),
      );
      throw new AppError(
        "research_limit_reached",
        "The AI request limit for this hour is reached",
        429,
        retryAfterSeconds,
      );
    }
  }

  /**
   * Reserves one outbound request per UTC day. NAVITIME has only a per-key budget;
   * Google reserves global, account and IP capacity atomically.
   */
  async tryConsumePaidProvider(provider: "navitime", keyHash: string): Promise<boolean>;
  async tryConsumePaidProvider(provider: Exclude<PaidProvider, "navitime">): Promise<boolean>;
  async tryConsumePaidProvider(provider: PaidProvider, keyHash?: string) {
    const identity = this.paidProviderIdentity.getStore();
    // Production entrypoints establish the identity in createApp. Fail closed if a new caller does not.
    if (!identity) return false;
    const now = this.now();
    const windowMilliseconds = PAID_PROVIDER_WINDOW_SECONDS * 1_000;
    const windowStart = new Date(Math.floor(now.valueOf() / windowMilliseconds) * windowMilliseconds);
    if (provider === "navitime" && !keyHash) return false;
    const limits = provider === "navitime" ? null : PAID_PROVIDER_DAILY_LIMITS[provider];
    const attempts = limits ? [
      { scope: `paid_provider:${provider}:global`, key: "global", limit: limits.global },
      { scope: `paid_provider:${provider}:account`, key: identity.account, limit: limits.account },
      { scope: `paid_provider:${provider}:ip`, key: identity.clientIp, limit: limits.ip },
    ] : [{ scope: "paid_provider:navitime:key", key: keyHash!, limit: 15 }];
    try {
      await this.database.transaction().execute(async (transaction) => {
        for (const attempt of attempts) {
          const reserved = await transaction.insertInto("rate_limit_windows")
            .values({
              scope: attempt.scope,
              key_hash: this.keyHash(attempt.scope, attempt.key),
              window_start: windowStart,
              request_count: 1,
            })
            .onConflict((conflict) => conflict
              .columns(["scope", "key_hash", "window_start"])
              .doUpdateSet((expression) => ({
                request_count: expression("rate_limit_windows.request_count", "+", 1),
              }))
              .where("rate_limit_windows.request_count", "<", attempt.limit))
            .returning("request_count")
            .executeTakeFirst();
          if (!reserved) throw PAID_PROVIDER_REFUSED;
        }
      });
      return true;
    } catch (error) {
      if (error === PAID_PROVIDER_REFUSED) return false;
      throw error;
    }
  }
  /**
   * Makes the authenticated account and request IP available to every provider call in `work`,
   * including concurrent route fan-out. The provider adapters reserve immediately before fetch.
   */
  withPaidProviderIdentity<T>(clientIp: string, account: string, work: () => Promise<T>) {
    const identity = {
      account: account.trim().toLowerCase(),
      clientIp: clientIp.trim() || "unknown",
    };
    if (!identity.account) throw new Error("Paid provider calls require an account");
    return this.paidProviderIdentity.run(identity, work);
  }



  private keyHash(scope: string, key: string) {
    return createHmac("sha256", this.secret)
      .update(`${scope}:${key}`)
      .digest("hex");
  }
}
