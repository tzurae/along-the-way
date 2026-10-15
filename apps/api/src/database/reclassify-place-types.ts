/**
 * One-off: re-derive every Google place's category from Google's current primary type with the
 * normalized mapping. Run once per environment after migration 027:
 *   bun apps/api/src/database/reclassify-place-types.ts          (dry run: prints changes)
 *   bun apps/api/src/database/reclassify-place-types.ts --apply  (writes them)
 * Needs DATABASE_URL and GOOGLE_MAPS_API_KEY. One Place Details call (primaryType only) per place.
 */
import { sql } from "kysely";

import { mappedPlaceType } from "../trip-places/google-places-provider";
import { createDatabase } from "./database";

const apply = process.argv.includes("--apply");
const databaseUrl = process.env.DATABASE_URL;
const apiKey = process.env.GOOGLE_MAPS_API_KEY;
if (!databaseUrl || !apiKey) throw new Error("DATABASE_URL and GOOGLE_MAPS_API_KEY are required");

/** Thrown inside a dry-run transaction so its updates are rolled back after being counted. */
class DryRun extends Error {
  constructor(readonly count: number) {
    super("dry run");
  }
}

const database = createDatabase(databaseUrl);
// Every Google place the app shows: confirmed identities plus AI proposals that never became one.
const identities = await database.selectFrom("place_identities")
  .select(["id", "provider_place_id", "canonical_name"])
  .where("provider", "=", "google")
  .where("provider_place_id", "is not", null)
  .execute();
const proposals = await database.selectFrom("candidate_proposals")
  .select(["provider_place_id", "name"])
  .distinctOn("provider_place_id")
  .execute();
const places = new Map<string, { name: string; identityId: string | null }>();
for (const proposal of proposals) places.set(proposal.provider_place_id, { name: proposal.name, identityId: null });
for (const identity of identities) places.set(identity.provider_place_id!, { name: identity.canonical_name, identityId: identity.id });

let changedRows = 0;
for (const [providerPlaceId, place] of places) {
  const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(providerPlaceId)}`, {
    headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "primaryType" },
  });
  if (!response.ok) {
    console.log(`skip ${place.name}: Google ${response.status}`);
    continue;
  }
  const body = await response.json() as { primaryType?: unknown };
  const primaryType = typeof body.primaryType === "string" ? body.primaryType : "";
  // Without a Google type there is nothing better than what is stored; never downgrade to other.
  if (!primaryType) {
    console.log(`skip ${place.name}: Google has no primary type`);
    continue;
  }
  const next = mappedPlaceType(primaryType);
  const rows = await database.transaction().execute(async (transaction) => {
    let count = 0;
    if (place.identityId) {
      count += Number((await transaction.updateTable("place_identities").set({ canonical_type: next })
        .where("id", "=", place.identityId).where("canonical_type", "<>", next).executeTakeFirst()).numUpdatedRows);
      // Provider-backed trip places and their legacy place rows show the provider's category.
      const legacy = await sql<{ id: string }>`update places set place_type = ${next}
        where place_type <> ${next}
          and id in (select legacy_place_id from trip_places where place_id = ${place.identityId} and facts_source = 'provider')
        returning id`.execute(transaction);
      count += legacy.rows.length;
      count += Number((await transaction.updateTable("trip_places").set({ place_type: next })
        .where("place_id", "=", place.identityId).where("facts_source", "=", "provider")
        .where("place_type", "<>", next).executeTakeFirst()).numUpdatedRows);
    }
    count += Number((await transaction.updateTable("candidate_proposals").set({ place_type: next })
      .where("provider_place_id", "=", providerPlaceId).where("place_type", "<>", next).executeTakeFirst()).numUpdatedRows);
    // Dry run: count what would change, then undo it.
    if (!apply) throw new DryRun(count);
    return count;
  }).catch((error: unknown) => {
    if (error instanceof DryRun) return error.count;
    throw error;
  });
  changedRows += rows;
  console.log(`${place.name}: ${primaryType || "(none)"} → ${next}${rows ? ` (${rows} row${rows === 1 ? "" : "s"} ${apply ? "updated" : "to update"})` : ""}`);
}
console.log(apply
  ? `updated ${changedRows} rows across ${places.size} places`
  : `dry run: ${changedRows} rows would change across ${places.size} places; rerun with --apply to write`);
await database.destroy();
