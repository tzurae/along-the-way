import type { Kysely } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import type { EmailSender } from "./email-sender";
import type { TokenIssuer } from "./token-issuer";

const EMAIL_WORKER = "email_delivery";
const HEARTBEAT_INTERVAL_MS = 30_000;

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
  private heartbeatDueAt = 0;

  constructor(options: WorkerOptions) {
    this.database = options.database;
    this.emailSender = options.emailSender;
    this.tokenIssuer = options.tokenIssuer;
    this.siteAddress = options.siteAddress;
    this.now = options.now ?? (() => new Date());
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
        .where("available_at", "<=", this.now())
        .orderBy("available_at")
        .orderBy("created_at")
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!job) return false;

      try {
        if (job.kind === "magic_link" && job.magic_link_token_id) {
          const link = await transaction
            .selectFrom("magic_link_tokens")
            .select(["linked_invite_id", "expires_at", "used_at", "revoked_at"])
            .where("id", "=", job.magic_link_token_id)
            .executeTakeFirst();
          if (link && !link.used_at && !link.revoked_at && new Date(link.expires_at) > this.now()) {
            const url = new URL("/", this.siteAddress);
            const parameters = new URLSearchParams({
              magicToken: this.tokenIssuer.issue(job.magic_link_token_id),
            });
            if (link.linked_invite_id) {
              parameters.set(
                "inviteToken",
                this.tokenIssuer.issue(link.linked_invite_id),
              );
            }
            url.hash = parameters.toString();
            await this.emailSender.sendMagicLink({
              to: job.recipient,
              url: url.toString(),
            });
          }
        } else if (job.kind === "trip_invite" && job.invite_id) {
          const invite = await transaction
            .selectFrom("invites")
            .innerJoin("trips", "trips.id", "invites.trip_id")
            .select([
              "trips.name as tripName",
              "invites.expires_at",
              "invites.accepted_at",
              "invites.revoked_at",
            ])
            .where("invites.id", "=", job.invite_id)
            .executeTakeFirst();
          if (
            invite &&
            !invite.accepted_at &&
            !invite.revoked_at &&
            new Date(invite.expires_at) > this.now()
          ) {
            const url = new URL("/", this.siteAddress);
            url.hash = new URLSearchParams({
              inviteToken: this.tokenIssuer.issue(job.invite_id),
            }).toString();
            await this.emailSender.sendTripInvite({
              to: job.recipient,
              tripName: invite.tripName,
              url: url.toString(),
            });
          }
        }
        await transaction
          .updateTable("email_jobs")
          .set({ delivered_at: this.now() })
          .where("id", "=", job.id)
          .execute();
      } catch {
        const attemptCount = job.attempt_count + 1;
        const delaySeconds = Math.min(30 * 2 ** (attemptCount - 1), 3_600);
        await transaction
          .updateTable("email_jobs")
          .set({
            attempt_count: attemptCount,
            available_at: new Date(this.now().valueOf() + delaySeconds * 1_000),
          })
          .where("id", "=", job.id)
          .execute();
        console.error(
          JSON.stringify({
            event: "email_delivery_failed",
            emailJobId: job.id,
            kind: job.kind,
            attemptCount,
          }),
        );
      }
      return true;
    });
  }
}
