import { sql, type Kysely } from "kysely";

// Expand-only: a previous release ignores both tables, so a migration-free rollback stays safe.
export async function up(database: Kysely<unknown>) {
  await sql`
    create table place_photo_blobs (
      filename varchar(70) primary key check (filename ~ '^[a-f0-9]{64}[.](jpg|png|webp)$'),
      media_type varchar(20) not null check (media_type in ('image/jpeg', 'image/png', 'image/webp')),
      bytes bytea not null check (octet_length(bytes) between 1 and 5242880),
      created_at timestamptz not null default now()
    );
    create table commons_place_photos (
      place_id uuid primary key references place_identities(id) on delete cascade,
      wikidata_id varchar(20) not null check (wikidata_id ~ '^Q[1-9][0-9]*$'),
      metadata jsonb not null check (jsonb_typeof(metadata) = 'object'),
      image_filename varchar(70) not null references place_photo_blobs(filename),
      thumbnail_filename varchar(70) not null references place_photo_blobs(filename),
      checked_at timestamptz not null
    );
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    drop table commons_place_photos;
    drop table place_photo_blobs;
  `.execute(database);
}
