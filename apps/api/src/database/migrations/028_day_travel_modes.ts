import { sql, type Kysely } from "kysely";

// Expand-only: the previous release ignores these columns (it always walks up to 15 minutes, then
// takes transit), so rolling the API back needs no migration.
export async function up(database: Kysely<unknown>) {
  // How a day's legs are travelled unless a leg says otherwise, and the longest walk it accepts.
  await sql`
    alter table trip_days
      add column travel_mode varchar(16) not null default 'transit'
        check (travel_mode in ('transit', 'taxi', 'walk')),
      add column walk_limit_minutes integer not null default 15
        check (walk_limit_minutes between 5 and 60)
  `.execute(database);
  // The way to reach this place on its day; null follows the day's travel mode.
  await sql`
    alter table trip_place_day_assignments
      add column arrival_mode varchar(16)
        check (arrival_mode in ('transit', 'taxi', 'walk'))
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`alter table trip_place_day_assignments drop column arrival_mode`.execute(database);
  await sql`alter table trip_days drop column walk_limit_minutes, drop column travel_mode`.execute(database);
}
