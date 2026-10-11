import { AsyncLocalStorage } from "node:async_hooks";
import { sql, type Kysely, type Transaction } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { AppError, type InviteReadModel } from "./private-trip-module";

export type DatabaseExecutor =
  | Kysely<AlongTheWayDatabase>
  | Transaction<AlongTheWayDatabase>;

/** Request-scoped audit context only; it never changes concurrency or validation. */
export const conflictResolutionContext = new AsyncLocalStorage<string | undefined>();
export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function validEmail(value: string) {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function isoTimestamp(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function dateOnly(value: Date | string) {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export function parseDateOnly(value: string, field: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError("validation_error", `${field} must use YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new AppError("validation_error", `${field} is not a valid date`);
  }
  return date;
}

export function requireIdempotencyKey(value: string) {
  const key = value.trim();
  if (!key || key.length > 200) {
    throw new AppError("validation_error", "A valid Idempotency-Key is required");
  }
  return key;
}

export function inviteStatus(
  invite: {
    accepted_at: Date | string | null;
    revoked_at: Date | string | null;
    expires_at: Date | string;
  },
  now: Date,
): InviteReadModel["status"] {
  if (invite.accepted_at) return "accepted";
  if (invite.revoked_at) return "revoked";
  if (new Date(invite.expires_at) <= now) return "expired";
  return "pending";
}

export async function lockMutation(
  transaction: Transaction<AlongTheWayDatabase>,
  actorId: string,
  operation: string,
  key: string,
) {
  await sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`${actorId}:${operation}:${key}`}, 0)
    )
  `.execute(transaction);
}

export async function replayed(
  executor: DatabaseExecutor,
  actorId: string,
  operation: string,
  key: string,
) {
  const existing = await executor
    .selectFrom("mutation_requests")
    .select("response")
    .where("actor_id", "=", actorId)
    .where("operation", "=", operation)
    .where("idempotency_key", "=", key)
    .executeTakeFirst();
  return existing?.response ?? null;
}

export async function remember(
  executor: DatabaseExecutor,
  actorId: string,
  operation: string,
  key: string,
  response: unknown,
) {
  await executor
    .insertInto("mutation_requests")
    .values({
      actor_id: actorId,
      operation,
      idempotency_key: key,
      response,
    })
    .execute();
}

export async function requireOwner(
  executor: DatabaseExecutor,
  userId: string,
  tripId: string,
) {
  const membership = await executor
    .selectFrom("trip_members")
    .select("role")
    .where("trip_id", "=", tripId)
    .where("user_id", "=", userId)
    .where("removed_at", "is", null)
    .executeTakeFirst();
  if (!membership) throw new AppError("trip_not_found", "Trip not found", 404);
  if (membership.role !== "owner") {
    throw new AppError("forbidden", "Only the trip owner can do that", 403);
  }
}

export async function recordEvent(
  executor: DatabaseExecutor,
  event: {
    tripId: string;
    actorId: string;
    eventType: string;
    targetType: string;
    targetId: string;
    summary: string;
    relatedTargetIds?: string[];
  },
) {
  const conflictBase = conflictResolutionContext.getStore();
  if (conflictBase) await sql`select set_config('along.conflict_base_version', ${conflictBase}, true)`.execute(executor);
  if (event.relatedTargetIds) await sql`select set_config('along.related_targets', ${event.relatedTargetIds}::uuid[]::text, true)`.execute(executor);
  await executor
    .insertInto("change_events")
    .values({
      trip_id: event.tripId,
      actor_id: event.actorId,
      event_type: event.eventType,
      target_type: event.targetType,
      target_id: event.targetId,
      summary: event.summary,
    })
    .execute();
  if (event.relatedTargetIds) await sql`select set_config('along.related_targets', '', true)`.execute(executor);
}

export async function requireDayVersion(
  transaction: Transaction<AlongTheWayDatabase>, tripId: string, dayId: string, expectedVersion: number,
) {
  const day = await transaction.selectFrom("trip_days").select("version")
    .where("trip_id", "=", tripId).where("id", "=", dayId).forUpdate().executeTakeFirst();
  if (!day) throw new AppError("trip_day_not_found", "Trip day not found", 404);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== day.version) {
    throw new AppError("conflict", "The day's itinerary changed; reload before saving", 409, undefined, day.version, dayId);
  }
}
