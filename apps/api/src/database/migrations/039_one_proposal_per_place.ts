import { sql, type Kysely } from "kysely";

// Owner decision 2026-10-19: one 幫我找 suggestion per trip and Google place. Duplicates from
// earlier research runs merge into one row: a decided row (accepted, then rejected) wins over a
// pending one, otherwise the newest. Votes are unioned and feedback moves to the kept row; the
// other rows are deleted (their evidence links cascade). Not expand-only: a release older than
// this one inserts a row per run and would hit the new unique index, so roll back by reverting
// this migration together with the code.
export async function up(database: Kysely<unknown>) {
  await sql`
    create temporary table proposal_merge as
    with ranked as (
      select id, trip_id,
        first_value(id) over (
          partition by trip_id, provider_place_id
          order by
            case status when 'accepted' then 0 when 'rejected' then 1 else 2 end,
            decided_at desc nulls last,
            created_at desc,
            id desc
        ) as keeper_id
      from candidate_proposals
    )
    select id, trip_id, keeper_id from ranked where id <> keeper_id;

    insert into discovery_proposal_votes (trip_id, proposal_id, member_user_id)
    select distinct merge.trip_id, merge.keeper_id, vote.member_user_id
    from proposal_merge as merge
    join discovery_proposal_votes as vote on vote.proposal_id = merge.id
    on conflict (proposal_id, member_user_id) do nothing;

    update discovery_feedback as feedback
    set proposal_id = merge.keeper_id
    from proposal_merge as merge
    where feedback.proposal_id = merge.id;

    delete from candidate_proposals
    where id in (select id from proposal_merge);

    drop table proposal_merge;

    alter table candidate_proposals
      drop constraint candidate_proposals_run_id_provider_place_id_key;
    alter table candidate_proposals
      add constraint candidate_proposals_trip_id_provider_place_id_key unique (trip_id, provider_place_id);
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  await sql`
    alter table candidate_proposals
      drop constraint candidate_proposals_trip_id_provider_place_id_key;
    alter table candidate_proposals
      add constraint candidate_proposals_run_id_provider_place_id_key unique (run_id, provider_place_id);
  `.execute(database);
}
