import { sql, type Kysely } from "kysely";

// 調查 near the member's phone position (owner decision 2026-10-22: 位置不存). The position lives on
// the job row only while it is queued or running and is cleared when the job ends, like client_ip.
// Expand-only: a nullable column older releases never read.
export async function up(database: Kysely<unknown>) {
  await sql`
    alter table discovery_jobs add column near jsonb
      check (near is null or (jsonb_typeof(near->'latitude') = 'number' and jsonb_typeof(near->'longitude') = 'number'));
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`alter table discovery_jobs drop column near`.execute(database);
}
