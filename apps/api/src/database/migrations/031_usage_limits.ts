import { sql, type Kysely } from "kysely";

// Indexes the hourly retention scan without constraining legitimate replay payloads created by
// an older release; current list-returning mutations persist bounded readback markers.
export async function up(database: Kysely<unknown>) {
  await sql`
    create index mutation_requests_retention
      on mutation_requests (created_at)
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`drop index mutation_requests_retention`.execute(database);
}
