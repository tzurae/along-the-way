import { sql, type Kysely } from "kysely";

// Expand-only: retained releases do not read or write this owner-approved provider cache.
export async function up(database: Kysely<unknown>) {
  await sql`
    create table transit_leg_cache (
      trip_id uuid not null references trips(id) on delete cascade,
      travel_date date not null,
      from_lat numeric(9,6) not null check (from_lat between -90 and 90),
      from_lon numeric(9,6) not null check (from_lon between -180 and 180),
      to_lat numeric(9,6) not null check (to_lat between -90 and 90),
      to_lon numeric(9,6) not null check (to_lon between -180 and 180),
      minutes integer check (minutes >= 0),
      lines jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
      shape_geojson jsonb,
      minutes_fetched_at timestamptz,
      shape_fetched_at timestamptz,
      primary key (trip_id, travel_date, from_lat, from_lon, to_lat, to_lon),
      check ((minutes is null) = (minutes_fetched_at is null)),
      check ((shape_geojson is null) = (shape_fetched_at is null))
    );
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`drop table transit_leg_cache`.execute(database);
}
