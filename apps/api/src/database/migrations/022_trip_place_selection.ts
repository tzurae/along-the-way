import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`
    alter table trip_places
      add column selected_for_itinerary boolean not null default false,
      add column unplaced_from_date date,
      add constraint trip_places_unplaced_requires_selection
        check (unplaced_from_date is null or selected_for_itinerary)
  `.execute(database);

  // This is a tracking cutover, not reconstructed history. Only a placement that
  // still exists proves selection; neither votes nor intake prove prior intent.
  await sql`
    update trip_places as place
    set selected_for_itinerary = true
    where exists (
      select 1 from trip_place_day_assignments as assignment
      where assignment.trip_id = place.trip_id and assignment.trip_place_id = place.id
    ) or exists (
      select 1 from itinerary_endpoints as endpoint
      where endpoint.trip_id = place.trip_id and endpoint.place_id = place.legacy_place_id
    )
  `.execute(database);

  // Like 008, preserve cached replies as historical snapshots and normalize new
  // inserts from retained binaries. Never look up today's placement to rewrite
  // an old reply, and never manufacture a lost removal date.
  await sql`
    create function normalize_trip_place_selection_mutation_response(
      mutation_operation text,
      mutation_response jsonb
    ) returns jsonb language plpgsql as $$
    declare
      normalized_places jsonb;
    begin
      if mutation_operation !~ '^tp:' then
        return mutation_response;
      end if;
      if jsonb_typeof(mutation_response -> 'tripPlaces') = 'array' then
        select coalesce(jsonb_agg(
          normalize_trip_place_selection_mutation_response(mutation_operation, place.value)
          order by place.position
        ), '[]'::jsonb)
        into normalized_places
        from jsonb_array_elements(mutation_response -> 'tripPlaces')
          with ordinality as place(value, position);
        return jsonb_set(mutation_response, '{tripPlaces}', normalized_places);
      elsif mutation_response ? 'id' and mutation_response ? 'placeId'
        and mutation_response ? 'scheduled' then
        return jsonb_build_object(
          'selectedForItinerary',
            coalesce(mutation_response -> 'scheduled' = 'true'::jsonb, false)
            or coalesce(jsonb_typeof(mutation_response -> 'assignedDayId') = 'string', false),
          'unplacedFromDate', null
        ) || mutation_response;
      end if;
      return mutation_response;
    end;
    $$
  `.execute(database);
  await sql`
    create function normalize_trip_place_selection_mutation_request()
    returns trigger language plpgsql as $$
    begin
      new.response := normalize_trip_place_selection_mutation_response(new.operation, new.response);
      return new;
    end;
    $$
  `.execute(database);
  await sql`
    create trigger mutation_requests_normalize_trip_place_selection
      before insert on mutation_requests
      for each row execute function normalize_trip_place_selection_mutation_request()
  `.execute(database);
  await sql`
    update mutation_requests
    set response = normalize_trip_place_selection_mutation_response(operation, response)
    where operation ~ '^tp:'
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`drop trigger mutation_requests_normalize_trip_place_selection on mutation_requests`.execute(database);
  await sql`drop function normalize_trip_place_selection_mutation_request()`.execute(database);
  await sql`drop function normalize_trip_place_selection_mutation_response(text, jsonb)`.execute(database);
  await sql`
    alter table trip_places
      drop constraint trip_places_unplaced_requires_selection,
      drop column unplaced_from_date,
      drop column selected_for_itinerary
  `.execute(database);
}
