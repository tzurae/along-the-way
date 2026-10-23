import { sql, type Kysely } from "kysely";

// 下次還要來: one traveller's "come back here next time" mark on a canonical place, with an optional
// short reason. Visible to everyone who currently shares a trip with the keeper. Expand-only: older
// releases never read this table.
export async function up(database: Kysely<unknown>) {
  await sql`
    create table place_keeps (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users(id) on delete cascade,
      place_identity_id uuid not null references place_identities(id) on delete cascade,
      from_trip_id uuid references trips(id) on delete set null,
      note text check (note is null or (char_length(note) between 1 and 280)),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (user_id, place_identity_id)
    );
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`drop table place_keeps`.execute(database);
}
