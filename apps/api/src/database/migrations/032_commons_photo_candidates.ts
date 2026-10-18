import { sql, type Kysely } from "kysely";

// Expand-only: older releases ignore manual-review candidates and continue serving confirmed photos.
export async function up(database: Kysely<unknown>) {
  await sql`
    create table commons_photo_candidates (
      id uuid primary key default gen_random_uuid(),
      place_id uuid not null references place_identities(id) on delete cascade,
      wikidata_id varchar(20) not null check (wikidata_id ~ '^Q[1-9][0-9]*$'),
      label varchar(500) not null check (length(trim(label)) > 0),
      description varchar(2000),
      distance_meters integer check (distance_meters is null or distance_meters >= 0),
      metadata jsonb not null check (jsonb_typeof(metadata) = 'object'),
      status varchar(20) not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
      decided_by_user_id uuid references users(id),
      decided_at timestamptz,
      created_at timestamptz not null default now(),
      unique (place_id, wikidata_id),
      check (
        (status = 'pending' and decided_by_user_id is null and decided_at is null)
        or (status <> 'pending' and decided_by_user_id is not null and decided_at is not null)
      )
    );
    create index commons_photo_candidates_pending_place_idx
      on commons_photo_candidates (place_id, distance_meters, created_at, id)
      where status = 'pending';
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`drop table commons_photo_candidates`.execute(database);
}
