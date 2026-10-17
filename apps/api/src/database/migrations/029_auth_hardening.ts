import { sql, type Kysely } from "kysely";

export async function up<Database>(database: Kysely<Database>) {
  await sql`alter table users drop constraint users_status_check`.execute(database);
  await sql`alter table users add constraint users_status_check check (status in ('active', 'invited', 'disabled'))`.execute(database);
  await sql`
    alter table magic_link_tokens
      add column login_nonce_hash char(64),
      add column code_hash char(64),
      add column code_attempts integer not null default 0 check (code_attempts between 0 and 5)
  `.execute(database);
  await sql`create index magic_link_browser_lookup on magic_link_tokens (user_id, login_nonce_hash, created_at desc) where used_at is null and revoked_at is null`.execute(database);
}

export async function down<Database>(database: Kysely<Database>) {
  // Preserve account eligibility on downgrade: deleting invitees strands invitations,
  // while converting invited or disabled accounts to active would grant access.
  await sql`drop index magic_link_browser_lookup`.execute(database);
  await sql`alter table magic_link_tokens drop column login_nonce_hash, drop column code_hash, drop column code_attempts`.execute(database);
}
