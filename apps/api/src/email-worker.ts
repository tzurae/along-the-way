import { createDatabase, requireDatabaseUrl } from "./database/database";
import { PostgresEmailWorker } from "./private-trips/postgres-email-worker";
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
const worker = new PostgresEmailWorker({
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
let stopping = false;

function delay(milliseconds: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

async function run() {
  console.info(JSON.stringify({ event: "email_worker_started", status: "ok" }));
  while (!stopping) {
    const processed = await worker.runOnce();
    if (!processed) await delay(1_000);
  }
}

function stop(signal: string) {
  console.info(JSON.stringify({ event: "email_worker_stopping", signal }));
  stopping = true;
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

try {
  await run();
} finally {
  await database.destroy();
}
