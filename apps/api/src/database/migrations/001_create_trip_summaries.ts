import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`create extension if not exists postgis`.execute(database);

  await database.schema
    .createTable("trip_summaries")
    .ifNotExists()
    .addColumn("id", "uuid", (column) => column.primaryKey())
    .addColumn("slug", "varchar(120)", (column) => column.notNull().unique())
    .addColumn("title", "varchar(200)", (column) => column.notNull())
    .addColumn("destination", "varchar(160)", (column) => column.notNull())
    .addColumn("start_date", "date", (column) => column.notNull())
    .addColumn("end_date", "date", (column) => column.notNull())
    .addColumn("traveler_count", "integer", (column) => column.notNull())
    .addColumn("day_count", "integer", (column) => column.notNull())
    .addColumn("next_decision", "text")
    .addColumn("updated_at", "timestamptz", (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();
}

export async function down(database: Kysely<unknown>) {
  await database.schema.dropTable("trip_summaries").ifExists().execute();
}
