import type { Kysely, Transaction } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { safeInviteLabel, type EmailSender } from "./email-sender";
import type { TokenIssuer } from "./token-issuer";
import { AppError } from "./private-trip-module";
import { PostgresRateLimiter } from "./postgres-rate-limiter";

const EMAIL_WORKER = "email_delivery";
const HEARTBEAT_INTERVAL_MS = 30_000;
const EMAIL_RETRY_DELAYS_MS = [
  30 * 1_000,
  2 * 60 * 1_000,
  10 * 60 * 1_000,
  60 * 60 * 1_000,
  6 * 60 * 60 * 1_000,
  24 * 60 * 60 * 1_000,
] as const;

function isDefinitiveSmtpRejection(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const responseCode = Reflect.get(error, "responseCode");
  if (typeof responseCode !== "number" || responseCode < 500 || responseCode >= 600) return false;
  const details = [Reflect.get(error, "response"), Reflect.get(error, "message")]
    .filter((value): value is string => typeof value === "string").join(" ");
  if (/\b5\.1\.\d+\b/.test(details)) return true;
  // Gmail can report its recoverable daily sending quota as a 550, not a 4xx.
  return !/\b(?:5\.4\.5|4\.\d+\.\d+)\b|quota|rate[\s-]*limit|sending[\s-]*limit/i.test(details);
}

interface WorkerOptions {
  database: Kysely<AlongTheWayDatabase>;
  emailSender: EmailSender;
  tokenIssuer: TokenIssuer;
  siteAddress: string;
  now?: () => Date;
}

export class PostgresEmailWorker {
  private readonly database: Kysely<AlongTheWayDatabase>;
  private readonly emailSender: EmailSender;
  private readonly tokenIssuer: TokenIssuer;
  private readonly siteAddress: string;
  private readonly now: () => Date;
  private readonly deliveryBudgetSecret: string;
  private heartbeatDueAt = 0;

  constructor(options: WorkerOptions) {
    this.database = options.database;
    this.emailSender = options.emailSender;
    this.tokenIssuer = options.tokenIssuer;
    this.siteAddress = options.siteAddress;
    this.now = options.now ?? (() => new Date());
    this.deliveryBudgetSecret = this.tokenIssuer.issue("email-budget");
  }

  private async recordHeartbeatIfDue() {
    const now = this.now();
    if (now.valueOf() < this.heartbeatDueAt) return;
    await this.database
      .insertInto("worker_heartbeats")
      .values({ worker_name: EMAIL_WORKER, last_seen_at: now })
      .onConflict((conflict) =>
        conflict.column("worker_name").doUpdateSet({ last_seen_at: now }),
      )
      .execute();
    this.heartbeatDueAt = now.valueOf() + HEARTBEAT_INTERVAL_MS;
  }

  private async reserveDelivery(transaction: Transaction<AlongTheWayDatabase>, jobId: string) {
    try {
      await new PostgresRateLimiter(transaction, this.deliveryBudgetSecret, this.now)
        .consume("email_delivery", "global");
      return true;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "rate_limited") throw error;
      const now = this.now();
      const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
      // Backlogged jobs must compete with today's new mail, without being lost to the daily ceiling.
      await transaction.updateTable("email_jobs").set({ available_at: tomorrow })
        .where("id", "=", jobId).execute();
      return false;
    }
  }

  async runOnce() {
    await this.recordHeartbeatIfDue();
    return this.database.transaction().execute(async (transaction) => {
      const job = await transaction
        .selectFrom("email_jobs")
        .select([
          "id",
          "kind",
          "recipient",
          "magic_link_token_id",
          "invite_id",
          "attempt_count",
        ])
        .where("delivered_at", "is", null)
        .where("failed_at", "is", null)
        .where("available_at", "<=", this.now())
        .orderBy("available_at")
        .orderBy("created_at")
        .orderBy("id")
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!job) return false;

      try {
        if (job.kind === "magic_link" && job.magic_link_token_id) {
          const link = await transaction
            .selectFrom("magic_link_tokens")
            .innerJoin("users", "users.id", "magic_link_tokens.user_id")
            .select(["magic_link_tokens.expires_at", "magic_link_tokens.used_at", "magic_link_tokens.revoked_at"])
            .where("magic_link_tokens.id", "=", job.magic_link_token_id)
            .where("users.status", "in", ["active", "invited"])
            .executeTakeFirst();
          if (link && !link.used_at && !link.revoked_at && new Date(link.expires_at) > this.now()) {
            if (!(await this.reserveDelivery(transaction, job.id))) return true;
            const url = new URL("/", this.siteAddress);
            url.hash = new URLSearchParams({
              magicToken: this.tokenIssuer.issue(job.magic_link_token_id),
            }).toString();
            await this.emailSender.sendMagicLink({
              to: job.recipient,
              url: url.toString(),
              code: this.tokenIssuer.code(job.magic_link_token_id),
            });
          }
        } else if (job.kind === "trip_invite" && job.invite_id) {
          const invite = await transaction
            .selectFrom("invites")
            .innerJoin("trips", "trips.id", "invites.trip_id")
            .innerJoin("users", "users.id", "invites.invited_by")
            .innerJoin("users as recipient_user", "recipient_user.email", "invites.email")
            .select([
              "trips.name as tripName",
              "users.display_name as inviterName",
              "invites.expires_at",
              "invites.accepted_at",
              "invites.revoked_at",
            ])
            .where("invites.id", "=", job.invite_id)
            .where("recipient_user.status", "in", ["active", "invited"])
            .executeTakeFirst();
          if (
            invite &&
            !invite.accepted_at &&
            !invite.revoked_at &&
            new Date(invite.expires_at) > this.now()
          ) {
            if (!(await this.reserveDelivery(transaction, job.id))) return true;
            const url = new URL("/", this.siteAddress);
            url.hash = new URLSearchParams({
              inviteToken: this.tokenIssuer.issue(job.invite_id),
            }).toString();
            await this.emailSender.sendTripInvite({
              to: job.recipient,
              tripName: safeInviteLabel(invite.tripName),
              inviterName: safeInviteLabel(invite.inviterName ?? ""),
              url: url.toString(),
            });
          }
        }
        await transaction
          .updateTable("email_jobs")
          .set({ delivered_at: this.now() })
          .where("id", "=", job.id)
          .execute();
      } catch (error) {
        const attemptCount = job.attempt_count + 1;
        const attemptedAt = this.now();
        const retryDelay = EMAIL_RETRY_DELAYS_MS[attemptCount - 1];
        const terminal = isDefinitiveSmtpRejection(error) ||
          retryDelay === undefined;
        await transaction
          .updateTable("email_jobs")
          .set(terminal
            ? {
                attempt_count: attemptCount,
                failed_at: attemptedAt,
              }
            : {
                attempt_count: attemptCount,
                available_at: new Date(attemptedAt.valueOf() + retryDelay!),
              })
          .where("id", "=", job.id)
          .execute();
        console.error(
          JSON.stringify({
            event: "email_delivery_failed",
            emailJobId: job.id,
            kind: job.kind,
            attemptCount,
            terminal,
          }),
        );
      }
      return true;
    });
  }
}
