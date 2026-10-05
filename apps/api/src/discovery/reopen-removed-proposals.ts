import { sql, type Transaction } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";

/** Caller must hold the trip lock before this transaction updates proposals and inserts events. */
export async function reopenRemovedProposals(
  transaction: Transaction<AlongTheWayDatabase>,
  tripId: string,
  now: Date,
  actorId: string | null = null,
  removingTripPlaceId: string | null = null,
) {
  await sql`
    with latest_run as (
      select id from discovery_runs where trip_id = ${tripId}
      order by created_at desc, id desc limit 1
    ), canonical as (
      select distinct on (proposal.provider_place_id)
        proposal.provider_place_id, proposal.id, proposal.status, proposal.run_id
      from candidate_proposals as proposal
      join discovery_runs as run on run.id = proposal.run_id and run.trip_id = proposal.trip_id
      where proposal.trip_id = ${tripId}
      order by proposal.provider_place_id, run.created_at desc, run.id desc, proposal.created_at desc, proposal.id desc
    ), removed as (
      select proposal.id, proposal.decided_by, canonical.id as keeper_id,
        canonical.status as keeper_status, canonical.run_id as keeper_run_id
      from candidate_proposals as proposal
      join canonical on canonical.provider_place_id = proposal.provider_place_id
      where proposal.trip_id = ${tripId} and proposal.status = 'accepted'
        and (
          proposal.accepted_trip_place_id = ${removingTripPlaceId}::uuid
          or not exists (
            select 1 from trip_places as place
            where place.trip_id = proposal.trip_id and place.id = proposal.accepted_trip_place_id
              and place.archived_at is null
          )
        )
    ), reopened as (
      update candidate_proposals as proposal
      set status = 'pending', decided_by = null, decided_at = null,
        accepted_trip_place_id = null,
        reopened_at = case when proposal.id = removed.keeper_id then ${now}::timestamptz else null end,
        version = proposal.version + 1, updated_at = ${now}
      from removed
      where proposal.id = removed.id and proposal.status = 'accepted'
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
          or (reopened.keeper_status = 'pending' and reopened.keeper_run_id = (select id from latest_run))
        )
      on conflict (proposal_id, member_user_id) do nothing
    )
    insert into change_events (trip_id, actor_id, event_type, target_type, target_id, summary)
    select trip_id, coalesce(${actorId}::uuid, decided_by), 'discovery.proposal_reopened',
      'candidate_proposal', id, 'Reopened an AI place proposal after its wishlist place was removed'
    from reopened
  `.execute(transaction);
}
