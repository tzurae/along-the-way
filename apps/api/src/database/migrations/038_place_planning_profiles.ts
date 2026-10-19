import { sql, type Kysely } from "kysely";

// Expand-only: older releases ignore queued and generated planning profiles.
export async function up(database: Kysely<unknown>) {
  await sql`
    create function place_planning_profile_sources_valid(value jsonb)
    returns boolean
    language sql
    immutable
    parallel safe
    return case
      when jsonb_typeof(value) <> 'array' then false
      when jsonb_array_length(value) > 6 then false
      else not exists (
        select 1
        from jsonb_array_elements(value) source
        where jsonb_typeof(source) <> 'object'
          or not source ? 'title'
          or not source ? 'url'
          or source - 'title' - 'url' <> '{}'::jsonb
          or jsonb_typeof(source->'title') <> 'string'
          or length(trim(source->>'title')) = 0
          or length(source->>'title') > 500
          or jsonb_typeof(source->'url') <> 'string'
          or source->>'url' !~* '^https://([a-z0-9-]+\\.)+(wikipedia|wikivoyage)\\.org/'
      )
    end;

    create function place_planning_profile_evidence_indexes_valid(value jsonb)
    returns boolean
    language sql
    immutable
    parallel safe
    return case
      when jsonb_typeof(value) <> 'array' then false
      when jsonb_array_length(value) > 6 then false
      else not exists (
        select 1
        from jsonb_array_elements(value) item
        where jsonb_typeof(item) <> 'number'
          or (item #>> '{}') !~ '^[0-9]+$'
          or (item #>> '{}')::integer > 5
      )
      and jsonb_array_length(value) = (
        select count(distinct item #>> '{}')
        from jsonb_array_elements(value) item
      )
    end;

    create table place_planning_profiles (
      place_id uuid primary key references place_identities(id) on delete cascade,
      requested_trip_id uuid references trips(id) on delete set null,
      canonical_name text,
      place_type varchar(30)
        check (place_type is null or place_type in (
          'activity', 'worship', 'museum', 'nature', 'restaurant', 'cafe',
          'shopping', 'lodging', 'station', 'airport', 'other'
        )),
      language varchar(35) not null default 'zh-TW'
        check (length(trim(language)) > 0),
      visit_minutes smallint
        check (visit_minutes is null or (visit_minutes between 15 and 480 and visit_minutes % 15 = 0)),
      effort_level smallint
        check (effort_level is null or effort_level between 1 and 5),
      confidence varchar(10)
        check (confidence is null or confidence in ('low', 'medium', 'high')),
      rationale_zh_tw varchar(120),
      evidence_indexes jsonb not null default '[]'::jsonb
        check (place_planning_profile_evidence_indexes_valid(evidence_indexes)),
      sources jsonb not null default '[]'::jsonb
        check (place_planning_profile_sources_valid(sources)),
      model text,
      prompt_version varchar(80),
      policy_version varchar(80),
      evidence_hash char(64),
      input_hash char(64),
      status varchar(20) not null default 'pending'
        check (status in ('pending', 'generating', 'ready', 'no_evidence', 'failed')),
      claim_token uuid,
      claimed_at timestamptz,
      attempts integer not null default 0 check (attempts >= 0),
      next_attempt_at timestamptz not null default now(),
      generated_at timestamptz,
      evidence_checked_at timestamptz,
      updated_at timestamptz not null default now(),
      check (
        (status = 'generating' and claim_token is not null and claimed_at is not null)
        or (status <> 'generating' and claim_token is null and claimed_at is null)
      ),
      check (
        status <> 'ready'
        or (
          canonical_name is not null
          and place_type is not null
          and confidence is not null
          and rationale_zh_tw is not null
          and jsonb_array_length(sources) > 0
          and (
            (
              visit_minutes is null
              and effort_level is null
              and jsonb_array_length(evidence_indexes) = 0
            )
            or (
              (visit_minutes is not null or effort_level is not null)
              and jsonb_array_length(evidence_indexes) > 0
            )
          )
          and model is not null
          and prompt_version is not null
          and policy_version is not null
          and evidence_hash is not null
          and input_hash is not null
          and generated_at is not null
          and evidence_checked_at is not null
        )
      ),
      check (
        status <> 'no_evidence'
        or (
          canonical_name is not null
          and place_type is not null
          and visit_minutes is null
          and effort_level is null
          and confidence is null
          and rationale_zh_tw is null
          and jsonb_array_length(evidence_indexes) = 0
          and jsonb_array_length(sources) = 0
          and model is not null
          and prompt_version is not null
          and policy_version is not null
          and evidence_hash is not null
          and input_hash is not null
          and generated_at is not null
          and evidence_checked_at is not null
        )
      )
    );

    create index pending_place_planning_profiles
      on place_planning_profiles (next_attempt_at, updated_at, place_id)
      where status in ('pending', 'generating', 'failed');

    insert into place_planning_profiles (
      place_id,
      requested_trip_id,
      canonical_name,
      place_type,
      status
    )
    select distinct on (identity.id)
      identity.id,
      trip_place.trip_id,
      identity.canonical_name,
      identity.canonical_type,
      'pending'
    from trip_places trip_place
    inner join place_identities identity on identity.id = trip_place.place_id
    where trip_place.selected_for_itinerary
      and trip_place.archived_at is null
      and trip_place.place_type not in ('lodging', 'airport')
    order by identity.id, trip_place.trip_id;

    create function enqueue_place_planning_profile_on_selection()
    returns trigger
    language plpgsql
    as $$
    begin
      if new.selected_for_itinerary
        and new.archived_at is null
        and new.place_type not in ('lodging', 'airport')
        and (tg_op = 'INSERT' or not old.selected_for_itinerary or old.archived_at is not null)
      then
        insert into place_planning_profiles (
          place_id,
          requested_trip_id,
          canonical_name,
          place_type,
          status,
          next_attempt_at,
          updated_at
        )
        select
          identity.id,
          new.trip_id,
          identity.canonical_name,
          identity.canonical_type,
          'pending',
          now(),
          now()
        from place_identities identity
        where identity.id = new.place_id
        on conflict (place_id) do update
        set requested_trip_id = coalesce(place_planning_profiles.requested_trip_id, excluded.requested_trip_id),
            canonical_name = excluded.canonical_name,
            place_type = excluded.place_type,
            status = case
              when place_planning_profiles.canonical_name = excluded.canonical_name
                and place_planning_profiles.place_type = excluded.place_type
              then place_planning_profiles.status
              else 'pending'
            end,
            claim_token = case
              when place_planning_profiles.status = 'generating'
                and place_planning_profiles.canonical_name = excluded.canonical_name
                and place_planning_profiles.place_type = excluded.place_type
              then place_planning_profiles.claim_token
              else null
            end,
            claimed_at = case
              when place_planning_profiles.status = 'generating'
                and place_planning_profiles.canonical_name = excluded.canonical_name
                and place_planning_profiles.place_type = excluded.place_type
              then place_planning_profiles.claimed_at
              else null
            end,
            attempts = case
              when place_planning_profiles.canonical_name = excluded.canonical_name
                and place_planning_profiles.place_type = excluded.place_type
              then place_planning_profiles.attempts
              else 0
            end,
            next_attempt_at = case
              when place_planning_profiles.canonical_name = excluded.canonical_name
                and place_planning_profiles.place_type = excluded.place_type
              then place_planning_profiles.next_attempt_at
              else now()
            end,
            updated_at = now();
      end if;
      return new;
    end;
    $$;

    create trigger trip_place_planning_profile_enqueue
      after insert or update of selected_for_itinerary, archived_at on trip_places
      for each row execute function enqueue_place_planning_profile_on_selection();

    create function invalidate_place_planning_profile_on_identity_change()
    returns trigger
    language plpgsql
    as $$
    declare
      requesting_trip_id uuid;
    begin
      if new.canonical_name is not distinct from old.canonical_name
        and new.canonical_type is not distinct from old.canonical_type
      then
        return new;
      end if;

      select trip_place.trip_id
      into requesting_trip_id
      from trip_places trip_place
      where trip_place.place_id = new.id
        and trip_place.selected_for_itinerary
        and trip_place.archived_at is null
        and trip_place.place_type not in ('lodging', 'airport')
      order by trip_place.trip_id
      limit 1;

      if requesting_trip_id is not null then
        insert into place_planning_profiles (
          place_id,
          requested_trip_id,
          canonical_name,
          place_type,
          status,
          next_attempt_at,
          updated_at
        ) values (
          new.id,
          requesting_trip_id,
          new.canonical_name,
          new.canonical_type,
          'pending',
          now(),
          now()
        )
        on conflict (place_id) do update
        set requested_trip_id = coalesce(place_planning_profiles.requested_trip_id, excluded.requested_trip_id),
            canonical_name = excluded.canonical_name,
            place_type = excluded.place_type,
            status = 'pending',
            claim_token = null,
            claimed_at = null,
            next_attempt_at = now(),
            attempts = 0,
            updated_at = now();
      end if;
      return new;
    end;
    $$;

    create trigger place_identity_planning_profile_invalidation
      after update of canonical_name, canonical_type on place_identities
      for each row execute function invalidate_place_planning_profile_on_identity_change();
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    drop trigger place_identity_planning_profile_invalidation on place_identities;
    drop function invalidate_place_planning_profile_on_identity_change();
    drop trigger trip_place_planning_profile_enqueue on trip_places;
    drop function enqueue_place_planning_profile_on_selection();
    drop table place_planning_profiles;
    drop function place_planning_profile_evidence_indexes_valid(jsonb);
    drop function place_planning_profile_sources_valid(jsonb);
  `.execute(database);
}
