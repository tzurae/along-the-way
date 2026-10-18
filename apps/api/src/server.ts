import { createApp } from "./app";
import { PostgresCollaborationModule } from "./private-trips/postgres-collaboration-module";
import { createDatabase, requireDatabaseUrl } from "./database/database";
import { OpenAiResponsesDiscoveryModel } from "./discovery/openai-responses-discovery-model";
import { PostgresDiscoveryModule } from "./discovery/postgres-discovery-module";
import { PostgresDayPlanModule } from "./planning/postgres-day-plan-module";
import { PostgresIdentityAccessModule } from "./private-trips/postgres-identity-access-module";
import { PostgresRateLimiter } from "./private-trips/postgres-rate-limiter";
import { PostgresReadinessProbe } from "./private-trips/postgres-readiness-probe";
import { PostgresTripWorkspaceModule } from "./private-trips/postgres-trip-workspace-module";
import { TokenIssuer } from "./private-trips/token-issuer";
import { PostgresTripSkeletonModule } from "./trip-skeleton/postgres-trip-skeleton-module";
import { GooglePlacesProvider } from "./trip-places/google-places-provider";
import { PostgresTripPlaceModule } from "./trip-places/postgres-trip-place-module";
import { PostgresPlaceDetailModule } from "./place-details/postgres-place-detail-module";
import { packagedPhotoRoot } from "./place-details/photo-assets";
import { CommonsPlacePhotos } from "./place-details/commons-place-photos";
import { PostgresCommonsCandidateModule } from "./place-details/commons-photo-candidates";
import { PostgresFeedbackModule } from "./admin/postgres-feedback-module";
import { DefaultGoogleUsageModule } from "./admin/google-usage-module";
import { OpenAiPlaceGuideModel } from "./place-guides/openai-place-guide-model";
import { PlaceGuideSourceFetcher } from "./place-guides/place-guide-sources";
import { PostgresPlaceGuideModule } from "./place-guides/postgres-place-guide-module";
import packageJson from "../../../package.json";

function requireSetting(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const database = createDatabase(requireDatabaseUrl());
const siteAddress = requireSetting("SITE_ADDRESS");
const tokenSecret = requireSetting("TOKEN_SECRET");
const mapsConfig = {
  browserKey: process.env.GOOGLE_MAPS_BROWSER_KEY?.trim() || null,
  mapId: process.env.GOOGLE_MAPS_MAP_ID?.trim() || null,
};
const adminEmails = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);
const identityAccess = new PostgresIdentityAccessModule({
  database,
  tokenIssuer: new TokenIssuer(tokenSecret),
  adminEmails,
});
const tripWorkspace = new PostgresTripWorkspaceModule({ database });
const tripSkeleton = new PostgresTripSkeletonModule({ database });
const rateLimiter = new PostgresRateLimiter(database, tokenSecret);
const feedback = new PostgresFeedbackModule(database);
const googleUsage = new DefaultGoogleUsageModule({
  credentialsFile: process.env.GCP_MONITORING_CREDENTIALS_FILE,
  projects: process.env.GCP_MONITORING_PROJECTS,
  environment: process.env.NODE_ENV,
  rateLimiter,
});
const placeProvider = new GooglePlacesProvider({
  apiKey: process.env.GOOGLE_MAPS_API_KEY,
  consumeBudget: () => rateLimiter.tryConsumePaidProvider("google_places"),
});
const wikimediaUserAgent = `AlongTheWay/${packageJson.version} (https://github.com/tzurae/along-the-way)`;
const commonsPhotos = new CommonsPlacePhotos({ userAgent: wikimediaUserAgent });
const commonsCandidates = new PostgresCommonsCandidateModule({
  database,
  photos: commonsPhotos,
  userAgent: wikimediaUserAgent,
});
const placeGuides = new PostgresPlaceGuideModule({
  database,
  model: new OpenAiPlaceGuideModel({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
  }),
  sources: new PlaceGuideSourceFetcher({ userAgent: wikimediaUserAgent }),
});
const tripPlaces = new PostgresTripPlaceModule({
  database,
  provider: placeProvider,
  photoCapabilitySecret: tokenSecret,
  commonsPhotos,
  commonsCandidates,
});
const discovery = new PostgresDiscoveryModule({
  database,
  model: new OpenAiResponsesDiscoveryModel({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL,
  }),
  placeLookup: placeProvider,
  claimAiRun: (userId, tripId) => rateLimiter.claimDiscoveryAiRun(userId, tripId),
  tripPlaces,
});
const dayPlans = new PostgresDayPlanModule({
  database,
  tripSkeleton,
  tripPlaces,
});
const readiness = new PostgresReadinessProbe(database);
const app = createApp({
  appVersion: packageJson.version,
  collaboration: new PostgresCollaborationModule(database),
  dayPlans,
  discovery,
  feedback,
  googleUsage,
  identityAccess,
  mapsConfig,
  placeDetails: new PostgresPlaceDetailModule({
    database,
    assetRoot: packagedPhotoRoot,
    ...(placeProvider.available ? { provider: placeProvider } : {}),
    photoCapabilitySecret: tokenSecret,
  }),
  placeGuides,
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
  idleTimeout: 30,
  // Backstop for the per-route limits in createApp (largest is 2 MiB).
  maxRequestBodySize: 4 * 1024 * 1024,
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
