/**
 * Enqueues every selected sightseeing identity whose cached profile is missing or stale.
 * Generation remains in the worker, so this script makes no Wikimedia or OpenAI calls.
 *
 *   DATABASE_URL=... OPENAI_MODEL=... bun apps/api/src/database/backfill-place-planning-profiles.ts
 */
import { enqueueSelectedPlacePlanningProfiles } from "../planning/postgres-place-planning-profile-module";
import { createDatabase, requireDatabaseUrl } from "./database";

const modelId = process.env.OPENAI_MODEL?.trim();
if (!modelId) {
  throw new Error("OPENAI_MODEL is required for the place planning profile backfill");
}

const database = createDatabase(requireDatabaseUrl());
try {
  const enqueued = await enqueueSelectedPlacePlanningProfiles(database, modelId);
  console.info(JSON.stringify({
    event: "place_planning_profile_backfill_complete",
    enqueued,
  }));
} finally {
  await database.destroy();
}
