import { createApp } from "./app";
import { createDatabase, requireDatabaseUrl } from "./database/database";
import { OpenAiResponsesDiscoveryModel } from "./discovery/openai-responses-discovery-model";
import { PostgresDiscoveryModule } from "./discovery/postgres-discovery-module";
import { PostgresIdentityAccessModule } from "./private-trips/postgres-identity-access-module";
import { PostgresRateLimiter } from "./private-trips/postgres-rate-limiter";
import { PostgresReadinessProbe } from "./private-trips/postgres-readiness-probe";
import { PostgresTripWorkspaceModule } from "./private-trips/postgres-trip-workspace-module";
import { TokenIssuer } from "./private-trips/token-issuer";
import { PostgresTripSkeletonModule } from "./trip-skeleton/postgres-trip-skeleton-module";
import { GooglePlacesProvider } from "./trip-places/google-places-provider";
import { PostgresTripPlaceModule } from "./trip-places/postgres-trip-place-module";

function requireSetting(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const database = createDatabase(requireDatabaseUrl());
const siteAddress = requireSetting("SITE_ADDRESS");
const tokenSecret = requireSetting("TOKEN_SECRET");
const identityAccess = new PostgresIdentityAccessModule({
  database,
  tokenIssuer: new TokenIssuer(tokenSecret),
});
const tripWorkspace = new PostgresTripWorkspaceModule({ database });
const tripSkeleton = new PostgresTripSkeletonModule({ database });
const placeProvider = new GooglePlacesProvider({
  apiKey: process.env.GOOGLE_MAPS_API_KEY,
});
const tripPlaces = new PostgresTripPlaceModule({
  database,
  provider: placeProvider,
});
const discovery = new PostgresDiscoveryModule({
  database,
  model: new OpenAiResponsesDiscoveryModel({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
  }),
  placeProvider,
  tripPlaces,
});
const rateLimiter = new PostgresRateLimiter(database, tokenSecret);
const readiness = new PostgresReadinessProbe(database);
const app = createApp({
  discovery,
  identityAccess,
  rateLimiter,
  readiness,
  siteAddress,
  tripSkeleton,
  tripPlaces,
  tripWorkspace,
});
const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  fetch: app.fetch,
});

console.info(
  JSON.stringify({ event: "api_started", port: server.port, status: "ok" }),
);

function shutDown(signal: string) {
  console.info(JSON.stringify({ event: "api_stopping", signal }));
  server.stop();
  void database.destroy().finally(() => process.exit(0));
}

process.once("SIGINT", () => shutDown("SIGINT"));
process.once("SIGTERM", () => shutDown("SIGTERM"));
