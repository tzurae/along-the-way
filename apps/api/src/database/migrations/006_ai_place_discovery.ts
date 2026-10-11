import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`
    create table discovery_briefs (
      trip_id uuid primary key references trips(id) on delete cascade,
      original_text text not null check (char_length(original_text) between 1 and 5000),
      structured_brief jsonb,
      unresolved_questions jsonb not null default '[]'::jsonb,
      version integer not null default 1 check (version > 0),
      updated_by uuid not null references users(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `.execute(database);

  await sql`
    create table discovery_runs (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null references trips(id) on delete cascade,
      brief_version integer not null check (brief_version > 0),
      policy_version varchar(64) not null,
      model_id varchar(128) not null,
      status varchar(16) not null check (status in ('completed', 'failed')),
      search_plan jsonb not null,
      error_code varchar(64),
      created_by uuid not null references users(id),
      created_at timestamptz not null default now(),
      completed_at timestamptz not null default now()
    )
  `.execute(database);

  await sql`
    create index discovery_runs_trip_created
      on discovery_runs (trip_id, created_at desc, id desc)
  `.execute(database);

  await sql`
    create table discovery_evidence (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null references trips(id) on delete cascade,
      run_id uuid not null references discovery_runs(id) on delete cascade,
      evidence_kind varchar(24) not null check (evidence_kind in ('google-place', 'web-source')),
      provider_place_id varchar(300),
      source_url text not null,
      title text not null,
      attribution text not null,
      observed_at timestamptz not null,
      expires_at timestamptz,
      facts jsonb not null,
      unique (run_id, evidence_kind, source_url)
    )
  `.execute(database);

  await sql`
    create table candidate_proposals (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null references trips(id) on delete cascade,
      run_id uuid not null references discovery_runs(id) on delete cascade,
      provider_place_id varchar(300) not null,
      name varchar(200) not null,
      place_type varchar(32) not null check (
        place_type in ('airport', 'station', 'lodging', 'restaurant', 'activity', 'other')
      ),
      address text,
      latitude double precision,
      longitude double precision,
      source_url text,
      recommendation text not null,
      matched_needs jsonb not null,
      tradeoffs jsonb not null,
      unknowns jsonb not null,
      confidence varchar(16) not null check (confidence in ('high', 'medium', 'low')),
      status varchar(16) not null default 'pending' check (
        status in ('pending', 'accepting', 'accepted', 'rejected')
      ),
      accepted_trip_place_id uuid,
      decided_by uuid references users(id),
      decided_at timestamptz,
      version integer not null default 1 check (version > 0),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (run_id, provider_place_id),
      foreign key (trip_id, accepted_trip_place_id)
        references trip_places(trip_id, id),
      check ((latitude is null) = (longitude is null)),
      check (latitude is null or latitude between -90 and 90),
      check (longitude is null or longitude between -180 and 180),
      check (
        (status in ('pending', 'accepting') and decided_by is null and decided_at is null and accepted_trip_place_id is null)
        or (status = 'rejected' and decided_by is not null and decided_at is not null and accepted_trip_place_id is null)
        or (status = 'accepted' and decided_by is not null and decided_at is not null and accepted_trip_place_id is not null)
      )
    )
  `.execute(database);

  await sql`
    create index candidate_proposals_trip_status
      on candidate_proposals (trip_id, status, created_at desc)
  `.execute(database);

  await sql`
    create table candidate_proposal_evidence (
      proposal_id uuid not null references candidate_proposals(id) on delete cascade,
      evidence_id uuid not null references discovery_evidence(id) on delete cascade,
      primary key (proposal_id, evidence_id)
    )
  `.execute(database);

  await sql`
    create table discovery_feedback (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null references trips(id) on delete cascade,
      proposal_id uuid references candidate_proposals(id) on delete cascade,
      actor_id uuid not null references users(id),
      original_text text not null check (char_length(original_text) between 1 and 2000),
      interpretation jsonb not null,
      status varchar(16) not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
      version integer not null default 1 check (version > 0),
      decided_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check (
        (status = 'pending' and decided_at is null)
        or (status in ('confirmed', 'rejected') and decided_at is not null)
      )
    )
  `.execute(database);

  await sql`
    create index discovery_feedback_trip_created
      on discovery_feedback (trip_id, created_at desc, id desc)
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`drop table discovery_feedback`.execute(database);
  await sql`drop table candidate_proposal_evidence`.execute(database);
  await sql`drop table candidate_proposals`.execute(database);
  await sql`drop table discovery_evidence`.execute(database);
  await sql`drop table discovery_runs`.execute(database);
  await sql`drop table discovery_briefs`.execute(database);
}
