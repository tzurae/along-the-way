import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`
    do $$
    declare decision_check text;
    begin
      select conname into strict decision_check from pg_constraint
      where conrelid = 'candidate_proposals'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) like '%decided_by%';
      execute format('alter table candidate_proposals drop constraint %I', decision_check);
      execute format('alter table candidate_proposals add constraint %I check (
        (status in (''pending'', ''accepting'') and decided_by is null and decided_at is null and accepted_trip_place_id is null)
        or (status = ''rejected'' and decided_by is not null and decided_at is not null and accepted_trip_place_id is null)
        or (status = ''accepted'' and decided_by is not null and decided_at is not null)
      )', decision_check);
    end;
    $$
  `.execute(database);
  await sql`drop trigger places_protect_shared_delete on places`.execute(database);
  await sql`drop function protect_shared_legacy_place`.execute(database);
  // Expand step: clear the retired five-level choices but keep the table, so a rolled-back
  // previous release still finds it (docs/engineering/database-migrations.md). Drop it in a
  // later contract migration once no retained release reads it.
  await sql`delete from member_place_preferences`.execute(database);
  await sql`
    alter table candidate_proposals
      add constraint candidate_proposals_trip_id_id_unique unique (trip_id, id)
  `.execute(database);
  await sql`
    create table trip_place_votes (
      trip_id uuid not null,
      trip_place_id uuid not null,
      member_user_id uuid not null,
      created_at timestamptz not null default now(),
      primary key (trip_place_id, member_user_id),
      foreign key (trip_id, trip_place_id)
        references trip_places(trip_id, id) on delete cascade,
      foreign key (trip_id, member_user_id)
        references trip_members(trip_id, user_id) on delete cascade
    )
  `.execute(database);
  await sql`
    create table discovery_proposal_votes (
      trip_id uuid not null,
      proposal_id uuid not null,
      member_user_id uuid not null,
      created_at timestamptz not null default now(),
      primary key (proposal_id, member_user_id),
      foreign key (trip_id, proposal_id)
        references candidate_proposals(trip_id, id) on delete cascade,
      foreign key (trip_id, member_user_id)
        references trip_members(trip_id, user_id) on delete cascade
    )
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    do $$
    declare decision_check text;
    begin
      if exists (select 1 from candidate_proposals where status = 'accepted' and accepted_trip_place_id is null) then
        raise exception 'Cannot downgrade member votes while accepted proposals have deleted wishlist places';
      end if;
      select conname into strict decision_check from pg_constraint
      where conrelid = 'candidate_proposals'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) like '%decided_by%';
      execute format('alter table candidate_proposals drop constraint %I', decision_check);
      execute format('alter table candidate_proposals add constraint %I check (
        (status in (''pending'', ''accepting'') and decided_by is null and decided_at is null and accepted_trip_place_id is null)
        or (status = ''rejected'' and decided_by is not null and decided_at is not null and accepted_trip_place_id is null)
        or (status = ''accepted'' and decided_by is not null and decided_at is not null and accepted_trip_place_id is not null)
      )', decision_check);
    end;
    $$
  `.execute(database);
  await sql`drop table discovery_proposal_votes`.execute(database);
  await sql`drop table trip_place_votes`.execute(database);
  await sql`
    alter table candidate_proposals
      drop constraint candidate_proposals_trip_id_id_unique
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
