import { sql, type Transaction } from "kysely";

import type { AlongTheWayDatabase } from "../database/database";

/**
 * A suggestion whose wishlist place was removed goes back to pending on the 幫我找 list. There is
 * one suggestion per trip and place (migration 039), so its votes stay on the same row.
 * Caller must hold the trip lock before this transaction updates proposals and inserts events.
 */
export async function reopenRemovedProposals(
  transaction: Transaction<AlongTheWayDatabase>,
  tripId: string,
  now: Date,
  actorId: string | null = null,
  removingTripPlaceId: string | null = null,
) {
  await sql`
    with removed as (
      -- Read before the update: the event names who had accepted it.
      select proposal.id, proposal.decided_by
      from candidate_proposals as proposal
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
        version = proposal.version + 1, updated_at = ${now}
      from removed
      where proposal.id = removed.id and proposal.status = 'accepted'
      returning proposal.id, proposal.trip_id, removed.decided_by as previous_decider
    )
    insert into change_events (trip_id, actor_id, event_type, target_type, target_id, summary)
    select trip_id, coalesce(${actorId}::uuid, previous_decider), 'discovery.proposal_reopened',
      'candidate_proposal', id, 'Reopened an AI place proposal after its wishlist place was removed'
    from reopened
  `.execute(transaction);
}
