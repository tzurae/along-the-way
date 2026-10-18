import { sql, type Kysely } from "kysely";

// Expand-only. An inherited override keeps its all-null row as a version tombstone.
export async function up(database: Kysely<unknown>) {
  await sql`
    alter table trip_places add column effort_level smallint check (effort_level between 1 and 5);
    create table trip_planning_settings (
      trip_id uuid primary key references trips(id) on delete cascade,
      pace_preset text not null check (pace_preset in ('chill','balanced','packed','custom')),
      target_places_per_day smallint not null check (target_places_per_day between 0 and 10),
      max_places_per_day smallint not null check (max_places_per_day between 1 and 12),
      day_start varchar(5) not null check (day_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
      day_end varchar(5) not null check (day_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or day_end = '24:00'),
      max_effort_per_day smallint not null check (max_effort_per_day between 1 and 25),
      max_daily_straight_km double precision not null check (max_daily_straight_km between 1 and 100),
      max_hop_straight_km double precision not null check (max_hop_straight_km between 0.5 and 50),
      meal_reserve_minutes smallint not null check (meal_reserve_minutes between 0 and 180),
      rest_minutes smallint not null check (rest_minutes between 0 and 180),
      slack_percent smallint not null check (slack_percent between 0 and 40),
      travel_profile text not null check (travel_profile in ('walk','transit','car','custom')),
      speed_kmh double precision not null check (speed_kmh between 2.5 and 60),
      detour_factor double precision not null check (detour_factor between 1 and 2),
      per_leg_minutes smallint not null check (per_leg_minutes between 0 and 30),
      light_travel_days boolean not null,
      version integer not null default 1 check (version > 0),
      updated_by uuid not null references users(id),
      updated_at timestamptz not null default now(),
      check (target_places_per_day <= max_places_per_day),
      check (day_start < day_end)
    );
    create table trip_day_planning_overrides (
      day_id uuid primary key,
      trip_id uuid not null references trips(id) on delete cascade,
      target_places_per_day smallint check (target_places_per_day between 0 and 10),
      max_places_per_day smallint check (max_places_per_day between 1 and 12),
      day_start varchar(5) check (day_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
      day_end varchar(5) check (day_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or day_end = '24:00'),
      max_effort_per_day smallint check (max_effort_per_day between 1 and 25),
      max_daily_straight_km double precision check (max_daily_straight_km between 1 and 100),
      max_hop_straight_km double precision check (max_hop_straight_km between 0.5 and 50),
      meal_reserve_minutes smallint check (meal_reserve_minutes between 0 and 180),
      rest_minutes smallint check (rest_minutes between 0 and 180),
      slack_percent smallint check (slack_percent between 0 and 40),
      version integer not null default 1 check (version > 0),
      updated_by uuid not null references users(id),
      updated_at timestamptz not null default now(),
      foreign key (trip_id, day_id) references trip_days(trip_id, id) on delete cascade,
      check (target_places_per_day <= max_places_per_day),
      check (day_start < day_end)
    );
    create index trip_day_planning_overrides_trip_idx on trip_day_planning_overrides(trip_id);
    create table whole_trip_plan_proposals (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null references trips(id) on delete cascade,
      created_by uuid not null references users(id),
      input_revision text not null,
      payload jsonb not null,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      check (expires_at > created_at)
    );
    create index whole_trip_plan_proposals_expiry_idx on whole_trip_plan_proposals(expires_at);
    create index whole_trip_plan_proposals_trip_idx on whole_trip_plan_proposals(trip_id, id);
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    drop table whole_trip_plan_proposals;
    drop table trip_day_planning_overrides;
    drop table trip_planning_settings;
    alter table trip_places drop column effort_level;
  `.execute(database);
}
