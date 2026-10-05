import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`alter table places add column travel_only boolean not null default false`.execute(database);
  await sql`
    update places as place set travel_only = true
    where exists (
      select 1 from itinerary_endpoints as endpoint
      join itinerary_items as item on item.id = endpoint.itinerary_item_id and item.trip_id = endpoint.trip_id
      where endpoint.place_id = place.id and endpoint.trip_id = place.trip_id
        and item.item_type in ('flight', 'lodging')
    ) and not exists (
      select 1 from itinerary_endpoints as endpoint
      join itinerary_items as item on item.id = endpoint.itinerary_item_id and item.trip_id = endpoint.trip_id
      where endpoint.place_id = place.id and endpoint.trip_id = place.trip_id
        and item.item_type not in ('flight', 'lodging')
    )
  `.execute(database);
  // Remove the legacy sources first: migration 007 derives day assignments from them.
  for (const table of ["trip_place_desired_days", "trip_place_excluded_days", "trip_place_day_assignments", "trip_place_votes"] as const) {
    await sql`
      delete from ${sql.table(table)} as related using trip_places as wishlist, places as place
      where related.trip_place_id = wishlist.id
        and wishlist.legacy_place_id = place.id and wishlist.trip_id = place.trip_id
        and place.travel_only
    `.execute(database);
  }
  await sql`
    update trip_places as wishlist
    set archived_at = now(), version = wishlist.version + 1, updated_at = now()
    from places as place
    where wishlist.legacy_place_id = place.id and wishlist.trip_id = place.trip_id
      and place.travel_only
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  // Archival and cleared planning/voting data are intentionally not reversed.
  await sql`alter table places drop column travel_only`.execute(database);
}
