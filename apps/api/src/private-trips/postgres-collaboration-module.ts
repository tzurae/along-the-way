import { sql, type Kysely } from "kysely";
import type { ConflictChange, TripChangeNotification, TripHistoryResponse } from "@along-the-way/contracts/private-trips";
import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "./private-trip-module";
import { isoTimestamp } from "./postgres-private-trip-store";

export class PostgresCollaborationModule {
  constructor(private readonly database: Kysely<AlongTheWayDatabase>) {}

  async authorize(userId: string, tripId: string) {
    const member = await this.database.selectFrom("trip_members").select(["id", "role"])
      .where("trip_id", "=", tripId).where("user_id", "=", userId)
      .where("removed_at", "is", null).executeTakeFirst();
    if (!member) throw new AppError("trip_not_found", "Trip not found", 404);
    return member;
  }

  async version(userId: string, tripId: string) {
    await this.authorize(userId, tripId);
    const latest = await this.database.selectFrom("change_events").select(["id", "event_order"])
      .where("trip_id", "=", tripId).orderBy("event_order", "desc").limit(1).executeTakeFirst();
    return { tripVersion: Number(latest?.event_order ?? 0), lastEventId: latest?.id ?? null };
  }

  async cursor(userId: string, tripId: string, id: string | null) {
    await this.authorize(userId, tripId);
    if (id === null) return "0";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new AppError("validation_error", "Invalid event cursor");
    }
    const event = await this.database.selectFrom("change_events").select("event_order")
      .where("trip_id", "=", tripId).where("id", "=", id).executeTakeFirst();
    if (!event) throw new AppError("validation_error", "Invalid event cursor");
    return event.event_order;
  }

  async after(userId: string, tripId: string, order: string) {
    await this.authorize(userId, tripId);
    const rows = await this.database.selectFrom("change_events")
      .select(["id", "event_order", "target_type", "target_id", "event_type", "summary"])
      .where("trip_id", "=", tripId).where("event_order", ">", order)
      .orderBy("event_order").limit(100).execute();
    return rows.map((row) => ({
      order: row.event_order,
      notification: {
        id: row.id, tripVersion: Number(row.event_order), entityType: row.target_type,
        entityId: row.target_id, kind: row.event_type, summary: row.summary,
      } satisfies TripChangeNotification,
    }));
  }

  async history(userId: string, tripId: string, before: string | null, limit: number): Promise<TripHistoryResponse> {
    const requester = await this.authorize(userId, tripId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new AppError("validation_error", "limit must be between 1 and 100");
    }
    const order = before ? await this.cursor(userId, tripId, before) : null;
    let query = this.database.selectFrom("change_events as event")
      .innerJoin("users as actor", "actor.id", "event.actor_id")
      .select(["event.id", "event.actor_id", "actor.display_name", "actor.email", "event.created_at", "event.event_type", "event.target_type", "event.target_id", "event.summary", "event.conflict_base_version"])
      .select(sql<boolean>`exists (
        select 1 from trip_members actor_membership
        where actor_membership.trip_id = event.trip_id
          and actor_membership.user_id = event.actor_id
          and actor_membership.removed_at is null
      )`.as("actor_is_active_member"))
      .select(sql<string | null>`case event.target_type
        when 'trip' then (
          select name from trips where id = event.target_id and id = event.trip_id
        )
        when 'trip_place' then (
          select place.name from trip_places target join places place
            on place.id = target.legacy_place_id and place.trip_id = target.trip_id
          where target.id = event.target_id and target.trip_id = event.trip_id and target.archived_at is null
        )
        when 'place' then (
          select name from places where id = event.target_id and trip_id = event.trip_id
        )
        when 'itinerary_item' then (
          select title from itinerary_items where id = event.target_id and trip_id = event.trip_id
        )
        when 'trip_day' then (
          select date::text from trip_days where id = event.target_id and trip_id = event.trip_id
        )
        when 'constraint' then (
          select item.title from itinerary_constraints target join itinerary_items item
            on item.id = target.itinerary_item_id and item.trip_id = target.trip_id
          where target.id = event.target_id and target.trip_id = event.trip_id
        )
        when 'candidate_proposal' then (
          select name from candidate_proposals where id = event.target_id and trip_id = event.trip_id
        )
        else null
      end`.as("target_name"))
      .where("event.trip_id", "=", tripId);
    if (order) query = query.where("event.event_order", "<", order);
    const rows = await query.orderBy("event.event_order", "desc").limit(limit + 1).execute();
    const events = rows.slice(0, limit).map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      actorDisplayName: row.display_name,
      actorEmail: row.actor_is_active_member && (requester.role === "owner" || row.actor_id === userId)
        ? row.email
        : null,
      actorIsActiveMember: row.actor_is_active_member,
      createdAt: isoTimestamp(row.created_at), eventType: row.event_type,
      targetType: row.target_type, targetId: row.target_id, summary: row.summary,
      targetName: row.target_name,
      reappliedFromVersion: row.conflict_base_version,
    }));
    return { events, nextCursor: rows.length > limit ? events[events.length - 1]!.id : null };
  }

  async latestChange(userId: string, tripId: string, targetIds: string[]): Promise<ConflictChange | null> {
    const requester = await this.authorize(userId, tripId);
    const mirrors = await this.database.selectFrom("trip_places").select(["id", "legacy_place_id"])
      .where("trip_id", "=", tripId)
      .where((where) => where.or([where("id", "in", targetIds), where("legacy_place_id", "in", targetIds)])).execute();
    const relatedIds = [...targetIds, ...mirrors.flatMap((place) => [place.id, place.legacy_place_id])];
    const event = await this.database.selectFrom("change_events as event")
      .innerJoin("users as actor", "actor.id", "event.actor_id")
      .select(["event.id", "event.actor_id", "actor.display_name", "actor.email", "event.created_at"])
      .select(sql<boolean>`exists (
        select 1 from trip_members actor_membership
        where actor_membership.trip_id = event.trip_id
          and actor_membership.user_id = event.actor_id
          and actor_membership.removed_at is null
      )`.as("actor_is_active_member"))
      .where("event.trip_id", "=", tripId)
      .where((where) => where.or([where("event.target_id", "in", relatedIds), sql<boolean>`event.related_target_ids && ${relatedIds}::uuid[]`]))
      .orderBy("event.event_order", "desc").limit(1).executeTakeFirst();
    return event ? {
      eventId: event.id,
      actorId: event.actor_id,
      actorDisplayName: event.display_name,
      actorEmail: event.actor_is_active_member && (requester.role === "owner" || event.actor_id === userId)
        ? event.email
        : null,
      actorIsActiveMember: event.actor_is_active_member,
      isOwn: event.actor_id === userId, changedAt: isoTimestamp(event.created_at),
    } : null;
  }
}
