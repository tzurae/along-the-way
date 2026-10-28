import { sql, type Kysely } from "kysely";

// 哪一餐 (f5 §2.1): a member marks a place as this day's breakfast, lunch or dinner, or 'none' so it
// never counts as a meal. Null leaves the meal to the automatic rule. Expand-only: nullable, no
// default, older releases never read this column.
export async function up(database: Kysely<unknown>) {
  await sql`
    alter table trip_places add column meal_role text
      check (meal_role in ('breakfast', 'lunch', 'dinner', 'none'));
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`alter table trip_places drop column meal_role`.execute(database);
}
