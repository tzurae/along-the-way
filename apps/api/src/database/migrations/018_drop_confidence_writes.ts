import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  // Expand step: this release stops writing confidence. A default keeps every row valid for
  // the previous release, which still reads it as high/medium/low after a rollback.
  await sql`alter table candidate_proposals alter column confidence set default 'medium'`.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`alter table candidate_proposals alter column confidence drop default`.execute(database);
}
