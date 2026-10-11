import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>) {
  await sql`alter table candidate_proposals add column reopened_at timestamptz`.execute(database);
  // Legacy notes already held intake text before 017; fill the mirror without consuming version gaps.
  await sql`
    update trip_places as place
    set notes = legacy.notes
    from places as legacy
    where place.legacy_place_id = legacy.id and place.trip_id = legacy.trip_id
      and place.notes is null and legacy.notes is not null
  `.execute(database);
  // Only when both notes are missing, recover contribution history on both projections.
  await sql`
    with original_notes as (
      select trip_place_id, btrim(original_note) as note, min(created_at) as first_created_at
      from trip_place_contributions
      where nullif(btrim(original_note), '') is not null
      group by trip_place_id, btrim(original_note)
    ), backfill as (
      select place.id, place.legacy_place_id,
        left(string_agg(note, E'\n\n' order by first_created_at, note), 10000) as notes
      from trip_places as place
      join original_notes on original_notes.trip_place_id = place.id
      join places as legacy on legacy.id = place.legacy_place_id and legacy.trip_id = place.trip_id
      where place.notes is null and legacy.notes is null
      group by place.id, place.legacy_place_id
    ), synced as (
      update places as legacy
      set notes = backfill.notes
      from backfill
      where legacy.id = backfill.legacy_place_id
      returning backfill.id, legacy.notes
    )
    update trip_places as place
    set notes = synced.notes
    from synced where place.id = synced.id
  `.execute(database);
  await sql`
    with latest_runs as (
      select distinct on (trip_id) trip_id, id from discovery_runs
      order by trip_id, created_at desc, id desc
    ), canonical as (
      select distinct on (proposal.trip_id, proposal.provider_place_id)
        proposal.trip_id, proposal.provider_place_id, proposal.id, proposal.status, proposal.run_id
      from candidate_proposals as proposal
      join discovery_runs as run on run.id = proposal.run_id and run.trip_id = proposal.trip_id
      order by proposal.trip_id, proposal.provider_place_id,
        run.created_at desc, run.id desc, proposal.created_at desc, proposal.id desc
    ), removed as (
      select proposal.id, proposal.decided_by, canonical.id as keeper_id,
        canonical.status as keeper_status, canonical.run_id as keeper_run_id
      from candidate_proposals as proposal
      join canonical on canonical.trip_id = proposal.trip_id
        and canonical.provider_place_id = proposal.provider_place_id
      where proposal.status = 'accepted' and not exists (
        select 1 from trip_places as place
        where place.trip_id = proposal.trip_id and place.id = proposal.accepted_trip_place_id
          and place.archived_at is null
      )
    ), reopened as (
      update candidate_proposals as proposal
      set status = 'pending', decided_by = null, decided_at = null,
        accepted_trip_place_id = null,
        reopened_at = case when proposal.id = removed.keeper_id then now() else null end,
        version = proposal.version + 1, updated_at = now()
      from removed where proposal.id = removed.id
      returning proposal.id, proposal.trip_id, removed.decided_by, removed.keeper_id,
        removed.keeper_status, removed.keeper_run_id
    ), carried_votes as (
      insert into discovery_proposal_votes (trip_id, proposal_id, member_user_id)
      select distinct reopened.trip_id, reopened.keeper_id, vote.member_user_id
      from reopened
      join discovery_proposal_votes as vote on vote.proposal_id = reopened.id
      join trip_members as member
        on member.trip_id = vote.trip_id and member.user_id = vote.member_user_id
      where member.removed_at is null and reopened.id <> reopened.keeper_id
        and (
          exists (select 1 from reopened as keeper where keeper.id = reopened.keeper_id)
          or (reopened.keeper_status = 'pending' and reopened.keeper_run_id = (
            select id from latest_runs where trip_id = reopened.trip_id
          ))
        )
      on conflict (proposal_id, member_user_id) do nothing
    )
    insert into change_events (trip_id, actor_id, event_type, target_type, target_id, summary)
    select trip_id, decided_by, 'discovery.proposal_reopened', 'candidate_proposal', id,
      'Reopened an AI place proposal after its wishlist place was removed'
    from reopened
  `.execute(database);
}

export async function down(database: Kysely<unknown>) {
  // Keep backfilled notes, reopened decisions, and events; only remove the projection marker.
  await sql`alter table candidate_proposals drop column reopened_at`.execute(database);
}
