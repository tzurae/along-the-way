import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";

import {
  createDatabase,
  type AlongTheWayDatabase,
} from "../src/database/database";
import { runMigrations } from "../src/database/migrate";
import { seedDatabase } from "../src/database/seed";
import { PostgresTripSummaryStore } from "../src/trips/postgres-trip-summary-store";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for integration tests");
}

describe("PostgreSQL/PostGIS trip summary integration", () => {
  let database: Kysely<AlongTheWayDatabase>;

  beforeAll(async () => {
    database = createDatabase(databaseUrl);
    await runMigrations(database);
    await seedDatabase(database);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it("reads the seeded demo trip through the production store", async () => {
    const store = new PostgresTripSummaryStore(database);

    const trip = await store.findBySlug("hong-kong-together");

    expect(trip).toMatchObject({
      slug: "hong-kong-together",
      title: "一起走的香港四日",
      destination: "香港",
      startDate: "2026-08-28",
      endDate: "2026-08-31",
      travelerCount: 2,
      dayCount: 4,
      nextDecision: "一起選定第二天晚餐",
    });
    expect(await store.isReady()).toBe(true);
  });

  it("can rerun migrations and seed without duplicating data", async () => {
    await runMigrations(database);
    await seedDatabase(database);

    const result = await database
      .selectFrom("trip_summaries")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("slug", "=", "hong-kong-together")
      .executeTakeFirstOrThrow();

    expect(Number(result.count)).toBe(1);
  });

  it("enables the PostGIS extension", async () => {
    const result = await sql<{ extensionName: string }>`
      select extname as "extensionName"
      from pg_extension
      where extname = 'postgis'
    `.execute(database);

    expect(result.rows).toEqual([{ extensionName: "postgis" }]);
  });
});
