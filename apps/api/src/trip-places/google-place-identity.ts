import type { ProviderPlaceCandidateDto } from "@along-the-way/contracts/trip-places";
import { sql } from "kysely";

import type { DatabaseExecutor } from "../private-trips/postgres-private-trip-store";

/**
 * The one canonical identity per Google place id. Wishlist intake and AI 建議 both use it, so an
 * AI suggestion gets the same identity (and its Commons photo) before anyone adds it. Only the
 * place id and its basic facts are kept, never Google photos or reviews.
 */
export async function upsertGooglePlaceIdentity(
  executor: DatabaseExecutor,
  candidate: ProviderPlaceCandidateDto,
  now: Date,
): Promise<{ id: string }> {
  const result = await sql<{ id: string }>`
    insert into place_identities (
      provider, provider_place_id, canonical_name, canonical_type,
      canonical_address, latitude, longitude, time_zone,
      provider_observed_at, provider_expires_at, provider_attribution,
      updated_at
    ) values (
      'google', ${candidate.providerPlaceId}, ${candidate.name}, ${candidate.type},
      ${candidate.address}, ${candidate.latitude}, ${candidate.longitude}, ${candidate.timeZone},
      ${candidate.observedAt}, ${candidate.expiresAt}, ${candidate.attribution}, ${now}
    )
    on conflict (provider, provider_place_id) where provider_place_id is not null
    do update set
      canonical_name = excluded.canonical_name,
      canonical_type = excluded.canonical_type,
      canonical_address = excluded.canonical_address,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      time_zone = excluded.time_zone,
      provider_observed_at = excluded.provider_observed_at,
      provider_expires_at = excluded.provider_expires_at,
      provider_attribution = excluded.provider_attribution,
      updated_at = excluded.updated_at
    returning id
  `.execute(executor);
  return result.rows[0]!;
}
