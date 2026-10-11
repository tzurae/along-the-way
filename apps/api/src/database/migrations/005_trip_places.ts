import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`
    create table place_identities (
      id uuid primary key default gen_random_uuid(),
      provider varchar(20) not null check (provider in ('google', 'manual')),
      provider_place_id varchar(300),
      canonical_name varchar(200) not null,
      canonical_type varchar(32) not null check (
        canonical_type in ('airport', 'station', 'lodging', 'restaurant', 'activity', 'other')
      ),
      canonical_address text,
      latitude double precision,
      longitude double precision,
      time_zone varchar(100),
      provider_observed_at timestamptz,
      provider_expires_at timestamptz,
      provider_attribution text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      check ((latitude is null) = (longitude is null)),
      check (latitude is null or latitude between -90 and 90),
      check (longitude is null or longitude between -180 and 180),
      check (
        (provider = 'manual' and provider_place_id is null and provider_observed_at is null
          and provider_expires_at is null and provider_attribution is null)
        or
        (provider = 'google' and provider_place_id is not null and provider_observed_at is not null
          and provider_expires_at is not null and provider_attribution is not null)
      )
    )
  `.execute(database);

  await sql`
    create unique index place_identities_provider_identity
      on place_identities (provider, provider_place_id)
      where provider_place_id is not null
  `.execute(database);

  await sql`
    create table trip_places (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null references trips(id) on delete cascade,
      place_id uuid not null references place_identities(id),
      legacy_place_id uuid not null,
      legacy_place_version integer not null check (legacy_place_version > 0),
      facts_source varchar(16) not null check (facts_source in ('provider', 'member')),
      name varchar(200) not null,
      place_type varchar(32) not null check (
        place_type in ('airport', 'station', 'lodging', 'restaurant', 'activity', 'other')
      ),
      address text,
      latitude double precision,
      longitude double precision,
      time_zone varchar(100),
      duration_minutes integer check (duration_minutes is null or duration_minutes > 0),
      budget_amount_minor bigint check (budget_amount_minor is null or budget_amount_minor >= 0),
      budget_currency char(3),
      notes text,
      provider_unavailable boolean not null default false,
      archived_at timestamptz,
      version integer not null default 1 check (version > 0),
      created_by uuid not null references users(id),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (trip_id, id),
      unique (trip_id, place_id),
      unique (trip_id, legacy_place_id),
      foreign key (trip_id, legacy_place_id)
        references places(trip_id, id) on delete cascade,
      check ((latitude is null) = (longitude is null)),
      check (latitude is null or latitude between -90 and 90),
      check (longitude is null or longitude between -180 and 180),
      check ((budget_amount_minor is null) = (budget_currency is null))
    )
  `.execute(database);

  await sql`
    insert into place_identities (
      id, provider, canonical_name, canonical_type, canonical_address,
      latitude, longitude, time_zone, created_at, updated_at
    )
    select id, 'manual', name, place_type, address, latitude, longitude,
      time_zone, created_at, updated_at
    from places
  `.execute(database);

  await sql`
    insert into trip_places (
      id, trip_id, place_id, legacy_place_id, legacy_place_version,
      facts_source, name, place_type, address, latitude, longitude, time_zone,
      notes, version, created_by, created_at, updated_at
    )
    select id, trip_id, id, id, version, 'member', name, place_type, address,
      latitude, longitude, time_zone, notes, version, created_by, created_at,
      updated_at
    from places
  `.execute(database);

  await sql`
    alter table trip_days
      add constraint trip_days_trip_id_id_unique unique (trip_id, id)
  `.execute(database);

  await sql`
    create table trip_place_contributions (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null,
      trip_place_id uuid not null,
      member_user_id uuid not null,
      intake_method varchar(24) not null check (
        intake_method in ('google-maps-url', 'search', 'manual')
      ),
      source_url text,
      original_note text,
      provider_observed_at timestamptz,
      withdrawn_at timestamptz,
      created_at timestamptz not null default now(),
      foreign key (trip_id, trip_place_id)
        references trip_places(trip_id, id) on delete cascade,
      foreign key (trip_id, member_user_id)
        references trip_members(trip_id, user_id) on delete cascade
    )
  `.execute(database);

  await sql`
    insert into trip_place_contributions (
      trip_id, trip_place_id, member_user_id, intake_method, source_url,
      original_note, created_at
    )
    select trip_id, id, created_by, 'manual', source_url, notes, created_at
    from places
  `.execute(database);

  await sql`
    create table legacy_place_origins (
      trip_id uuid not null,
      place_id uuid primary key,
      created_by uuid not null references users(id),
      source_url text,
      original_note text,
      created_at timestamptz not null,
      foreign key (trip_id, place_id)
        references places(trip_id, id) on delete cascade
    )
  `.execute(database);

  await sql`
    insert into legacy_place_origins (
      trip_id, place_id, created_by, source_url, original_note, created_at
    )
    select trip_id, id, created_by, source_url, notes, created_at
    from places
  `.execute(database);

  await sql`
    create function capture_legacy_place_origin()
    returns trigger
    language plpgsql
    as $$
    begin
      insert into legacy_place_origins (
        trip_id, place_id, created_by, source_url, original_note, created_at
      ) values (
        new.trip_id, new.id, new.created_by, new.source_url, new.notes, new.created_at
      )
      on conflict (place_id) do nothing;
      return new;
    end;
    $$
  `.execute(database);

  await sql`
    create trigger places_capture_origin
    after insert on places
    for each row execute function capture_legacy_place_origin()
  `.execute(database);

  await sql`
    create index trip_place_contributions_active
      on trip_place_contributions (trip_id, trip_place_id, created_at)
  `.execute(database);

  await sql`
    create table member_place_preferences (
      trip_id uuid not null,
      trip_place_id uuid not null,
      member_user_id uuid not null,
      preference varchar(16) not null check (
        preference in ('must', 'want', 'optional', 'neutral', 'dislike')
      ),
      version integer not null default 1 check (version > 0),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (trip_place_id, member_user_id),
      foreign key (trip_id, trip_place_id)
        references trip_places(trip_id, id) on delete cascade,
      foreign key (trip_id, member_user_id)
        references trip_members(trip_id, user_id) on delete cascade
    )
  `.execute(database);

  await sql`
    create table trip_place_desired_days (
      trip_id uuid not null,
      trip_place_id uuid not null,
      trip_day_id uuid not null,
      primary key (trip_place_id, trip_day_id),
      foreign key (trip_id, trip_place_id)
        references trip_places(trip_id, id) on delete cascade,
      foreign key (trip_id, trip_day_id)
        references trip_days(trip_id, id) on delete cascade
    )
  `.execute(database);

  await sql`
    create table trip_place_excluded_days (
      trip_id uuid not null,
      trip_place_id uuid not null,
      trip_day_id uuid not null,
      primary key (trip_place_id, trip_day_id),
      foreign key (trip_id, trip_place_id)
        references trip_places(trip_id, id) on delete cascade,
      foreign key (trip_id, trip_day_id)
        references trip_days(trip_id, id) on delete cascade
    )
  `.execute(database);

  await sql`
    create table trip_place_duplicate_suggestions (
      id uuid primary key default gen_random_uuid(),
      trip_id uuid not null references trips(id) on delete cascade,
      first_trip_place_id uuid not null,
      second_trip_place_id uuid not null,
      reason text not null,
      status varchar(20) not null default 'pending' check (
        status in ('pending', 'kept-separate')
      ),
      decided_by uuid references users(id),
      decided_at timestamptz,
      created_at timestamptz not null default now(),
      unique (trip_id, first_trip_place_id, second_trip_place_id),
      foreign key (trip_id, first_trip_place_id)
        references trip_places(trip_id, id) on delete cascade,
      foreign key (trip_id, second_trip_place_id)
        references trip_places(trip_id, id) on delete cascade,
      check (first_trip_place_id < second_trip_place_id),
      check ((decided_by is null) = (decided_at is null))
    )
  `.execute(database);

  await sql`
    create function protect_shared_legacy_place()
    returns trigger
    language plpgsql
    as $$
    begin
      if not exists (
        select 1 from trips where id = old.trip_id
      ) then
        return old;
      end if;
      if exists (
        select 1
        from trip_places as trip_place
        where trip_place.trip_id = old.trip_id
          and trip_place.legacy_place_id = old.id
          and (
            (
              select count(*)
              from trip_place_contributions as contribution
              where contribution.trip_place_id = trip_place.id
                and contribution.withdrawn_at is null
            ) > 1
            or exists (
              select 1
              from trip_place_contributions as contribution
              where contribution.trip_place_id = trip_place.id
                and contribution.withdrawn_at is null
                and contribution.member_user_id <> old.created_by
            )
            or exists (
              select 1
              from member_place_preferences as preference
              join trip_members as member
                on member.trip_id = trip_place.trip_id
                and member.user_id = preference.member_user_id
              where preference.trip_place_id = trip_place.id
                and member.removed_at is null
            )
          )
      ) then
        raise exception 'A shared place cannot be deleted by a retained release'
          using errcode = '23503';
      end if;
      return old;
    end;
    $$
  `.execute(database);

  await sql`
    create trigger places_protect_shared_delete
    before delete on places
    for each row execute function protect_shared_legacy_place()
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`drop trigger places_protect_shared_delete on places`.execute(database);
  await sql`drop function protect_shared_legacy_place`.execute(database);
  await sql`drop trigger places_capture_origin on places`.execute(database);
  await sql`drop function capture_legacy_place_origin`.execute(database);
  await sql`drop table legacy_place_origins`.execute(database);
  await sql`drop table trip_place_duplicate_suggestions`.execute(database);
  await sql`drop table trip_place_excluded_days`.execute(database);
  await sql`drop table trip_place_desired_days`.execute(database);
  await sql`drop table member_place_preferences`.execute(database);
  await sql`drop table trip_place_contributions`.execute(database);
  await sql`drop table trip_places`.execute(database);
  await sql`drop table place_identities`.execute(database);
  await sql`
    alter table trip_days
      drop constraint if exists trip_days_trip_id_id_unique
  `.execute(database);
}
