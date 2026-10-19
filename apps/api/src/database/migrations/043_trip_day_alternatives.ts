import { sql, type Kysely } from "kysely";

// Feedback 5c1bf6b7 (2026-10-20): a day keeps 「備案」, e.g. three more restaurants near the planned
// lunch. They are not stops: they never join the day's order, route or load, so they live outside
// trip_place_day_assignments. Expand-only: older releases never read this table.
export async function up(database: Kysely<unknown>) {
  await sql`
    create table trip_day_alternatives (
      trip_id uuid not null,
      trip_day_id uuid not null,
      trip_place_id uuid not null,
      position integer not null check (position >= 0),
      created_by uuid references users(id) on delete set null,
      created_at timestamptz not null default now(),
      primary key (trip_day_id, trip_place_id),
      unique (trip_day_id, position),
      foreign key (trip_id, trip_day_id) references trip_days(trip_id, id) on delete cascade,
      foreign key (trip_id, trip_place_id) references trip_places(trip_id, id) on delete cascade
    );
    create index trip_day_alternatives_place_idx on trip_day_alternatives (trip_place_id);
    alter table trip_days add column alternatives_version integer not null default 1
      constraint trip_days_alternatives_version_positive check (alternatives_version > 0);
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    drop table trip_day_alternatives;
    alter table trip_days drop column alternatives_version;
  `.execute(database);
}
