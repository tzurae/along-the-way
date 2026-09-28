import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`create extension if not exists pgcrypto`.execute(database);

  await sql`
    create table users (
      id uuid primary key default gen_random_uuid(),
      email varchar(320) not null unique,
      display_name varchar(120),
      status varchar(20) not null default 'active' check (status = 'active'),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(database);

  await sql`
    create table magic_link_tokens (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users(id) on delete cascade,
      token_hash char(64) not null unique,
      linked_invite_id uuid,
      expires_at timestamptz not null,
      used_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz not null default now()
    )
  `.execute(database);

  await sql`
    create table sessions (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users(id) on delete cascade,
      token_hash char(64) not null unique,
      expires_at timestamptz not null,
      last_seen_at timestamptz not null default now(),
      revoked_at timestamptz,
      created_at timestamptz not null default now()
    )
  `.execute(database);

  await sql`
    create table trips (
      id uuid primary key default gen_random_uuid(),
      name varchar(200) not null,
      start_date date not null,
      end_date date not null,
      time_zone varchar(100) not null,
      currency char(3) not null,
      status varchar(20) not null default 'planning' check (status = 'planning'),
      version integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (end_date >= start_date)
    )
  `.execute(database);

  await sql`
    create table trip_destinations (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null references trips(id) on delete cascade,
      name varchar(160) not null,
      position integer not null check (position >= 0),
      unique (trip_id, position)
    )
  `.execute(database);

  await sql`
    create table trip_days (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null references trips(id) on delete cascade,
      date date not null,
      title varchar(200),
      unique (trip_id, date)
    )
  `.execute(database);

  await sql`
    create table trip_members (
      trip_id uuid not null references trips(id) on delete cascade,
      user_id uuid not null references users(id) on delete cascade,
      role varchar(20) not null check (role in ('owner', 'editor')),
      joined_at timestamptz not null default now(),
      removed_at timestamptz,
      primary key (trip_id, user_id)
    )
  `.execute(database);

  await sql`
    create unique index one_active_owner_per_trip
      on trip_members (trip_id)
      where role = 'owner' and removed_at is null
  `.execute(database);

  await sql`
    create table invites (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null references trips(id) on delete cascade,
      email varchar(320) not null,
      role varchar(20) not null default 'editor' check (role = 'editor'),
      token_hash char(64) not null unique,
      expires_at timestamptz not null,
      accepted_at timestamptz,
      accepted_by uuid references users(id),
      revoked_at timestamptz,
      invited_by uuid not null references users(id),
      created_at timestamptz not null default now()
    )
  `.execute(database);

  await sql`
    alter table magic_link_tokens
      add constraint magic_link_invite
      foreign key (linked_invite_id) references invites(id) on delete set null
  `.execute(database);

  await sql`
    create table mutation_requests (
      actor_id uuid not null references users(id) on delete cascade,
      operation varchar(80) not null,
      idempotency_key varchar(200) not null,
      response jsonb not null,
      created_at timestamptz not null default now(),
      primary key (actor_id, operation, idempotency_key)
    )
  `.execute(database);

  await sql`
    create table email_jobs (
      id uuid primary key default gen_random_uuid(),
      kind varchar(20) not null check (kind in ('magic_link', 'trip_invite')),
      recipient varchar(320) not null,
      magic_link_token_id uuid unique references magic_link_tokens(id) on delete cascade,
      invite_id uuid unique references invites(id) on delete cascade,
      attempt_count integer not null default 0 check (attempt_count >= 0),
      available_at timestamptz not null default now(),
      delivered_at timestamptz,
      created_at timestamptz not null default now(),
      check (
        (kind = 'magic_link' and magic_link_token_id is not null and invite_id is null)
        or
        (kind = 'trip_invite' and magic_link_token_id is null and invite_id is not null)
      )
    )
  `.execute(database);

  await sql`
    create index pending_email_jobs
      on email_jobs (available_at, created_at)
      where delivered_at is null
  `.execute(database);

  await sql`
    create table rate_limit_windows (
      scope varchar(80) not null,
      key_hash char(64) not null,
      window_start timestamptz not null,
      request_count integer not null check (request_count > 0),
      primary key (scope, key_hash, window_start)
    )
  `.execute(database);

  await sql`
    create index rate_limit_window_expiry
      on rate_limit_windows (window_start)
  `.execute(database);

  await sql`
    create table worker_heartbeats (
      worker_name varchar(80) primary key,
      last_seen_at timestamptz not null
    )
  `.execute(database);

  await sql`
    create table change_events (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null references trips(id) on delete cascade,
      actor_id uuid not null references users(id),
      event_type varchar(80) not null,
      target_type varchar(40) not null,
      target_id uuid not null,
      summary varchar(240) not null,
      created_at timestamptz not null default now()
    )
  `.execute(database);

}

export async function down(database: Kysely<unknown>) {
  await database.schema.dropTable("worker_heartbeats").ifExists().execute();
  await database.schema.dropTable("rate_limit_windows").ifExists().execute();
  await database.schema.dropTable("email_jobs").ifExists().execute();
  await sql`
    alter table magic_link_tokens
      drop constraint if exists magic_link_invite
  `.execute(database);
  await database.schema.dropTable("change_events").ifExists().execute();
  await database.schema.dropTable("mutation_requests").ifExists().execute();
  await database.schema.dropTable("invites").ifExists().execute();
  await database.schema.dropTable("trip_members").ifExists().execute();
  await database.schema.dropTable("trip_days").ifExists().execute();
  await database.schema.dropTable("trip_destinations").ifExists().execute();
  await database.schema.dropTable("trips").ifExists().execute();
  await database.schema.dropTable("sessions").ifExists().execute();
  await database.schema.dropTable("magic_link_tokens").ifExists().execute();
  await database.schema.dropTable("users").ifExists().execute();
}
