/**
 * One-off: populate Commons representative photos for identities created before migration 024.
 * Safe to rerun: identities that already have a commons_place_photos row are skipped.
 * Uses only Google CIDs already present in stored source URLs; it makes no Google requests.
 *
 *   DATABASE_URL=... bun apps/api/src/database/backfill-commons-photos.ts
 */
import packageJson from "../../../../package.json";

import {
  CommonsPlacePhotos,
  googleMapsCid,
  type CommonsPhotoLookupOutcome,
} from "../place-details/commons-place-photos";
import { createDatabase, requireDatabaseUrl } from "./database";

const database = createDatabase(requireDatabaseUrl());
const counts: Record<CommonsPhotoLookupOutcome, number> = {
  matched: 0,
  no_cid: 0,
  no_item: 0,
  multiple_items: 0,
  no_p18: 0,
  licence_rejected: 0,
  error: 0,
};
const commonsPhotos = new CommonsPlacePhotos({
  userAgent: `AlongTheWay/${packageJson.version} (https://github.com/tzurae/along-the-way)`,
  onLookup: (record) => {
    counts[record.outcome]++;
  },
});

try {
  const rows = await database.selectFrom("place_identities as identity")
    .leftJoin("commons_place_photos as commons", "commons.place_id", "identity.id")
    .leftJoin("trip_places as tripPlace", "tripPlace.place_id", "identity.id")
    .leftJoin("places as legacy", (join) => join
      .onRef("legacy.id", "=", "tripPlace.legacy_place_id")
      .onRef("legacy.trip_id", "=", "tripPlace.trip_id"))
    .leftJoin("legacy_place_origins as origin", (join) => join
      .onRef("origin.place_id", "=", "legacy.id")
      .onRef("origin.trip_id", "=", "legacy.trip_id"))
    // A merge moves contributions onto the surviving place without copying its source URL.
    .leftJoin("trip_place_contributions as contribution", (join) => join
      .onRef("contribution.trip_place_id", "=", "tripPlace.id")
      .onRef("contribution.trip_id", "=", "tripPlace.trip_id"))
    .select([
      "identity.id",
      "identity.provider_place_id",
      "identity.canonical_name",
      "legacy.source_url as current_source_url",
      "origin.source_url as origin_source_url",
      "contribution.source_url as contribution_source_url",
    ])
    .where("commons.place_id", "is", null)
    .orderBy("identity.id")
    .execute();

  const identities = new Map<string, {
    providerPlaceId: string | null;
    name: string;
    sourceUrl: string | null;
  }>();
  for (const row of rows) {
    const current = identities.get(row.id);
    const sourceUrl = [row.current_source_url, row.origin_source_url, row.contribution_source_url]
      .find((value) => googleMapsCid(value) !== null) ?? null;
    if (!current) {
      identities.set(row.id, {
        providerPlaceId: row.provider_place_id,
        name: row.canonical_name,
        sourceUrl,
      });
    } else if (current.sourceUrl === null && sourceUrl !== null) {
      current.sourceUrl = sourceUrl;
    }
  }

  let stored = 0;
  let position = 0;
  for (const [identityId, identity] of identities) {
    const prepared = await commonsPhotos.prepare(identity.sourceUrl, identity.providerPlaceId);
    if (prepared) {
      const accepted = await database.transaction().execute((transaction) =>
        commonsPhotos.store(transaction, identityId, prepared));
      if (accepted) {
        stored++;
        console.info(JSON.stringify({
          event: "commons_photo_backfill_stored",
          placeIdentityId: identityId,
          providerPlaceId: identity.providerPlaceId,
          wikidataId: prepared.wikidataId,
          name: identity.name,
        }));
      }
    }
    position++;
    if (position < identities.size) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 250);
      await promise;
    }
  }

  console.info(JSON.stringify({
    event: "commons_photo_backfill_complete",
    identities: identities.size,
    stored,
    outcomes: counts,
  }));
} finally {
  await database.destroy();
}
