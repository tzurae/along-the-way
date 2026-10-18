import type {
  CreateFeedbackInput,
  CreatePhotoFeedbackInput,
  FeedbackAdminDto,
  FeedbackStatus,
  FeedbackType,
  PhotoFeedbackReason,
  UpdateFeedbackAdminInput,
} from "@along-the-way/contracts/admin";
import type { Kysely, Transaction } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "../private-trips/private-trip-module";
import { isoTimestamp } from "../private-trips/postgres-private-trip-store";
import { removeCommonsPhoto } from "../place-details/commons-photo-candidates";

export interface FeedbackModule {
  submit(
    userId: string,
    input: CreateFeedbackInput,
    metadata: { appVersion: string; userAgent: string | null },
  ): Promise<{ id: string }>;
  submitPhoto(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    input: CreatePhotoFeedbackInput,
    metadata: { appVersion: string; userAgent: string | null },
  ): Promise<{ id: string }>;
  list(filters: { status?: FeedbackStatus; type?: FeedbackType }): Promise<FeedbackAdminDto[]>;
  update(id: string, input: UpdateFeedbackAdminInput): Promise<FeedbackAdminDto>;
  removePhoto(id: string, adminUserId: string): Promise<FeedbackAdminDto>;
}

type FeedbackExecutor = Kysely<AlongTheWayDatabase> | Transaction<AlongTheWayDatabase>;

export class PostgresFeedbackModule implements FeedbackModule {
  constructor(
    private readonly database: Kysely<AlongTheWayDatabase>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async submit(
    userId: string,
    input: CreateFeedbackInput,
    metadata: { appVersion: string; userAgent: string | null },
  ) {
    return this.database.transaction().execute(async (transaction) => {
      if (input.tripId !== null) {
        const membership = await transaction
          .selectFrom("trip_members")
          .select("user_id")
          .where("trip_id", "=", input.tripId)
          .where("user_id", "=", userId)
          .where("removed_at", "is", null)
          .forShare()
          .executeTakeFirst();
        if (!membership) {
          throw new AppError("forbidden", "tripId must be a trip you belong to", 403);
        }
      }
      const now = this.now();

      return transaction
        .insertInto("feedback")
        .values({
          user_id: userId,
          trip_id: input.tripId,
          type: input.type,
          trip_place_id: null,
          place_name: null,
          body: input.body,
          page: input.page,
          contact_allowed: input.contactAllowed,
          app_version: metadata.appVersion,
          user_agent: metadata.userAgent,
          viewport: input.viewport,
          photo_wikidata_id: null,
          photo_reason: null,
          admin_note: null,
          created_at: now,
          updated_at: now,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    });
  }

  async submitPhoto(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    input: CreatePhotoFeedbackInput,
    metadata: { appVersion: string; userAgent: string | null },
  ) {
    return this.database.transaction().execute(async (transaction) => {
      const membership = await transaction.selectFrom("trip_members")
        .select("user_id")
        .where("trip_id", "=", tripId)
        .where("user_id", "=", userId)
        .where("removed_at", "is", null)
        .forShare()
        .executeTakeFirst();
      if (!membership) throw new AppError("trip_not_found", "Trip not found", 404);
      const tripPlace = await transaction.selectFrom("trip_places")
        .select(["place_id", "name"])
        .where("id", "=", tripPlaceId)
        .where("trip_id", "=", tripId)
        .where("archived_at", "is", null)
        .forShare()
        .executeTakeFirst();
      if (!tripPlace) throw new AppError("trip_place_not_found", "Trip place not found", 404);
      const curatedPhoto = await transaction.selectFrom("curated_place_photos")
        .select("place_id")
        .where("place_id", "=", tripPlace.place_id)
        .executeTakeFirst();
      const commonsPhoto = curatedPhoto
        ? undefined
        : await transaction.selectFrom("commons_place_photos")
            .select("wikidata_id")
            .where("place_id", "=", tripPlace.place_id)
            .executeTakeFirst();
      const body = `照片有問題：地點「${tripPlace.name}」${input.note === null ? "" : `\n備註：${input.note}`}`;
      const now = this.now();
      return transaction.insertInto("feedback").values({
        user_id: userId,
        trip_id: tripId,
        trip_place_id: tripPlaceId,
        place_name: tripPlace.name,
        type: "photo",
        body,
        page: null,
        contact_allowed: false,
        app_version: metadata.appVersion,
        user_agent: metadata.userAgent,
        viewport: null,
        photo_wikidata_id: commonsPhoto?.wikidata_id ?? null,
        photo_reason: input.reason,
        admin_note: null,
        created_at: now,
        updated_at: now,
      }).returning("id").executeTakeFirstOrThrow();
    });
  }

  async list(filters: { status?: FeedbackStatus; type?: FeedbackType }) {
    let query = this.selectReadModel(this.database);
    if (filters.status !== undefined) query = query.where("feedback.status", "=", filters.status);
    if (filters.type !== undefined) query = query.where("feedback.type", "=", filters.type);
    const rows = await query.orderBy("feedback.created_at", "desc").execute();
    return rows.map((row) => this.readModel(row));
  }

  async update(id: string, input: UpdateFeedbackAdminInput) {
    const values: { status?: FeedbackStatus; admin_note?: string | null; updated_at: Date } = {
      updated_at: this.now(),
    };
    if (input.status !== undefined) values.status = input.status;
    if (input.adminNote !== undefined) values.admin_note = input.adminNote;
    const updated = await this.database
      .updateTable("feedback")
      .set(values)
      .where("id", "=", id)
      .returning("id")
      .executeTakeFirst();
    if (!updated) throw new AppError("feedback_not_found", "Feedback not found", 404);
    return this.find(updated.id);
  }

  async removePhoto(id: string, adminUserId: string) {
    const updatedId = await this.database.transaction().execute(async (transaction) => {
      const located = await transaction.selectFrom("feedback")
        .leftJoin("trip_places", "trip_places.id", "feedback.trip_place_id")
        .select(["feedback.id", "feedback.status", "trip_places.place_id"])
        .where("feedback.id", "=", id)
        .where("feedback.type", "=", "photo")
        .executeTakeFirst();
      if (!located) throw new AppError("feedback_not_found", "Photo feedback not found", 404);
      if (located.place_id === null) {
        if (located.status === "done") return located.id;
        throw new AppError("photo_feedback_place_gone", "Reported place no longer exists", 409);
      }
      await transaction.selectFrom("place_identities").select("id")
        .where("id", "=", located.place_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const target = await transaction.selectFrom("feedback")
        .leftJoin("trip_places", "trip_places.id", "feedback.trip_place_id")
        .select([
          "feedback.id",
          "feedback.status",
          "feedback.photo_wikidata_id",
          "trip_places.place_id",
        ])
        .where("feedback.id", "=", id)
        .where("feedback.type", "=", "photo")
        .executeTakeFirst();
      if (!target) throw new AppError("feedback_not_found", "Photo feedback not found", 404);
      if (target.place_id !== located.place_id) {
        if (target.status === "done") return target.id;
        throw new AppError("photo_feedback_place_gone", "Reported place no longer exists", 409);
      }
      if (target.status === "done") {
        if (target.photo_wikidata_id !== null) {
          const current = await transaction.selectFrom("commons_place_photos")
            .select("wikidata_id")
            .where("place_id", "=", target.place_id)
            .executeTakeFirst();
          if (!current) return target.id;
          if (current.wikidata_id !== target.photo_wikidata_id) {
            throw new AppError(
              "commons_photo_not_found",
              "Reported Commons photo is no longer shown",
              409,
            );
          }
        } else {
          const current = await transaction.selectFrom("curated_place_photos")
            .select("place_id")
            .where("place_id", "=", target.place_id)
            .executeTakeFirst();
          if (!current) return target.id;
        }
      }
      if (target.photo_wikidata_id !== null) {
        await removeCommonsPhoto(
          transaction,
          target.place_id,
          adminUserId,
          this.now(),
          target.photo_wikidata_id,
        );
      } else {
        const removed = await transaction.deleteFrom("curated_place_photos")
          .where("place_id", "=", target.place_id)
          .returning("place_id")
          .executeTakeFirst();
        if (!removed) throw new AppError("place_photo_not_found", "Curated photo not found", 409);
        const commonsPhoto = await transaction.selectFrom("commons_place_photos")
          .select("place_id")
          .where("place_id", "=", target.place_id)
          .executeTakeFirst();
        if (commonsPhoto) {
          await removeCommonsPhoto(transaction, target.place_id, adminUserId, this.now());
        }
      }
      const updated = await transaction.updateTable("feedback").set({
        status: "done",
        updated_at: this.now(),
      }).where("id", "=", id)
        .where("type", "=", "photo")
        .returning("id")
        .executeTakeFirst();
      if (!updated) throw new AppError("feedback_not_found", "Photo feedback not found", 404);
      return updated.id;
    });
    return this.find(updatedId);
  }

  private async find(id: string) {
    const row = await this.selectReadModel(this.database)
      .where("feedback.id", "=", id)
      .executeTakeFirst();
    if (!row) throw new AppError("feedback_not_found", "Feedback not found", 404);
    return this.readModel(row);
  }

  private selectReadModel(executor: FeedbackExecutor) {
    return executor
      .selectFrom("feedback")
      .innerJoin("users", "users.id", "feedback.user_id")
      .leftJoin("trips", "trips.id", "feedback.trip_id")
      .leftJoin("trip_places", "trip_places.id", "feedback.trip_place_id")
      .select([
        "feedback.id",
        "feedback.type",
        "feedback.body",
        "feedback.page",
        "feedback.trip_id",
        "trips.name as trip_name",
        "feedback.trip_place_id",
        "trip_places.name as trip_place_name",
        "feedback.place_name as feedback_place_name",
        "feedback.photo_reason",
        "feedback.photo_wikidata_id",
        "feedback.contact_allowed",
        "users.email as submitter_email",
        "feedback.app_version",
        "feedback.user_agent",
        "feedback.viewport",
        "feedback.status",
        "feedback.admin_note",
        "feedback.created_at",
        "feedback.updated_at",
      ]);
  }

  private readModel(row: {
    id: string;
    type: FeedbackType;
    body: string;
    page: string | null;
    trip_id: string | null;
    trip_name: string | null;
    trip_place_id: string | null;
    trip_place_name: string | null;
    feedback_place_name: string | null;
    photo_reason: PhotoFeedbackReason | null;
    photo_wikidata_id: string | null;
    contact_allowed: boolean;
    submitter_email: string;
    app_version: string;
    user_agent: string | null;
    viewport: string | null;
    status: FeedbackStatus;
    admin_note: string | null;
    created_at: Date | string;
    updated_at: Date | string;
  }): FeedbackAdminDto {
    return {
      id: row.id,
      type: row.type,
      body: row.body,
      page: row.page,
      tripId: row.trip_id,
      tripName: row.trip_name,
      tripPlaceId: row.trip_place_id,
      placeName: row.trip_place_name ?? row.feedback_place_name,
      photoReason: row.photo_reason,
      photoWikidataId: row.photo_wikidata_id,
      submitterEmail: row.contact_allowed ? row.submitter_email : null,
      appVersion: row.app_version,
      userAgent: row.user_agent,
      viewport: row.viewport,
      status: row.status,
      adminNote: row.admin_note,
      createdAt: isoTimestamp(row.created_at),
      updatedAt: isoTimestamp(row.updated_at),
    };
  }
}
