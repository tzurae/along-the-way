import { sql, type Kysely } from "kysely";

const TABLES = [
  ["places", "place_type", "places_place_type_check"],
  ["place_identities", "canonical_type", "place_identities_canonical_type_check"],
  ["trip_places", "place_type", "trip_places_place_type_check"],
  ["candidate_proposals", "place_type", "candidate_proposals_place_type_check"],
] as const;

const NEW_TYPES = "'activity','worship','museum','nature','restaurant','cafe','shopping','lodging','station','airport','other'";
const OLD_TYPES = "'airport','station','lodging','restaurant','activity','other'";

// Expand-only: the six old values stay valid, so existing rows need no rewrite. Rolling back is
// safe only while no row uses a new value (down() fails loudly otherwise).
export async function up(database: Kysely<unknown>) {
  for (const [table, column, constraint] of TABLES) {
    await sql.raw(`alter table ${table} drop constraint ${constraint}`).execute(database);
    await sql.raw(`alter table ${table} add constraint ${constraint} check (${column} in (${NEW_TYPES}))`).execute(database);
  }
}

export async function down(database: Kysely<unknown>) {
  for (const [table, column, constraint] of TABLES) {
    await sql.raw(`alter table ${table} drop constraint ${constraint}`).execute(database);
    await sql.raw(`alter table ${table} add constraint ${constraint} check (${column} in (${OLD_TYPES}))`).execute(database);
  }
}
