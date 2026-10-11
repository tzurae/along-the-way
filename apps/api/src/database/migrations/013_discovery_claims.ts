import { sql, type Kysely } from "kysely";

// Additive: null means the proposal predates sentence-level source attribution.
export async function up(database: Kysely<unknown>) {
  await sql`
    alter table candidate_proposals
      add column recommendation_sentences jsonb,
      add column tradeoff_sentences jsonb
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    alter table candidate_proposals
      drop column tradeoff_sentences,
      drop column recommendation_sentences
  `.execute(database);
}
