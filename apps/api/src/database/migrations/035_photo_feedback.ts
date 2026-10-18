import { sql, type Kysely } from "kysely";

// Expand-only: general feedback rows continue to satisfy the original nullable photo fields.
export async function up(database: Kysely<unknown>) {
  await sql`
    alter table feedback
      drop constraint feedback_type_check,
      add constraint feedback_type_check
        check (type in ('bug', 'idea', 'other', 'photo')),
      add column trip_place_id uuid references trip_places(id) on delete set null,
      add column place_name text,
      add column photo_wikidata_id varchar(20)
        check (photo_wikidata_id is null or photo_wikidata_id ~ '^Q[1-9][0-9]*$'),
      add column photo_reason varchar(20)
        check (photo_reason is null or photo_reason in ('wrong_place', 'poor_quality', 'other')),
      add constraint feedback_photo_fields_check check (
        type <> 'photo' or (photo_reason is not null and place_name is not null)
      )
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    alter table feedback
      drop constraint feedback_photo_fields_check,
      drop column photo_reason,
      drop column place_name,
      drop column photo_wikidata_id,
      drop column trip_place_id,
      drop constraint feedback_type_check,
      add constraint feedback_type_check
        check (type in ('bug', 'idea', 'other'))
  `.execute(database);
}
