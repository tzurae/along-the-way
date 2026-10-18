/**
 * Generates Commons candidates, or refreshes existing candidate facts and automatic matches.
 * Serial and polite; uses stored names and coordinates and never calls Google.
 *
 *   DATABASE_URL=... bun apps/api/src/database/backfill-commons-candidates.ts
 *   DATABASE_URL=... bun apps/api/src/database/backfill-commons-candidates.ts --refresh
 */
import packageJson from "../../../../package.json";

import {
  PostgresCommonsCandidateModule,
  type CommonsCandidateGenerationOutcome,
} from "../place-details/commons-photo-candidates";
import { CommonsPlacePhotos } from "../place-details/commons-place-photos";
import { createDatabase, requireDatabaseUrl } from "./database";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--refresh")) {
  throw new Error("Usage: DATABASE_URL=... bun apps/api/src/database/backfill-commons-candidates.ts [--refresh]");
}
const refresh = args[0] === "--refresh";

const database = createDatabase(requireDatabaseUrl());
const userAgent = `AlongTheWay/${packageJson.version} (https://github.com/tzurae/along-the-way)`;
const candidates = new PostgresCommonsCandidateModule({
  database,
  photos: new CommonsPlacePhotos({ userAgent }),
  userAgent,
});
const counts: Record<CommonsCandidateGenerationOutcome | "error", number> = {
  generated: 0,
  auto_applied: 0,
  refreshed: 0,
  has_photo: 0,
  already_generated: 0,
  no_candidates: 0,
  error: 0,
};

try {
  let identityQuery = database.selectFrom("place_identities as identity")
    .leftJoin("commons_place_photos as photo", "photo.place_id", "identity.id")
    .select(["identity.id", "identity.canonical_name"])
    .orderBy("identity.id");
  if (!refresh) identityQuery = identityQuery.where("photo.place_id", "is", null);
  const identities = await identityQuery.execute();

  let stored = 0;
  for (let index = 0; index < identities.length; index++) {
    const identity = identities[index]!;
    try {
      const result = refresh ? await candidates.refresh(identity.id) : await candidates.generate(identity.id);
      counts[result.outcome]++;
      stored += result.stored;
      console.info(JSON.stringify({
        event: "commons_candidate_backfill_identity",
        placeIdentityId: identity.id,
        name: identity.canonical_name,
        outcome: result.outcome,
        refresh,
        stored: result.stored,
      }));
    } catch {
      counts.error++;
      console.info(JSON.stringify({
        event: "commons_candidate_backfill_identity",
        placeIdentityId: identity.id,
        name: identity.canonical_name,
        refresh,
        outcome: "error",
        stored: 0,
      }));
    }
    if (index + 1 < identities.length) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 250);
      await promise;
    }
  }

  console.info(JSON.stringify({
    event: "commons_candidate_backfill_complete",
    identities: identities.length,
    stored,
    refresh,
    outcomes: counts,
  }));
} finally {
  await database.destroy();
}
