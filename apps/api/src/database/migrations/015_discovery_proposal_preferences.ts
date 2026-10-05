import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`
    alter table candidate_proposals
      add constraint candidate_proposals_trip_id_id_unique unique (trip_id, id)
  `.execute(database);

  await sql`
    create table discovery_proposal_preferences (
      trip_id uuid not null,
      proposal_id uuid not null,
      member_user_id uuid not null,
      preference varchar(16) not null check (
        preference in ('must', 'want', 'optional', 'neutral', 'dislike')
      ),
      version integer not null default 1 check (version > 0),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (proposal_id, member_user_id),
      foreign key (trip_id, proposal_id)
        references candidate_proposals(trip_id, id) on delete cascade,
      foreign key (trip_id, member_user_id)
        references trip_members(trip_id, user_id) on delete cascade
    )
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`drop table discovery_proposal_preferences`.execute(database);
  await sql`
    alter table candidate_proposals
      drop constraint candidate_proposals_trip_id_id_unique
  `.execute(database);
}
