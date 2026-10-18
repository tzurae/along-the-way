import type {
  CreateFeedbackInput,
  FeedbackAdminDto,
  FeedbackStatus,
  FeedbackType,
  UpdateFeedbackAdminInput,
} from "@along-the-way/contracts/admin";
import type { Kysely, Transaction } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "../private-trips/private-trip-module";
import { isoTimestamp } from "../private-trips/postgres-private-trip-store";

export interface FeedbackModule {
  submit(
    userId: string,
    input: CreateFeedbackInput,
    metadata: { appVersion: string; userAgent: string | null },
  ): Promise<{ id: string }>;
  list(filters: { status?: FeedbackStatus; type?: FeedbackType }): Promise<FeedbackAdminDto[]>;
  update(id: string, input: UpdateFeedbackAdminInput): Promise<FeedbackAdminDto>;
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
          body: input.body,
          page: input.page,
          contact_allowed: input.contactAllowed,
          app_version: metadata.appVersion,
          user_agent: metadata.userAgent,
          viewport: input.viewport,
          admin_note: null,
          created_at: now,
          updated_at: now,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
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
      .select([
        "feedback.id",
        "feedback.type",
        "feedback.body",
        "feedback.page",
        "feedback.trip_id",
        "trips.name as trip_name",
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
