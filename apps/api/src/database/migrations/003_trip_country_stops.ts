import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`
    alter table trips
      add column default_currency char(3)
  `.execute(database);

  await sql`
    create table trip_country_stops (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null references trips(id) on delete cascade,
      country_code char(2) not null,
      position integer not null check (position >= 0),
      time_zone varchar(100),
      unique (trip_id, position)
    )
  `.execute(database);

  // Legacy destination names are intentionally not guessed into country codes.
}

export async function down(database: Kysely<unknown>) {
  await database.schema.dropTable("trip_country_stops").ifExists().execute();
  await database.schema
    .alterTable("trips")
    .dropColumn("default_currency")
    .execute();
}
