import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`
    create table curated_place_details (
      place_id uuid primary key references place_identities(id) on delete cascade,
      manifest_key varchar(160) not null unique,
      name varchar(200) not null,
      sections jsonb not null check (jsonb_typeof(sections) = 'array'),
      sources jsonb not null check (jsonb_typeof(sources) = 'array')
    );
    create table curated_place_photos (
      place_id uuid not null references curated_place_details(place_id) on delete cascade,
      work_id varchar(160) not null,
      position integer not null check (position between 0 and 29),
      metadata jsonb not null check (jsonb_typeof(metadata) = 'object'),
      image_filename varchar(70) not null check (image_filename ~ '^[a-f0-9]{64}[.](jpg|png|webp)$'),
      thumbnail_filename varchar(70) not null check (thumbnail_filename ~ '^[a-f0-9]{64}[.](jpg|png|webp)$'),
      primary key (place_id, work_id),
      unique (place_id, position)
    );
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    drop table curated_place_photos;
    drop table curated_place_details;
  `.execute(database);
}
