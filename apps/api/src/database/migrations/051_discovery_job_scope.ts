import { sql, type Kysely } from "kysely";

// 調查 first asks 範圍 (owner rule 2026-10-28): nearby searches around the center, city and region
// search the whole trip destination (region also its day-trip towns). Existing rows were nearby
// searches, so the default keeps them as they are. Expand-only: older releases never read it.
export async function up(database: Kysely<unknown>) {
  await sql`
    alter table discovery_jobs add column scope varchar(10) not null default 'nearby'
      check (scope in ('nearby', 'city', 'region'));
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`alter table discovery_jobs drop column scope`.execute(database);
}
