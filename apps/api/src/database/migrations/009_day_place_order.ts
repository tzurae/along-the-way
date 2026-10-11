import { sql, type Kysely } from "kysely";

// Additive: an older binary never reads or writes the column, and the 007
// synchronization trigger recreates rows with a null position on reassignment.
export async function up(database: Kysely<unknown>) {
  await sql`
    alter table trip_place_day_assignments
      add column day_position integer check (day_position >= 0)
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`alter table trip_place_day_assignments drop column day_position`.execute(database);
}
