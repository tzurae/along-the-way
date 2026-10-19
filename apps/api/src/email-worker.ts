import packageJson from "../../../package.json";

import { createDatabase, requireDatabaseUrl } from "./database/database";
import { claimNextDiscoveryJob, sweepStaleDiscoveryJobs } from "./discovery/discovery-jobs";
import { OpenAiResponsesDiscoveryModel } from "./discovery/openai-responses-discovery-model";
import { PostgresDiscoveryModule } from "./discovery/postgres-discovery-module";
import { PostgresCommonsCandidateModule } from "./place-details/commons-photo-candidates";
import { CommonsPlacePhotos } from "./place-details/commons-place-photos";
import { PostgresRateLimiter } from "./private-trips/postgres-rate-limiter";
import { GooglePlacesProvider } from "./trip-places/google-places-provider";
import { PostgresTripPlaceModule } from "./trip-places/postgres-trip-place-module";
import { OpenAiPlacePlanningProfileModel } from "./planning/openai-place-planning-profile-model";
import { PostgresPlacePlanningProfileWorker } from "./planning/postgres-place-planning-profile-module";
import { PlaceGuideSourceFetcher } from "./place-guides/place-guide-sources";
import { PostgresEmailWorker } from "./private-trips/postgres-email-worker";
import { PostgresRetention } from "./private-trips/retention";
import { SmtpEmailSender } from "./private-trips/smtp-email-sender";
import { TokenIssuer } from "./private-trips/token-issuer";

function requireSetting(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalSetting(name: string) {
  return process.env[name]?.trim() || undefined;
}

function booleanSetting(name: string, fallback: boolean) {
  const value = optionalSetting(name);
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

const database = createDatabase(requireDatabaseUrl());
const smtpUsername = optionalSetting("SMTP_USERNAME");
const smtpPassword = optionalSetting("SMTP_PASSWORD");
if (Boolean(smtpUsername) !== Boolean(smtpPassword)) {
  throw new Error("SMTP_USERNAME and SMTP_PASSWORD must be set together");
}
const smtpSecure = booleanSetting("SMTP_SECURE", false);
const smtpRequireTls = booleanSetting(
  "SMTP_REQUIRE_TLS",
  Boolean(smtpUsername),
);
if (smtpUsername && !smtpSecure && !smtpRequireTls) {
  throw new Error(
    "Authenticated SMTP requires SMTP_SECURE or SMTP_REQUIRE_TLS",
  );
}
const emailWorker = new PostgresEmailWorker({
  database,
  siteAddress: requireSetting("SITE_ADDRESS"),
  tokenIssuer: new TokenIssuer(requireSetting("TOKEN_SECRET")),
  emailSender: new SmtpEmailSender({
    host: requireSetting("SMTP_HOST"),
    port: Number(process.env.SMTP_PORT ?? 1025),
    from: requireSetting("EMAIL_FROM"),
    password: smtpPassword,
    requireTls: smtpRequireTls,
    secure: smtpSecure,
    username: smtpUsername,
  }),
});
const wikimediaUserAgent = `AlongTheWay/${packageJson.version} (https://github.com/tzurae/along-the-way)`;
const planningProfileWorker = new PostgresPlacePlanningProfileWorker({
  database,
  model: new OpenAiPlacePlanningProfileModel({
    apiKey: optionalSetting("OPENAI_API_KEY"),
    model: optionalSetting("OPENAI_MODEL"),
  }),
  sources: new PlaceGuideSourceFetcher({ userAgent: wikimediaUserAgent }),
});
const retention = new PostgresRetention(database);
// 調查 research runs here, not in the API, so a deploy of the API cannot cut a run short.
const tokenSecret = requireSetting("TOKEN_SECRET");
const rateLimiter = new PostgresRateLimiter(database, tokenSecret);
const placeProvider = new GooglePlacesProvider({
  apiKey: optionalSetting("GOOGLE_MAPS_API_KEY"),
  consumeBudget: () => rateLimiter.tryConsumePaidProvider("google_places"),
});
const commonsPhotos = new CommonsPlacePhotos({ userAgent: wikimediaUserAgent });
const commonsCandidates = new PostgresCommonsCandidateModule({ database, photos: commonsPhotos, userAgent: wikimediaUserAgent });
const discovery = new PostgresDiscoveryModule({
  database,
  model: new OpenAiResponsesDiscoveryModel({
    apiKey: optionalSetting("OPENAI_API_KEY"),
    model: optionalSetting("OPENAI_MODEL"),
  }),
  placeLookup: placeProvider,
  // The research limit is charged when the job is queued (API); the worker never charges again.
  claimAiRun: async () => undefined,
  tripPlaces: new PostgresTripPlaceModule({
    database,
    provider: placeProvider,
    photoCapabilitySecret: tokenSecret,
    commonsPhotos,
    commonsCandidates,
  }),
  commonsCandidates,
});
/** A long stage (web research can take minutes) still reports that the job is alive. */
const DISCOVERY_HEARTBEAT_MS = 15_000;
let stopping = false;

function delay(milliseconds: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

async function runEmailLoop() {
  while (!stopping) {
    await retention.runIfDue();
    const processed = await emailWorker.runOnce();
    if (!processed) await delay(1_000);
  }
}

async function runPlanningProfileLoop() {
  while (!stopping) {
    const processed = await planningProfileWorker.runBatch();
    if (processed === 0) await delay(1_000);
  }
}

async function runDiscoveryLoop() {
  while (!stopping) {
    await sweepStaleDiscoveryJobs(database, new Date());
    const job = await claimNextDiscoveryJob(database, new Date());
    if (!job) {
      await delay(2_000);
      continue;
    }
    const heartbeat = setInterval(() => {
      void database.updateTable("discovery_jobs").set({ heartbeat_at: new Date() })
        .where("id", "=", job.id).where("status", "=", "running").execute().catch(() => undefined);
    }, DISCOVERY_HEARTBEAT_MS);
    try {
      // Google calls are budgeted against the member and IP that queued the job.
      await rateLimiter.withPaidProviderIdentity(job.clientIp, job.createdBy, () => discovery.runJob(job));
    } finally {
      clearInterval(heartbeat);
    }
  }
}

async function run() {
  console.info(JSON.stringify({ event: "worker_started", status: "ok" }));
  await Promise.all([runEmailLoop(), runPlanningProfileLoop(), runDiscoveryLoop()]);
}

function stop(signal: string) {
  console.info(JSON.stringify({ event: "worker_stopping", signal }));
  stopping = true;
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

try {
  await run();
} finally {
  await database.destroy();
}
