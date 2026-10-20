import { sql, type Kysely } from "kysely";

// Expand-only: retained releases neither read nor write replacement history.
export async function up(database: Kysely<unknown>) {
  await sql`
    create table trip_stop_replacements (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null,
      trip_day_id uuid not null,
      original_trip_place_id uuid not null,
      replacement_trip_place_id uuid not null,
      status text not null check (status in ('active', 'superseded', 'undone')),
      created_by uuid references users(id) on delete set null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (original_trip_place_id <> replacement_trip_place_id),
      foreign key (trip_id, trip_day_id) references trip_days(trip_id, id) on delete cascade,
      foreign key (trip_id, original_trip_place_id) references trip_places(trip_id, id) on delete cascade,
      foreign key (trip_id, replacement_trip_place_id) references trip_places(trip_id, id) on delete cascade
    );
    create unique index trip_stop_replacements_active_replacement_idx
      on trip_stop_replacements (replacement_trip_place_id) where status = 'active';
    create index trip_stop_replacements_trip_day_idx on trip_stop_replacements (trip_id, trip_day_id);
    create index trip_stop_replacements_original_idx on trip_stop_replacements (original_trip_place_id);
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`drop table trip_stop_replacements`.execute(database);
}
