import { sql, type Kysely } from "kysely";

// Additive: existing days get the 09:00–19:00 default, and an older binary never
// reads or writes the columns. Minutes count from local midnight of the day.
export async function up(database: Kysely<unknown>) {
  await sql`
    alter table trip_days
      add column day_start_minute smallint not null default 540,
      add column day_end_minute smallint not null default 1140,
      add constraint trip_days_day_window_check
        check (day_start_minute >= 0 and day_start_minute < day_end_minute and day_end_minute <= 1440)
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    alter table trip_days
      drop constraint trip_days_day_window_check,
      drop column day_start_minute,
      drop column day_end_minute
  `.execute(database);
}
