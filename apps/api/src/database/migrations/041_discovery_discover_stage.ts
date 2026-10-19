import { sql, type Kysely } from "kysely";

// Owner decision 2026-10-20: 調查 finds real places on Google Maps (Grounding Lite) before the
// research model picks among them, shown as its own 「在地圖上找店」 stage. Expand-only: older
// releases never write 'discover'.
export async function up(database: Kysely<unknown>) {
  await sql`
    alter table discovery_jobs drop constraint discovery_jobs_stage_check;
    alter table discovery_jobs add constraint discovery_jobs_stage_check
      check (stage in ('plan', 'discover', 'research', 'verify', 'save', 'photos'));
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    update discovery_jobs set stage = 'research' where stage = 'discover';
    alter table discovery_jobs drop constraint discovery_jobs_stage_check;
    alter table discovery_jobs add constraint discovery_jobs_stage_check
      check (stage in ('plan', 'research', 'verify', 'save', 'photos'));
  `.execute(database);
}
