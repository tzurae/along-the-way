import { sql, type Kysely } from "kysely";

import {
  createDatabase,
  requireDatabaseUrl,
  type AlongTheWayDatabase,
} from "./database";

const demoTrip = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "hong-kong-together",
  title: "一起走的香港四日",
  destination: "香港",
  start_date: "2026-08-28",
  end_date: "2026-08-31",
  traveler_count: 2,
  day_count: 4,
  next_decision: "一起選定第二天晚餐",
};

export async function seedDatabase(database: Kysely<AlongTheWayDatabase>) {
  await database
    .insertInto("trip_summaries")
    .values(demoTrip)
    .onConflict((conflict) =>
      conflict.column("slug").doUpdateSet({
        title: demoTrip.title,
        destination: demoTrip.destination,
        start_date: demoTrip.start_date,
        end_date: demoTrip.end_date,
        traveler_count: demoTrip.traveler_count,
        day_count: demoTrip.day_count,
        next_decision: demoTrip.next_decision,
        updated_at: sql`now()`,
      }),
    )
    .execute();
}

if (import.meta.main) {
  const database = createDatabase(requireDatabaseUrl());

  try {
    await seedDatabase(database);
  } finally {
    await database.destroy();
  }
}
