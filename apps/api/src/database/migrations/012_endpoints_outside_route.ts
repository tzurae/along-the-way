import { sql, type Kysely } from "kysely";

// A flight or transport endpoint may lie outside the trip's country stops, e.g. the home
// airport. Such an endpoint has no stop; the API allows that only for flights and transport.
// The (trip_id, country_stop_id) foreign key still applies whenever a stop is set.
export async function up(database: Kysely<unknown>) {
  await sql`
    alter table itinerary_endpoints alter column country_stop_id drop not null
  `.execute(database);
}

// Fails while any endpoint has no stop; delete or reassign those items before rolling back.
export async function down(database: Kysely<unknown>) {
  await sql`
    alter table itinerary_endpoints alter column country_stop_id set not null
  `.execute(database);
}
