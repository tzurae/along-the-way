/**
 * Generates one zh-TW guide for each place identity that does not have a stored result.
 * Serial and polite; only Wikipedia, Wikivoyage and the configured OpenAI model are called.
 *
 *   DATABASE_URL=... OPENAI_API_KEY=... OPENAI_MODEL=... bun apps/api/src/database/backfill-place-guides.ts
 */
import packageJson from "../../../../package.json";

import { OpenAiPlaceGuideModel } from "../place-guides/openai-place-guide-model";
import { PlaceGuideSourceFetcher } from "../place-guides/place-guide-sources";
import { PostgresPlaceGuideModule } from "../place-guides/postgres-place-guide-module";
import { createDatabase, requireDatabaseUrl } from "./database";

const apiKey = process.env.OPENAI_API_KEY?.trim();
const modelId = process.env.OPENAI_MODEL?.trim();
if (!apiKey || !modelId) {
  throw new Error("OPENAI_API_KEY and OPENAI_MODEL are required for the place guide backfill");
}

const database = createDatabase(requireDatabaseUrl());
const userAgent = `AlongTheWay/${packageJson.version} (https://github.com/tzurae/along-the-way)`;
const guides = new PostgresPlaceGuideModule({
  database,
  model: new OpenAiPlaceGuideModel({ apiKey, model: modelId }),
  sources: new PlaceGuideSourceFetcher({ userAgent }),
});
const counts: Record<"generating" | "ready" | "no_sources" | "failed" | "error", number> = {
  generating: 0,
  ready: 0,
  no_sources: 0,
  failed: 0,
  error: 0,
};

try {
  const identities = await database.selectFrom("place_identities as identity")
    .leftJoin("place_guides as guide", "guide.place_id", "identity.id")
    .select(["identity.id", "identity.canonical_name"])
    .where((expression) => expression.or([
      expression("guide.place_id", "is", null),
      expression("guide.status", "=", "generating"),
    ]))
    .orderBy("identity.id")
    .execute();

  for (let index = 0; index < identities.length; index++) {
    const identity = identities[index]!;
    try {
      await guides.generateForPlace(identity.id);
      const stored = await database.selectFrom("place_guides")
        .select("status")
        .where("place_id", "=", identity.id)
        .executeTakeFirst();
      const outcome = stored?.status ?? "error";
      counts[outcome]++;
      console.info(JSON.stringify({
        event: "place_guide_backfill_identity",
        placeIdentityId: identity.id,
        name: identity.canonical_name,
        outcome,
      }));
    } catch (error) {
      counts.error++;
      console.info(JSON.stringify({
        event: "place_guide_backfill_identity",
        placeIdentityId: identity.id,
        name: identity.canonical_name,
        outcome: "error",
        errorClass: error instanceof Error ? error.constructor.name : "NonErrorThrow",
      }));
    }
    if (index + 1 < identities.length) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 500);
      await promise;
    }
  }

  console.info(JSON.stringify({
    event: "place_guide_backfill_complete",
    identities: identities.length,
    outcomes: counts,
  }));
} finally {
  await database.destroy();
}
