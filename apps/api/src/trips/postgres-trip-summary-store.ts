import { sql, type Kysely } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";
import type { TripSummary, TripSummaryStore } from "./trip-summary-store";

function toDateOnly(value: Date | string) {
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return value;
    }
    throw new Error("Database returned an invalid date-only value");
  }

  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class PostgresTripSummaryStore implements TripSummaryStore {
  constructor(private readonly database: Kysely<AlongTheWayDatabase>) {}

  async isReady() {
    await sql`select 1`.execute(this.database);
    return true;
  }

  async findBySlug(slug: string): Promise<TripSummary | undefined> {
    const row = await this.database
      .selectFrom("trip_summaries")
      .select([
        "slug",
        "title",
        "destination",
        "start_date as startDate",
        "end_date as endDate",
        "traveler_count as travelerCount",
        "day_count as dayCount",
        "next_decision as nextDecision",
        "updated_at as updatedAt",
      ])
      .where("slug", "=", slug)
      .executeTakeFirst();

    if (!row) {
      return undefined;
    }

    return {
      slug: row.slug,
      title: row.title,
      destination: row.destination,
      startDate: toDateOnly(row.startDate),
      endDate: toDateOnly(row.endDate),
      travelerCount: row.travelerCount,
      dayCount: row.dayCount,
      nextDecision: row.nextDecision,
      updatedAt:
        row.updatedAt instanceof Date
          ? row.updatedAt.toISOString()
          : new Date(row.updatedAt).toISOString(),
    };
  }
}
