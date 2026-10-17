import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`
    create table user_rapidapi_keys (
      user_id uuid primary key references users(id) on delete cascade,
      ciphertext bytea not null,
      nonce bytea not null,
      encryption_key_version smallint not null,
      updated_at timestamptz not null default now()
    )
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`drop table user_rapidapi_keys`.execute(database);
}
