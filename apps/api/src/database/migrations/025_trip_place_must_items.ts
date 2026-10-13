import { sql, type Kysely } from "kysely";

// Expand-only: the previous release ignores this table, so rollback remains migration-free safe.
export async function up(database: Kysely<unknown>) {
  await sql`
    create table trip_place_must_items (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null references trips(id) on delete cascade,
      trip_place_id uuid not null references trip_places(id) on delete cascade,
      kind varchar(10) not null check (kind in ('buy', 'eat', 'drink')),
      label varchar(80) not null check (char_length(label) between 1 and 80),
      normalized_label text not null,
      version integer not null default 1 check (version > 0),
      created_by uuid not null references users(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create unique index trip_place_must_items_normalized_unique
      on trip_place_must_items (trip_place_id, kind, normalized_label);

    create index trip_place_must_items_order
      on trip_place_must_items (trip_place_id, kind, created_at);
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`drop table trip_place_must_items`.execute(database);
}
