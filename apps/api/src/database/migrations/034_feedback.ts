import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`
    create table feedback (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users(id),
      trip_id uuid references trips(id) on delete set null,
      type varchar(20) not null check (type in ('bug', 'idea', 'other')),
      body text not null check (char_length(body) between 10 and 2000),
      page varchar(200),
      contact_allowed boolean not null,
      app_version varchar(500) not null,
      user_agent varchar(500),
      viewport varchar(20),
      status varchar(20) not null default 'new'
        check (status in ('new', 'in_progress', 'done', 'wont_do')),
      admin_note text check (admin_note is null or char_length(admin_note) <= 2000),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(database);

  await sql`
    create index feedback_status_created_at
      on feedback (status, created_at desc)
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`drop table feedback`.execute(database);
}
