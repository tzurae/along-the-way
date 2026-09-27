import { Kysely, PostgresDialect, type ColumnType } from "kysely";
import { Pool } from "pg";

interface TripSummaryTable {
  id: string;
  slug: string;
  title: string;
  destination: string;
  start_date: ColumnType<Date, string, string>;
  end_date: ColumnType<Date, string, string>;
  traveler_count: number;
  day_count: number;
  next_decision: string | null;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface AlongTheWayDatabase {
  trip_summaries: TripSummaryTable;
}

export function createDatabase(databaseUrl: string) {
  return new Kysely<AlongTheWayDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 10,
        query_timeout: 5_000,
        statement_timeout: 5_000,
      }),
    }),
  });
}

export function requireDatabaseUrl(
  environment: Record<string, string | undefined> = process.env,
) {
  const databaseUrl = environment.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  return databaseUrl;
}
