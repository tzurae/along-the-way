import { sql, type Kysely } from "kysely";

// 調查 near a center asks how the traveler gets around and for how long (owner rule 2026-10-22).
// The answer is two enum values, not personal data, so unlike near it stays on the row.
// Expand-only: a nullable column older releases never read.
export async function up(database: Kysely<unknown>) {
  await sql`
    alter table discovery_jobs add column reach jsonb
      check (reach is null or coalesce(
        jsonb_typeof(reach->'mode') = 'string' and reach->>'mode' in ('walk', 'transit', 'taxi')
        and (jsonb_typeof(reach->'maxMinutes') = 'null'
          or (jsonb_typeof(reach->'maxMinutes') = 'number' and reach->>'maxMinutes' in ('5', '10', '15'))),
        false
      ));
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`alter table discovery_jobs drop column reach`.execute(database);
}
