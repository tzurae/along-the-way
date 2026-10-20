import { randomBytes, randomUUID } from "node:crypto";

import {
  parseInviteResponse,
  type InviteDto,
} from "@along-the-way/contracts/private-trips";
import type { Kysely, Transaction } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import {
  AppError,
  type AcceptedInvite,
  type AuthenticatedUser,
  type IdentityAccessModule,
  type InviteReadModel,
  type LoginContext,
  type LoginResult,
  type SessionResult,
} from "./private-trip-module";
import {
  isoTimestamp,
  lockMutation,
  normalizeEmail,
  recordEvent,
  remember,
  replayed,
  requireIdempotencyKey,
  requireOwner,
  validEmail,
} from "./postgres-private-trip-store";
import { hashToken, type TokenIssuer } from "./token-issuer";
import { PostgresRateLimiter } from "./postgres-rate-limiter";

const MAGIC_LINK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const SESSION_ABSOLUTE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;
const SESSION_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const SESSION_STORED_LIFETIME_MS =
  SESSION_LIFETIME_MS + SESSION_REFRESH_INTERVAL_MS;

interface ModuleOptions {
  database: Kysely<AlongTheWayDatabase>;
  tokenIssuer: TokenIssuer;
  adminEmails?: ReadonlySet<string>;
  now?: () => Date;
  randomSessionToken?: () => string;
  randomIdentifier?: () => string;
}

function defaultSessionToken() {
  return randomBytes(32).toString("base64url");
}

function maskedEmail(email: string) {
  const [local, domain] = email.split("@");
  return `${local!.slice(0, 2)}***@${domain}`;
}

function storedInvite(value: unknown): InviteDto {
  try {
    return parseInviteResponse({ invite: value }).invite;
  } catch {
    throw new AppError("conflict", "Stored mutation result is invalid", 409);
  }
}

function storedTripId(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof Reflect.get(value, "tripId") !== "string"
  ) {
    throw new AppError("conflict", "Stored mutation result is invalid", 409);
  }
  return Reflect.get(value, "tripId") as string;
}

export class PostgresIdentityAccessModule implements IdentityAccessModule {
  private readonly database: Kysely<AlongTheWayDatabase>;
  private readonly tokenIssuer: TokenIssuer;
  private readonly now: () => Date;
  private readonly randomSessionToken: () => string;
  private readonly randomIdentifier: () => string;
  private readonly emailBudgetSecret: string;
  private readonly adminEmails: ReadonlySet<string>;

  constructor(options: ModuleOptions) {
    this.database = options.database;
    this.tokenIssuer = options.tokenIssuer;
    this.adminEmails = options.adminEmails ?? new Set();
    this.now = options.now ?? (() => new Date());
    this.randomSessionToken = options.randomSessionToken ?? defaultSessionToken;
    this.randomIdentifier = options.randomIdentifier ?? randomUUID;
    this.emailBudgetSecret = this.tokenIssuer.issue("email-budget");
  }

  private async queueMagicLink(
    transaction: Transaction<AlongTheWayDatabase>,
    user: { id: string; email: string },
    linkedInviteId: string | null,
    now: Date,
    nonce: string,
  ) {
    try {
      await new PostgresRateLimiter(transaction, this.emailBudgetSecret, this.now).consume("email_send", "global");
    } catch (error) {
      // Public login requests must not reveal whether this recipient could receive mail.
      if (error instanceof AppError && error.code === "rate_limited") return;
      throw error;
    }
    const id = this.randomIdentifier();
    const token = this.tokenIssuer.issue(id);
    await transaction
      .insertInto("magic_link_tokens")
      .values({
        id,
        user_id: user.id,
        token_hash: hashToken(token),
        linked_invite_id: linkedInviteId,
        login_nonce_hash: hashToken(nonce),
        code_hash: hashToken(this.tokenIssuer.code(id)),
        created_at: now,
        expires_at: new Date(now.valueOf() + MAGIC_LINK_LIFETIME_MS),
        used_at: null,
        revoked_at: null,
      })
      .execute();
    await transaction
      .insertInto("email_jobs")
      .values({
        kind: "magic_link",
        recipient: user.email,
        magic_link_token_id: id,
        invite_id: null,
        available_at: now,
        delivered_at: null,
      })
      .execute();
  }

  async requestMagicLink(rawEmail: string, nonce: string) {
    const email = normalizeEmail(rawEmail);
    if (!validEmail(email)) return;
    const now = this.now();

    await this.database.transaction().execute(async (transaction) => {
      const user = await transaction
        .selectFrom("users")
        .select(["id", "email"])
        .where("email", "=", email)
        .where("status", "=", "active")
        .forUpdate()
        .executeTakeFirst();
      if (!user) return;
      await this.queueMagicLink(transaction, user, null, now, nonce);
    });
  }

  async requestInviteMagicLink(inviteToken: string, nonce: string) {
    const now = this.now();
    await this.database.transaction().execute(async (transaction) => {
      const invitation = await transaction
        .selectFrom("invites")
        .innerJoin("users", "users.email", "invites.email")
        .select([
          "invites.id as inviteId",
          "users.id as userId",
          "users.email",
        ])
        .where("invites.token_hash", "=", hashToken(inviteToken))
        .where("invites.accepted_at", "is", null)
        .where("invites.revoked_at", "is", null)
        .where("invites.expires_at", ">", now)
        .where("users.status", "in", ["active", "invited"])
        .forUpdate()
        .executeTakeFirst();
      if (!invitation) return;
      await this.queueMagicLink(
        transaction,
        { id: invitation.userId, email: invitation.email },
        invitation.inviteId,
        now,
        nonce,
      );
    });
  }

  async consumeMagicLink(token: string, context: LoginContext): Promise<LoginResult> {
    return this.signIn({ token }, context);
  }

  async verifyMagicLinkCode(rawEmail: string, code: string, context: LoginContext): Promise<LoginResult> {
    const email = normalizeEmail(rawEmail);
    if (!validEmail(email) || !context.nonce || !/^\d{6}$/.test(code)) {
      throw new AppError("invalid_magic_code", "This code is invalid or expired. Request a new link.");
    }
    return this.signIn({ email, code }, context);
  }

  private async signIn(
    credential: { token: string } | { email: string; code: string },
    context: LoginContext,
  ): Promise<LoginResult> {
    const now = this.now();
    const result = await this.database.transaction().execute(async (transaction): Promise<LoginResult | AppError> => {
      let query = transaction
        .selectFrom("magic_link_tokens")
        .innerJoin("users", "users.id", "magic_link_tokens.user_id")
        .select([
          "magic_link_tokens.id",
          "magic_link_tokens.expires_at",
          "magic_link_tokens.used_at",
          "magic_link_tokens.revoked_at",
          "magic_link_tokens.linked_invite_id as linkedInviteId",
          "magic_link_tokens.login_nonce_hash",
          "magic_link_tokens.code_hash",
          "magic_link_tokens.code_attempts",
          "users.status",
          "users.id as userId",
          "users.email",
          "users.display_name as displayName",
        ])
        .where("users.status", "in", ["active", "invited"]);
      if ("token" in credential) {
        query = query.where("magic_link_tokens.token_hash", "=", hashToken(credential.token));
      } else {
        query = query
          .where("users.email", "=", credential.email)
          .where("magic_link_tokens.login_nonce_hash", "=", hashToken(context.nonce))
          .where("magic_link_tokens.used_at", "is", null)
          .where("magic_link_tokens.revoked_at", "is", null)
          .where("magic_link_tokens.expires_at", ">", now)
          .orderBy("magic_link_tokens.created_at", "desc");
      }
      const link = await query.forUpdate().executeTakeFirst();

      if (!("token" in credential) && (!link || link.code_hash !== hashToken(credential.code))) {
        if (link) {
          const attempts = link.code_attempts + 1;
          await transaction.updateTable("magic_link_tokens")
            .set({ code_attempts: attempts, ...(attempts >= 5 ? { revoked_at: now } : {}) })
            .where("id", "=", link.id).execute();
        }
        // Return instead of throwing so failed attempts and revocation are committed.
        return new AppError("invalid_magic_code", "This code is invalid or expired. Request a new link.");
      }

      if (!link) {
        throw new AppError(
          "invalid_magic_link",
          "This sign-in link is invalid. Request a new link.",
        );
      }
      if (link.revoked_at) {
        throw new AppError(
          "revoked_magic_link",
          "This sign-in link was revoked. Request a new link.",
        );
      }
      if (link.used_at) {
        throw new AppError(
          "used_magic_link",
          "This sign-in link was already used. Request a new link.",
        );
      }
      if (new Date(link.expires_at) <= now) {
        throw new AppError(
          "expired_magic_link",
          "This sign-in link expired. Request a new link.",
        );
      }

      const previous = context.sessionToken
        ? await transaction.selectFrom("sessions").innerJoin("users", "users.id", "sessions.user_id")
          .select(["users.id", "users.email"])
          .where("sessions.token_hash", "=", hashToken(context.sessionToken))
          .where("sessions.revoked_at", "is", null)
          .where("sessions.expires_at", ">", now)
          .where("sessions.created_at", ">", new Date(now.valueOf() - SESSION_ABSOLUTE_LIFETIME_MS))
          .where("users.status", "=", "active").executeTakeFirst()
        : undefined;
      const sameBrowser = !!context.nonce && link.login_nonce_hash === hashToken(context.nonce);
      if (!context.confirm && (!sameBrowser || (previous && previous.id !== link.userId))) {
        return {
          confirmationRequired: true,
          targetEmail: maskedEmail(link.email),
          currentEmail: previous && previous.id !== link.userId ? maskedEmail(previous.email) : null,
        };
      }

      let acceptedTripId: string | undefined;
      let inviteOutcome: SessionResult["inviteOutcome"];
      if (link.linkedInviteId) {
        const invite = await transaction
          .selectFrom("invites")
          .select([
            "id",
            "trip_id as tripId",
            "email",
            "expires_at",
            "accepted_at",
            "accepted_by",
            "revoked_at",
          ])
          .where("id", "=", link.linkedInviteId)
          .forUpdate()
          .executeTakeFirst();

        if (
          invite?.accepted_at &&
          invite.accepted_by === link.userId
        ) {
          const membership = await transaction
            .selectFrom("trip_members")
            .select("user_id")
            .where("trip_id", "=", invite.tripId)
            .where("user_id", "=", link.userId)
            .where("removed_at", "is", null)
            .executeTakeFirst();
          if (membership) {
            acceptedTripId = invite.tripId;
            inviteOutcome = "already-member";
          }
        } else if (
          invite &&
          (invite.revoked_at || new Date(invite.expires_at) <= now)
        ) {
          inviteOutcome = "expired-or-revoked";
        } else if (
          invite &&
          invite.email === link.email &&
          invite.accepted_at === null
        ) {
          const trip = await transaction
            .selectFrom("trips")
            .select("id")
            .where("id", "=", invite.tripId)
            .forUpdate()
            .executeTakeFirst();
          if (trip) {
            const membership = await transaction
              .selectFrom("trip_members")
              .select("user_id")
              .where("trip_id", "=", invite.tripId)
              .where("user_id", "=", link.userId)
              .where("removed_at", "is", null)
              .executeTakeFirst();
            if (!membership) {
              await transaction
                .insertInto("trip_members")
                .values({
                  trip_id: invite.tripId,
                  user_id: link.userId,
                  role: "editor",
                  removed_at: null,
                })
                .onConflict((conflict) =>
                  conflict.columns(["trip_id", "user_id"]).doUpdateSet({
                    role: "editor",
                    removed_at: null,
                    joined_at: now,
                  }),
                )
                .execute();
            }
            await transaction
              .updateTable("invites")
              .set({ accepted_at: now, accepted_by: link.userId })
              .where("id", "=", invite.id)
              .where("accepted_at", "is", null)
              .execute();
            await recordEvent(transaction, {
              tripId: invite.tripId,
              actorId: link.userId,
              eventType: "invite.accepted",
              targetType: "invite",
              targetId: invite.id,
              summary: "Accepted an editor invitation",
            });
            acceptedTripId = invite.tripId;
            inviteOutcome = membership ? "already-member" : "accepted";
          }
        }
      }

      if (link.status === "invited") {
        if (!acceptedTripId) {
          throw new AppError("invalid_invite", "This invitation is no longer valid.");
        }
        await transaction.updateTable("users")
          .set({ status: "active", updated_at: now }).where("id", "=", link.userId).execute();
      }
      // Replacing the browser cookie must not leave its previous session valid elsewhere.
      if (context.sessionToken) {
        await transaction.updateTable("sessions").set({ revoked_at: now })
          .where("token_hash", "=", hashToken(context.sessionToken))
          .where("revoked_at", "is", null).execute();
      }
      const sessionToken = this.randomSessionToken();

      await transaction
        .updateTable("magic_link_tokens")
        .set({ used_at: now })
        .where("id", "=", link.id)
        .execute();
      await transaction
        .insertInto("sessions")
        .values({
          user_id: link.userId,
          token_hash: hashToken(sessionToken),
          expires_at: new Date(now.valueOf() + SESSION_STORED_LIFETIME_MS),
          last_seen_at: now,
          created_at: now,
          revoked_at: null,
        })
        .execute();

      return {
        sessionToken,
        user: {
          id: link.userId,
          email: link.email,
          displayName: link.displayName,
          isAdmin: this.adminEmails.has(normalizeEmail(link.email)),
        },
        ...(acceptedTripId ? { acceptedTripId } : {}),
        ...(inviteOutcome ? { inviteOutcome } : {}),
      };
    });
    if (result instanceof AppError) throw result;
    return result;
  }

  async authenticate(sessionToken: string): Promise<AuthenticatedUser | null> {
    if (!sessionToken) return null;
    const now = this.now();
    const session = await this.database
      .selectFrom("sessions")
      .innerJoin("users", "users.id", "sessions.user_id")
      .select([
        "sessions.id",
        "sessions.expires_at",
        "sessions.last_seen_at",
        "sessions.revoked_at",
        "sessions.created_at",
        "users.id as userId",
        "users.email",
        "users.display_name as displayName",
      ])
      .where("sessions.token_hash", "=", hashToken(sessionToken))
      .where("users.status", "=", "active")
      .executeTakeFirst();

    if (!session || session.revoked_at || new Date(session.expires_at) <= now ||
      new Date(session.created_at).valueOf() + SESSION_ABSOLUTE_LIFETIME_MS <= now.valueOf()) {
      return null;
    }

    // Persist only when the stored expiry would no longer cover a full 30 days from now. Renewals
    // store 31 days, so this writes at most about once a day, and sessions created by an earlier
    // release (stored with exactly 30 days) gain the slack on their first use after upgrade.
    const absoluteExpiry = new Date(new Date(session.created_at).valueOf() + SESSION_ABSOLUTE_LIFETIME_MS);
    const mustCover = new Date(Math.min(now.valueOf() + SESSION_LIFETIME_MS, absoluteExpiry.valueOf()));
    if (new Date(session.expires_at) < mustCover) {
      await this.database
        .updateTable("sessions")
        .set({
          last_seen_at: now,
          expires_at: new Date(Math.min(now.valueOf() + SESSION_STORED_LIFETIME_MS, absoluteExpiry.valueOf())),
        })
        .where("id", "=", session.id)
        .where("revoked_at", "is", null)
        .where("expires_at", ">", now)
        .where("expires_at", "<", mustCover)
        .execute();
    }

    return {
      id: session.userId,
      email: session.email,
      displayName: session.displayName,
      isAdmin: this.adminEmails.has(normalizeEmail(session.email)),
    };
  }

  /** The signed-in member's own nickname; there is no way to set anyone else's. Blank clears it. */
  async updateDisplayName(userId: string, rawDisplayName: string | null): Promise<AuthenticatedUser> {
    const trimmed = rawDisplayName?.trim() ?? "";
    if (trimmed.length > 40) throw new AppError("validation_error", "displayName must be at most 40 characters");
    const updated = await this.database
      .updateTable("users")
      .set({ display_name: trimmed || null, updated_at: this.now() })
      .where("id", "=", userId)
      .returning(["id", "email", "display_name"])
      .executeTakeFirst();
    if (!updated) throw new AppError("unauthenticated", "Sign in to continue", 401);
    return {
      id: updated.id,
      email: updated.email,
      displayName: updated.display_name,
      isAdmin: this.adminEmails.has(normalizeEmail(updated.email)),
    };
  }

  async logout(sessionToken: string, targetUserId?: string) {
    if (!sessionToken) return;
    const now = this.now();
    await this.database.transaction().execute(async (transaction) => {
      const session = await transaction.selectFrom("sessions").select(["id", "user_id"])
        .where("token_hash", "=", hashToken(sessionToken))
        .where("revoked_at", "is", null)
        .where("expires_at", ">", now)
        .where("created_at", ">", new Date(now.valueOf() - SESSION_ABSOLUTE_LIFETIME_MS))
        .forUpdate().executeTakeFirst();
      if (!session) return;
      // A delayed request from another tab must not revoke a replacement account's cookie.
      if (targetUserId !== undefined && session.user_id !== targetUserId) {
        throw new AppError("logout_target_mismatch", "This device is signed in to a different account.", 409);
      }
      await transaction.updateTable("sessions").set({ revoked_at: now })
        .where("id", "=", session.id).execute();
    });
  }

  async logoutEverywhere(userId: string) {
    await this.database.updateTable("sessions")
      .set({ revoked_at: this.now() }).where("user_id", "=", userId)
      .where("revoked_at", "is", null).execute();
  }

  async inviteMember(
    userId: string,
    tripId: string,
    rawKey: string,
    rawEmail: string,
  ): Promise<InviteReadModel> {
    const key = requireIdempotencyKey(rawKey);
    const email = normalizeEmail(rawEmail);
    if (!validEmail(email)) {
      throw new AppError("validation_error", "A valid invite email is required");
    }
    const now = this.now();

    return this.database.transaction().execute(async (transaction) => {
      await requireOwner(transaction, userId, tripId);
      const recipient = await transaction
        .selectFrom("users")
        .select("status")
        .where("email", "=", email)
        .forUpdate()
        .executeTakeFirst();
      if (recipient?.status === "disabled") {
        throw new AppError("forbidden", "This email cannot receive invitations.", 403);
      }
      await lockMutation(transaction, userId, `invite_member:${tripId}`, key);
      const replay = await replayed(
        transaction,
        userId,
        `invite_member:${tripId}`,
        key,
      );
      if (replay) return storedInvite(replay);

      const activeMember = await transaction
        .selectFrom("trip_members")
        .innerJoin("users", "users.id", "trip_members.user_id")
        .select("trip_members.user_id")
        .where("trip_members.trip_id", "=", tripId)
        .where("trip_members.removed_at", "is", null)
        .where("users.email", "=", email)
        .executeTakeFirst();
      if (activeMember) {
        throw new AppError("conflict", "This person is already a trip member", 409);
      }
      const pending = await transaction
        .selectFrom("invites")
        .select("id")
        .where("trip_id", "=", tripId)
        .where("email", "=", email)
        .where("accepted_at", "is", null)
        .where("revoked_at", "is", null)
        .where("expires_at", ">", now)
        .executeTakeFirst();
      if (pending) {
        throw new AppError("conflict", "A pending invite already exists", 409);
      }

      await new PostgresRateLimiter(transaction, this.emailBudgetSecret, this.now).consume("email_send", "global");

      await transaction
        .insertInto("users")
        .values({ email, display_name: null, status: "invited" })
        .onConflict((conflict) => conflict.column("email").doNothing())
        .execute();
      const trip = await transaction
        .selectFrom("trips")
        .select(["id", "name"])
        .where("id", "=", tripId)
        .executeTakeFirstOrThrow();
      const id = this.randomIdentifier();
      const token = this.tokenIssuer.issue(id);
      const invite = await transaction
        .insertInto("invites")
        .values({
          id,
          trip_id: tripId,
          email,
          role: "editor",
          token_hash: hashToken(token),
          expires_at: new Date(now.valueOf() + INVITE_LIFETIME_MS),
          accepted_at: null,
          accepted_by: null,
          revoked_at: null,
          invited_by: userId,
        })
        .returning(["id", "email", "role", "expires_at"])
        .executeTakeFirstOrThrow();
      const response: InviteReadModel = {
        id: invite.id,
        email: invite.email,
        role: "editor",
        expiresAt: isoTimestamp(invite.expires_at),
        status: "pending",
      };
      await transaction
        .insertInto("email_jobs")
        .values({
          kind: "trip_invite",
          recipient: email,
          magic_link_token_id: null,
          invite_id: invite.id,
          available_at: now,
          delivered_at: null,
        })
        .execute();
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "invite.created",
        targetType: "invite",
        targetId: invite.id,
        summary: "Invited an editor",
      });
      await remember(
        transaction,
        userId,
        `invite_member:${tripId}`,
        key,
        response,
      );
      return response;
    });
  }

  async acceptInvite(
    userId: string,
    rawKey: string,
    token: string,
  ): Promise<AcceptedInvite> {
    const key = requireIdempotencyKey(rawKey);
    const now = this.now();
    return this.database.transaction().execute(async (transaction) => {
      const invite = await transaction
        .selectFrom("invites")
        .select([
          "id",
          "trip_id as tripId",
          "email as inviteEmail",
          "expires_at",
          "accepted_at",
          "revoked_at",
        ])
        .where("token_hash", "=", hashToken(token))
        .forUpdate()
        .executeTakeFirst();
      if (!invite) throw new AppError("invalid_invite", "This invitation is invalid");
      const operation = `ia:${invite.tripId}:${invite.id}`;
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return { tripId: storedTripId(replay) };

      const user = await transaction
        .selectFrom("users")
        .select("email")
        .where("id", "=", userId)
        .executeTakeFirstOrThrow();
      if (invite.revoked_at) {
        throw new AppError("revoked_invite", "This invitation was revoked", 409);
      }
      if (invite.accepted_at) {
        throw new AppError("used_invite", "This invitation was already used", 409);
      }
      if (new Date(invite.expires_at) <= now) {
        throw new AppError("expired_invite", "This invitation expired", 409);
      }
      if (invite.inviteEmail !== user.email) {
        throw new AppError(
          "invite_email_mismatch",
          "Sign in with the email address that received this invitation",
          403,
        );
      }

      const trip = await transaction.selectFrom("trips")
        .select("id")
        .where("id", "=", invite.tripId)
        .forUpdate()
        .executeTakeFirst();
      if (!trip) throw new AppError("trip_not_found", "Trip not found", 404);
      await transaction
        .insertInto("trip_members")
        .values({
          trip_id: invite.tripId,
          user_id: userId,
          role: "editor",
          removed_at: null,
        })
        .onConflict((conflict) =>
          conflict.columns(["trip_id", "user_id"]).doUpdateSet({
            role: "editor",
            removed_at: null,
            joined_at: now,
          }),
        )
        .execute();
      await transaction
        .updateTable("invites")
        .set({ accepted_at: now, accepted_by: userId })
        .where("id", "=", invite.id)
        .execute();
      await recordEvent(transaction, {
        tripId: invite.tripId,
        actorId: userId,
        eventType: "invite.accepted",
        targetType: "invite",
        targetId: invite.id,
        summary: "Accepted an editor invitation",
      });
      const response = { tripId: invite.tripId };
      await remember(transaction, userId, operation, key, response);
      return response;
    });
  }

  async revokeInvite(userId: string, tripId: string, inviteId: string, rawKey: string) {
    const key = requireIdempotencyKey(rawKey);
    const operation = `ri:${tripId}:${inviteId}`;
    await this.database.transaction().execute(async (transaction) => {
      await requireOwner(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return;
      const invite = await transaction
        .selectFrom("invites")
        .select(["id", "accepted_at", "revoked_at"])
        .where("id", "=", inviteId)
        .where("trip_id", "=", tripId)
        .forUpdate()
        .executeTakeFirst();
      if (!invite) {
        throw new AppError("invite_not_found", "Invitation not found", 404);
      }
      if (invite.accepted_at || invite.revoked_at) {
        throw new AppError("conflict", "Only pending invitations can be revoked", 409);
      }
      await transaction
        .updateTable("invites")
        .set({ revoked_at: this.now() })
        .where("id", "=", inviteId)
        .execute();
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "invite.revoked",
        targetType: "invite",
        targetId: inviteId,
        summary: "Revoked an editor invitation",
      });
      await remember(transaction, userId, operation, key, { deleted: true });
    });
  }

  async removeMember(userId: string, tripId: string, memberUserId: string, rawKey: string) {
    const key = requireIdempotencyKey(rawKey);
    const operation = `rm:${tripId}:${memberUserId}`;
    await this.database.transaction().execute(async (transaction) => {
      await requireOwner(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return;
      const trip = await transaction.selectFrom("trips")
        .select("id")
        .where("id", "=", tripId)
        .forUpdate()
        .executeTakeFirst();
      if (!trip) throw new AppError("trip_not_found", "Trip not found", 404);
      const member = await transaction
        .selectFrom("trip_members")
        .select(["user_id", "role", "removed_at"])
        .where("trip_id", "=", tripId)
        .where("user_id", "=", memberUserId)
        .forUpdate()
        .executeTakeFirst();
      if (!member || member.removed_at) {
        throw new AppError("trip_not_found", "Trip member not found", 404);
      }
      if (member.role === "owner") {
        throw new AppError("forbidden", "The trip owner cannot be removed", 403);
      }
      await transaction
        .updateTable("trip_members")
        .set({ removed_at: this.now() })
        .where("trip_id", "=", tripId)
        .where("user_id", "=", memberUserId)
        .execute();
      await recordEvent(transaction, {
        tripId,
        actorId: userId,
        eventType: "member.removed",
        targetType: "user",
        targetId: memberUserId,
        summary: "Removed an editor",
      });
      await remember(transaction, userId, operation, key, { deleted: true });
    });
  }

  async setEditorsCanSchedule(userId: string, tripId: string, rawKey: string, enabled: boolean) {
    const key = requireIdempotencyKey(rawKey);
    const operation = `ecs:${tripId}`;
    await this.database.transaction().execute(async (transaction) => {
      await requireOwner(transaction, userId, tripId);
      await lockMutation(transaction, userId, operation, key);
      const replay = await replayed(transaction, userId, operation, key);
      if (replay) return;
      const trip = await transaction.selectFrom("trips")
        .select("editors_can_schedule")
        .where("id", "=", tripId)
        .forUpdate()
        .executeTakeFirst();
      if (!trip) throw new AppError("trip_not_found", "Trip not found", 404);
      if (trip.editors_can_schedule !== enabled) {
        await transaction.updateTable("trips")
          .set({ editors_can_schedule: enabled, updated_at: this.now() })
          .where("id", "=", tripId)
          .execute();
        // The event also advances the trip version, so editors' open sessions pick up the change.
        await recordEvent(transaction, {
          tripId,
          actorId: userId,
          eventType: enabled ? "trip.editors_can_schedule_enabled" : "trip.editors_can_schedule_disabled",
          targetType: "trip",
          targetId: tripId,
          summary: enabled ? "Let editors arrange the itinerary" : "Stopped editors from arranging the itinerary",
        });
      }
      await remember(transaction, userId, operation, key, { editorsCanSchedule: enabled });
    });
  }
}
