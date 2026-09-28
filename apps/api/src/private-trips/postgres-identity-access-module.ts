import { randomBytes, randomUUID } from "node:crypto";

import {
  parseInviteResponse,
  type InviteDto,
} from "@along-the-way/contracts/private-trips";
import type { Kysely } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import {
  AppError,
  type AcceptedInvite,
  type AuthenticatedUser,
  type IdentityAccessModule,
  type InviteReadModel,
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

const MAGIC_LINK_LIFETIME_MS = 15 * 60 * 1_000;
const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

interface ModuleOptions {
  database: Kysely<AlongTheWayDatabase>;
  tokenIssuer: TokenIssuer;
  now?: () => Date;
  randomSessionToken?: () => string;
  randomIdentifier?: () => string;
}

function defaultSessionToken() {
  return randomBytes(32).toString("base64url");
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

  constructor(options: ModuleOptions) {
    this.database = options.database;
    this.tokenIssuer = options.tokenIssuer;
    this.now = options.now ?? (() => new Date());
    this.randomSessionToken = options.randomSessionToken ?? defaultSessionToken;
    this.randomIdentifier = options.randomIdentifier ?? randomUUID;
  }

  async requestMagicLink(rawEmail: string, inviteToken?: string) {
    const email = normalizeEmail(rawEmail);
    if (!validEmail(email)) return;

    await this.database.transaction().execute(async (transaction) => {
      const user = await transaction
        .selectFrom("users")
        .select(["id", "email"])
        .where("email", "=", email)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!user) return;

      let inviteId: string | null = null;
      if (inviteToken) {
        const pendingInvite = await transaction
          .selectFrom("invites")
          .select("id")
          .where("token_hash", "=", hashToken(inviteToken))
          .where("email", "=", user.email)
          .where("accepted_at", "is", null)
          .where("revoked_at", "is", null)
          .where("expires_at", ">", this.now())
          .executeTakeFirst();
        inviteId = pendingInvite?.id ?? null;
      }

      const id = this.randomIdentifier();
      const token = this.tokenIssuer.issue(id);
      await transaction
        .insertInto("magic_link_tokens")
        .values({
          id,
          user_id: user.id,
          token_hash: hashToken(token),
          linked_invite_id: inviteId,
          expires_at: new Date(this.now().valueOf() + MAGIC_LINK_LIFETIME_MS),
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
          available_at: this.now(),
          delivered_at: null,
        })
        .execute();
    });
  }

  async consumeMagicLink(token: string): Promise<SessionResult> {
    const sessionToken = this.randomSessionToken();
    const now = this.now();
    return this.database.transaction().execute(async (transaction) => {
      const link = await transaction
        .selectFrom("magic_link_tokens")
        .innerJoin("users", "users.id", "magic_link_tokens.user_id")
        .select([
          "magic_link_tokens.id",
          "magic_link_tokens.expires_at",
          "magic_link_tokens.used_at",
          "magic_link_tokens.revoked_at",
          "users.id as userId",
          "users.email",
          "users.display_name as displayName",
        ])
        .where("magic_link_tokens.token_hash", "=", hashToken(token))
        .forUpdate()
        .executeTakeFirst();

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
          expires_at: new Date(now.valueOf() + SESSION_LIFETIME_MS),
          revoked_at: null,
        })
        .execute();

      return {
        sessionToken,
        user: {
          id: link.userId,
          email: link.email,
          displayName: link.displayName,
        },
      };
    });
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
        "sessions.revoked_at",
        "users.id as userId",
        "users.email",
        "users.display_name as displayName",
      ])
      .where("sessions.token_hash", "=", hashToken(sessionToken))
      .executeTakeFirst();

    if (!session || session.revoked_at || new Date(session.expires_at) <= now) {
      return null;
    }

    await this.database
      .updateTable("sessions")
      .set({
        last_seen_at: now,
        expires_at: new Date(now.valueOf() + SESSION_LIFETIME_MS),
      })
      .where("id", "=", session.id)
      .execute();

    return {
      id: session.userId,
      email: session.email,
      displayName: session.displayName,
    };
  }

  async logout(sessionToken: string) {
    if (!sessionToken) return;
    await this.database
      .updateTable("sessions")
      .set({ revoked_at: this.now() })
      .where("token_hash", "=", hashToken(sessionToken))
      .where("revoked_at", "is", null)
      .execute();
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

      await transaction
        .insertInto("users")
        .values({ email, display_name: null, status: "active" })
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
      await lockMutation(transaction, userId, "accept_invite", key);
      const replay = await replayed(transaction, userId, "accept_invite", key);
      if (replay) return { tripId: storedTripId(replay) };

      const user = await transaction
        .selectFrom("users")
        .select("email")
        .where("id", "=", userId)
        .executeTakeFirstOrThrow();
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
      await remember(transaction, userId, "accept_invite", key, response);
      return response;
    });
  }

  async revokeInvite(userId: string, tripId: string, inviteId: string) {
    await this.database.transaction().execute(async (transaction) => {
      await requireOwner(transaction, userId, tripId);
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
    });
  }

  async removeMember(userId: string, tripId: string, memberUserId: string) {
    await this.database.transaction().execute(async (transaction) => {
      await requireOwner(transaction, userId, tripId);
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
    });
  }
}
