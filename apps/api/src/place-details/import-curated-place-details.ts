import { readFile, stat } from "node:fs/promises";
import { sql, type Kysely } from "kysely";
import { parseCuratedPlaceManifest, parsePlaceDetailReference, type CuratedPhotoAssetInput } from "@along-the-way/contracts/place-details";
import { createDatabase, requireDatabaseUrl, type AlongTheWayDatabase } from "../database/database";
import { packagedPhotoRoot, verifyPackagedPhoto } from "./photo-assets";

export interface CuratedPlaceBindings {
  version: 1;
  bindings: Array<{ key: string; canonicalPlaceId: string; itineraryPlaceIds: string[] }>;
}

export function parseCuratedPlaceBindings(value: unknown): CuratedPlaceBindings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid bindings object");
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || Object.keys(input).some((key) => key !== "version" && key !== "bindings")
    || !Array.isArray(input.bindings) || input.bindings.length > 200) throw new Error("Invalid bindings version/list");
  const keys = new Set<string>();
  const canonicalIds = new Set<string>();
  const legacyIds = new Set<string>();
  const bindings = input.bindings.map((value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid place binding");
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some((key) => !["key", "canonicalPlaceId", "itineraryPlaceIds"].includes(key))
      || typeof item.key !== "string" || item.key.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(item.key)
      || !Array.isArray(item.itineraryPlaceIds) || item.itineraryPlaceIds.length > 200) throw new Error("Invalid place binding fields");
    const canonicalPlaceId = parsePlaceDetailReference({ kind: "trip-place", id: item.canonicalPlaceId }).id;
    if (keys.has(item.key) || canonicalIds.has(canonicalPlaceId)) throw new Error("Duplicate place binding");
    keys.add(item.key);
    canonicalIds.add(canonicalPlaceId);
    const itineraryPlaceIds = item.itineraryPlaceIds.map((id: unknown) => {
      const parsed = parsePlaceDetailReference({ kind: "itinerary-place", id }).id;
      if (legacyIds.has(parsed)) throw new Error("Duplicate itinerary place binding");
      legacyIds.add(parsed);
      return parsed;
    });
    return { key: item.key, canonicalPlaceId, itineraryPlaceIds };
  });
  return { version: 1, bindings };
}

/** Operator-only publication. Never creates/merges identities or changes existing trip content. */
export async function importCuratedPlaceDetails(options: {
  database: Kysely<AlongTheWayDatabase>;
  manifest: unknown;
  bindings: unknown;
  assetRoot: string;
}): Promise<{ importedPlaces: number; verifiedAssets: number }> {
  const manifest = parseCuratedPlaceManifest(options.manifest);
  const bindings = parseCuratedPlaceBindings(options.bindings);
  const byKey = new Map(bindings.bindings.map((binding) => [binding.key, binding]));
  if (manifest.places.length !== bindings.bindings.length || manifest.places.some((place) => !byKey.has(place.key))) {
    throw new Error("Bindings must exactly cover the reviewed manifest keys");
  }
  const assets = new Map<string, CuratedPhotoAssetInput>();
  for (const place of manifest.places) {
    for (const photo of place.photos) {
      for (const asset of [photo.image, photo.thumbnail]) {
        const previous = assets.get(asset.filename);
        if (previous && JSON.stringify(previous) !== JSON.stringify(asset)) throw new Error("Conflicting metadata for immutable asset");
        assets.set(asset.filename, asset);
      }
    }
  }
  // Finish all file checks before opening the write transaction; a bad later file publishes nothing.
  for (const asset of assets.values()) await verifyPackagedPhoto(options.assetRoot, asset);
  await options.database.transaction().execute(async (transaction) => {
    // Serialize reviewed publications without modifying any canonical/provider/itinerary row.
    await sql`select pg_advisory_xact_lock(hashtextextended('curated-place-details-import', 0))`.execute(transaction);
    for (const place of manifest.places) {
      const binding = byKey.get(place.key)!;
      const identity = await transaction.selectFrom("place_identities").select("id")
        .where("id", "=", binding.canonicalPlaceId).forShare().executeTakeFirst();
      if (!identity) throw new Error(`Canonical identity does not exist: ${place.key}`);
      const prior = await transaction.selectFrom("curated_place_details").select(["place_id", "manifest_key"])
        .where((eb) => eb.or([eb("place_id", "=", binding.canonicalPlaceId), eb("manifest_key", "=", place.key)]))
        .execute();
      if (prior.some((row) => row.place_id !== binding.canonicalPlaceId || row.manifest_key !== place.key)) {
        throw new Error(`Refusing to retarget a reviewed place binding: ${place.key}`);
      }
      if (binding.itineraryPlaceIds.length) {
        const associations = await transaction.selectFrom("trip_places").select(["legacy_place_id", "place_id"])
          .where("legacy_place_id", "in", binding.itineraryPlaceIds).forShare().execute();
        if (associations.length !== binding.itineraryPlaceIds.length || associations.some((row) => row.place_id !== binding.canonicalPlaceId)) {
          throw new Error(`Itinerary binding must match an existing canonical association: ${place.key}`);
        }
      }
      const content = { place_id: binding.canonicalPlaceId, manifest_key: place.key, name: place.name,
        sections: JSON.stringify(place.sections), sources: JSON.stringify(place.sources) };
      await transaction.insertInto("curated_place_details").values(content)
        .onConflict((conflict) => conflict.column("place_id").doUpdateSet(content)).execute();
      await transaction.deleteFrom("curated_place_photos").where("place_id", "=", binding.canonicalPlaceId).execute();
      if (place.photos.length) {
        await transaction.insertInto("curated_place_photos").values(place.photos.map((photo, position) => ({
          place_id: binding.canonicalPlaceId, work_id: photo.id, position, metadata: JSON.stringify(photo),
          image_filename: photo.image.filename, thumbnail_filename: photo.thumbnail.filename,
        }))).execute();
      }
    }
  });
  return { importedPlaces: manifest.places.length, verifiedAssets: assets.size };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--manifest" || args[2] !== "--bindings" || !args[1] || !args[3]) {
    throw new Error("Usage: DATABASE_URL=... bun apps/api/src/place-details/import-curated-place-details.ts --manifest <reviewed.json> --bindings <existing-identities.json>");
  }
  const values: unknown[] = [];
  for (const filename of [args[1], args[3]]) {
    const info = await stat(filename);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error("Reviewed input must be a JSON file no larger than 8 MiB");
    values.push(JSON.parse(await readFile(filename, "utf8")));
  }
  const database = createDatabase(requireDatabaseUrl());
  try {
    const result = await importCuratedPlaceDetails({ database, manifest: values[0], bindings: values[1], assetRoot: packagedPhotoRoot });
    console.info(JSON.stringify({ event: "curated_place_details_imported", ...result }));
  } finally {
    await database.destroy();
  }
}
