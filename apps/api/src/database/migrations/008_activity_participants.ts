import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`
    alter table trip_members
      add column id uuid not null default gen_random_uuid(),
      add constraint trip_members_id_unique unique (id),
      add constraint trip_members_trip_id_id_unique unique (trip_id, id)
  `.execute(database);

  await sql`
    create table itinerary_item_participants (
      trip_id uuid not null,
      itinerary_item_id uuid not null,
      member_id uuid not null,
      primary key (itinerary_item_id, member_id),
      foreign key (trip_id, itinerary_item_id)
        references itinerary_items(trip_id, id) on delete cascade,
      foreign key (trip_id, member_id)
        references trip_members(trip_id, id)
        on delete no action deferrable initially deferred
    )
  `.execute(database);
  await sql`
    create index itinerary_item_participants_member
      on itinerary_item_participants (trip_id, member_id)
  `.execute(database);

  // Cached replies remain historical snapshots. Legacy binaries also insert
  // replies after this migration, so normalize at insertion rather than replay.
  await sql`
    create function normalize_activity_participant_mutation_response(
      mutation_operation text,
      mutation_response jsonb
    ) returns jsonb language plpgsql as $$
    declare
      normalized_members jsonb;
      normalized_participants jsonb;
    begin
      if mutation_operation = 'create_trip' then
        if jsonb_typeof(mutation_response -> 'members') is distinct from 'array' then
          raise exception 'Activity participant mutation response cannot resolve historical trip memberships';
        end if;
        if exists (
          select 1 from jsonb_array_elements(mutation_response -> 'members') member
          where not (member.value ? 'id')
        ) then
          if exists (
            select 1
            from jsonb_array_elements(mutation_response -> 'members') member
            left join trip_members membership
              on membership.trip_id::text = mutation_response ->> 'id'
              and membership.user_id::text = member.value ->> 'userId'
            where not (member.value ? 'id') and membership.id is null
          ) then
            raise exception 'Activity participant mutation response cannot resolve historical trip memberships';
          end if;
          select coalesce(jsonb_agg(
            case when member.value ? 'id' then member.value
              else jsonb_set(member.value, '{id}', to_jsonb(membership.id))
            end order by member.position
          ), '[]'::jsonb)
          into normalized_members
          from jsonb_array_elements(mutation_response -> 'members')
            with ordinality as member(value, position)
          left join trip_members membership
            on membership.trip_id::text = mutation_response ->> 'id'
            and membership.user_id::text = member.value ->> 'userId';
          return jsonb_set(mutation_response, '{members}', normalized_members);
        end if;
      elsif mutation_operation ~ '^(create_itinerary_item|iu|cc|cu|cd|il|in):'
        and not (mutation_response ? 'participants') then
        select jsonb_agg(jsonb_build_object(
          'memberId', membership.id,
          'displayName', traveler.display_name,
          'email', traveler.email,
          'removed', membership.removed_at is not null
        ) order by membership.id)
        into normalized_participants
        from itinerary_item_participants participant
        join trip_members membership
          on membership.trip_id = participant.trip_id
          and membership.id = participant.member_id
        join users traveler on traveler.id = membership.user_id
        where participant.trip_id::text = mutation_response ->> 'tripId'
          and participant.itinerary_item_id::text = mutation_response ->> 'id';
        return mutation_response || jsonb_build_object('participants', normalized_participants);
      end if;
      return mutation_response;
    end;
    $$
  `.execute(database);
  await sql`
    create function normalize_activity_participant_mutation_request()
    returns trigger language plpgsql as $$
    begin
      new.response := normalize_activity_participant_mutation_response(new.operation, new.response);
      return new;
    end;
    $$
  `.execute(database);
  await sql`
    create trigger mutation_requests_normalize_activity_participants
      before insert on mutation_requests
      for each row execute function normalize_activity_participant_mutation_request()
  `.execute(database);

  // Before 008 no item had an explicit participant relation, so backfill yields
  // null; later legacy writes capture the actual associations at insert time.
  await sql`
    update mutation_requests
    set response = normalize_activity_participant_mutation_response(operation, response)
    where operation = 'create_trip'
      or (operation ~ '^(create_itinerary_item|iu|cc|cu|cd|il|in):'
        and not (response ? 'participants'))
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`drop trigger mutation_requests_normalize_activity_participants on mutation_requests`.execute(database);
  await sql`drop function normalize_activity_participant_mutation_request()`.execute(database);
  await sql`drop function normalize_activity_participant_mutation_response(text, jsonb)`.execute(database);
  await sql`drop table itinerary_item_participants`.execute(database);
  await sql`
    alter table trip_members
      drop constraint trip_members_trip_id_id_unique,
      drop constraint trip_members_id_unique,
      drop column id
  `.execute(database);
}
