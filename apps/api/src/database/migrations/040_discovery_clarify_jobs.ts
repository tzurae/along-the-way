import { sql, type Kysely } from "kysely";

// 幫我找 調查 (owner decision 2026-10-19): a ≤5-question checklist that an AI reviewer must accept
// before research, and research as a background job whose stages the client can follow.
// Expand-only: older releases never read these tables.
export async function up(database: Kysely<unknown>) {
  await sql`
    create table discovery_clarifications (
      trip_id uuid not null references trips(id) on delete cascade,
      brief_version integer not null check (brief_version > 0),
      status varchar(16) not null check (status in ('asking', 'ready')),
      items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 5),
      rounds integer not null default 0 check (rounds >= 0),
      model_id varchar(128),
      version integer not null default 1 check (version > 0),
      updated_by uuid not null references users(id),
      updated_at timestamptz not null default now(),
      primary key (trip_id, brief_version)
    );

    create table discovery_jobs (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null references trips(id) on delete cascade,
      brief_version integer not null check (brief_version > 0),
      created_by uuid not null references users(id),
      -- Only kept while the job may still call paid providers (their per-IP budget); cleared at the end.
      client_ip varchar(64),
      status varchar(12) not null check (status in ('queued', 'running', 'succeeded', 'failed')),
      stage varchar(12) check (stage in ('plan', 'research', 'verify', 'save', 'photos')),
      stages jsonb not null default '{}'::jsonb check (jsonb_typeof(stages) = 'object'),
      error_code varchar(40),
      run_id uuid references discovery_runs(id) on delete set null,
      added_count integer check (added_count is null or added_count >= 0),
      heartbeat_at timestamptz,
      created_at timestamptz not null default now(),
      finished_at timestamptz,
      acknowledged_at timestamptz,
      check ((status in ('succeeded', 'failed')) = (finished_at is not null))
    );

    create unique index discovery_jobs_one_active on discovery_jobs (trip_id)
      where status in ('queued', 'running');
    create index discovery_jobs_queued on discovery_jobs (created_at)
      where status = 'queued';
    create index discovery_jobs_trip_recent on discovery_jobs (trip_id, created_at desc);
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    drop table discovery_jobs;
    drop table discovery_clarifications;
  `.execute(database);
}
