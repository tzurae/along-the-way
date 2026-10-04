import { sql, type Kysely } from "kysely";

// Additive: older runs and proposals read as "no shortfalls recorded", "no kind",
// and "no endorsements", and an older binary never reads or writes these columns.
export async function up(database: Kysely<unknown>) {
  await sql`
    alter table discovery_runs
      add column shortfalls jsonb not null default '[]'::jsonb
  `.execute(database);
  await sql`
    alter table candidate_proposals
      add column category varchar(80),
      add column endorsements jsonb not null default '[]'::jsonb
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    alter table candidate_proposals
      drop column endorsements,
      drop column category
  `.execute(database);
  await sql`alter table discovery_runs drop column shortfalls`.execute(database);
}
