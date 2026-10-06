import { sql, type Kysely } from "kysely";

// Additive defaults keep existing briefs and feedback readable during rollout.
export async function up(database: Kysely<unknown>) {
  await sql`
    alter table discovery_briefs
      add column question_answers jsonb not null default '[]'::jsonb
  `.execute(database);
  await sql`
    alter table discovery_feedback
      add column interpretation_edited boolean not null default false
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`alter table discovery_feedback drop column interpretation_edited`.execute(database);
  await sql`alter table discovery_briefs drop column question_answers`.execute(database);
}
