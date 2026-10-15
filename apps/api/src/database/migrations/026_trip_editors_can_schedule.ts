import { sql, type Kysely } from "kysely";

// Expand-only: the previous release ignores this column (only owners schedule), so rollback stays
// migration-free safe.
export async function up(database: Kysely<unknown>) {
  await sql`
    alter table trips
      add column editors_can_schedule boolean not null default false
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`alter table trips drop column editors_can_schedule`.execute(database);
}
