import { sql, type Kysely } from "kysely";

// Feedback 6f1f061a (2026-10-20): each day can carry its own title (「京都賞楓日」) and a free-text
// 玩法 note. `title` already exists from 002; this adds the note plus its own version, so editing
// the words never conflicts with arranging places (which bumps `version`). Expand-only: older
// releases ignore both columns.
export async function up(database: Kysely<unknown>) {
  await sql`
    alter table trip_days
      add column note text,
      add column details_version integer not null default 1,
      add constraint trip_days_note_length check (note is null or char_length(note) between 1 and 2000),
      add constraint trip_days_details_version_positive check (details_version > 0)
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    alter table trip_days
      drop constraint trip_days_details_version_positive,
      drop constraint trip_days_note_length,
      drop column details_version,
      drop column note
  `.execute(database);
}
