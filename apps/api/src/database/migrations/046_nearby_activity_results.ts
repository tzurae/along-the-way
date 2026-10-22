import { sql, type Kysely } from "kysely";

// 附近活動 (view only): the last successful web-search answer for one stop on one local date, so a
// repeat tap later that local day costs no model call. Expand-only: older releases never read this table.
export async function up(database: Kysely<unknown>) {
  await sql`
    create table nearby_activity_results (
      trip_id uuid not null references trips(id) on delete cascade,
      trip_place_id uuid not null,
      local_date date not null,
      results jsonb not null check (jsonb_typeof(results) = 'array'),
      fetched_at timestamptz not null,
      primary key (trip_place_id, local_date),
      foreign key (trip_id, trip_place_id) references trip_places(trip_id, id) on delete cascade
    );
    create index nearby_activity_results_trip_idx on nearby_activity_results (trip_id);
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`drop table nearby_activity_results`.execute(database);
}
