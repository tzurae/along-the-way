import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { isRecord } from "@along-the-way/contracts/private-trips";

const execFileAsync = promisify(execFile);
const MAILPIT_API_URL = process.env.MAILPIT_API_URL ?? "http://127.0.0.1:8025";

async function executeDatabase(command: string) {
  await execFileAsync("docker", [
    "compose",
    "--project-name",
    process.env.E2E_COMPOSE_PROJECT ?? "along-the-way",
    "exec",
    "--no-TTY",
    "db",
    "psql",
    "--username",
    process.env.POSTGRES_ADMIN_USER ?? "along_the_way_admin_test",
    "--dbname",
    process.env.POSTGRES_DB ?? "along_the_way_test",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    command,
  ]);
}

interface MailpitMessage {
  id: string;
  recipients: string[];
  subject: string;
}

function messages(value: unknown): MailpitMessage[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) throw new Error("Invalid Mailpit response");
  return value.messages.map((message) => {
    if (!isRecord(message) || typeof message.ID !== "string" || typeof message.Subject !== "string" || !Array.isArray(message.To)) {
      throw new Error("Invalid Mailpit message");
    }
    return {
      id: message.ID,
      subject: message.Subject,
      recipients: message.To.map((recipient) => {
        if (!isRecord(recipient) || typeof recipient.Address !== "string") throw new Error("Invalid Mailpit recipient");
        return recipient.Address;
      }),
    };
  });
}

async function signIn(page: Page, request: APIRequestContext, email: string) {
  await page.goto("/");
  const previous = await request.get(`${MAILPIT_API_URL}/api/v1/messages`);
  const previousIds = new Set(messages(await previous.json()).map((message) => message.id));
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  let id = "";
  await expect.poll(async () => {
    const response = await request.get(`${MAILPIT_API_URL}/api/v1/messages`);
    id = messages(await response.json()).find((message) =>
      !previousIds.has(message.id) &&
      message.subject.includes("Sign in to Along the Way") &&
      message.recipients.includes(email)
    )?.id ?? "";
    return id;
  }).not.toBe("");
  const detail = await request.get(`${MAILPIT_API_URL}/api/v1/message/${id}`);
  const body: unknown = await detail.json();
  if (!isRecord(body) || typeof body.Text !== "string") throw new Error("Invalid Mailpit body");
  const link = body.Text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error("Magic link missing");
  await page.goto("about:blank");
  await page.goto(link);
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
}

async function createTrip(page: Page, name: string) {
  await page.getByRole("button", { name: "Create trip" }).click();
  const dialog = page.getByRole("dialog", { name: "Create a trip" });
  await dialog.getByLabel("Trip name").fill(name);
  await dialog.getByRole("button", { name: "Choose a date range" }).click();
  const year = 2026;
  const month = 11;
  const current = new Date();
  const offset = year * 12 + month - 1 - (current.getFullYear() * 12 + current.getMonth());
  const direction = offset >= 0 ? "Next" : "Previous";
  for (let index = 0; index < Math.abs(offset); index += 1) {
    await page.getByRole("button", { name: new RegExp(direction, "i") }).click();
  }
  const label = (day: number) => new Date(year, month - 1, day).toLocaleDateString("en-US");
  await page.locator(`[data-day="${label(3)}"]`).click();
  await page.locator(`[data-day="${label(9)}"]`).click();
  await dialog.getByLabel("Add a country").fill("Japan");
  await page.getByRole("option", { name: /\(JP\)/ }).dispatchEvent("click");
  await dialog.getByRole("button", { name: "Create trip", exact: true }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function cleanup() {
  await executeDatabase("delete from trips where name like 'Discovery browser %'; delete from users where email like 'discovery-%@example.test';");
}

test.beforeEach(() => executeDatabase("truncate table rate_limit_windows"));
test.afterAll(cleanup);

test("a traveler reviews grounded AI evidence and accepts a proposal into the wishlist", async ({ page, request }) => {
  test.setTimeout(240_000);
  await request.delete(`${MAILPIT_API_URL}/api/v1/messages`);
  const suffix = Date.now();
  const tripName = `Discovery browser ${suffix}`;
  const email = `discovery-${suffix}@example.test`;
  await executeDatabase(`insert into users (email, display_name, status) values ('${email}', 'Discovery owner', 'active') on conflict (email) do nothing;`);

  await signIn(page, request, email);
  await createTrip(page, tripName);
  await expect(page.getByRole("heading", { name: "Let AI find and explain the options" })).toBeVisible();
  await expect(page.getByText("AI discovery is unavailable until the server has an OpenAI API key and model.", { exact: false })).toBeVisible();
  await page.getByLabel("What should AI plan around?").fill("Food markets and gardens at an unhurried pace; avoid long walking days.");
  await page.getByRole("button", { name: "Save trip brief" }).click();
  await expect(page.getByLabel("What should AI plan around?")).toHaveValue(/Food markets and gardens/);

  const runId = "00000000-0000-4000-8000-000000003601";
  const googleEvidenceId = "00000000-0000-4000-8000-000000003602";
  const webEvidenceId = "00000000-0000-4000-8000-000000003603";
  const proposalId = "00000000-0000-4000-8000-000000003604";
  await executeDatabase(`
    update discovery_briefs set
      structured_brief = '{"interests":["food markets","gardens"],"pace":"unhurried","budget":null,"exclusions":["long walking days"],"areas":["Kyoto"]}'::jsonb,
      unresolved_questions = '[]'::jsonb
    where trip_id = (select id from trips where name = '${tripName}');
    insert into discovery_runs (id, trip_id, brief_version, policy_version, model_id, status, search_plan, error_code, created_by, completed_at)
      select '${runId}', trip.id, 1, 'discovery-v1', 'gpt-test', 'completed',
        '{"queries":["Kyoto food markets"],"areas":["Kyoto"],"categories":["market"],"exclusions":["long walks"],"dateRange":{"start":"2026-11-03","end":"2026-11-09"}}'::jsonb,
        null, member.user_id, now()
      from trips trip join trip_members member on member.trip_id = trip.id and member.role = 'owner'
      where trip.name = '${tripName}';
    insert into discovery_evidence (id, trip_id, run_id, evidence_kind, provider_place_id, source_url, title, attribution, observed_at, expires_at, facts)
      select '${googleEvidenceId}', trip.id, '${runId}', 'google-place', 'ChIJ-Nishiki-Market-E2E',
        'https://www.google.com/maps/search/?api=1&query_place_id=ChIJ-Nishiki-Market-E2E', 'Nishiki Market', 'Google Maps', now(), '2099-01-01T00:00:00Z',
        '{"provider":"google","providerPlaceId":"ChIJ-Nishiki-Market-E2E","name":"Nishiki Market","type":"activity","address":"Nakagyo Ward, Kyoto","latitude":35.005,"longitude":135.765,"timeZone":"Asia/Tokyo","sourceUrl":"https://www.google.com/maps/search/?api=1&query_place_id=ChIJ-Nishiki-Market-E2E","attribution":"Google Maps","observedAt":"2026-09-28T12:00:00.000Z","expiresAt":"2099-01-01T00:00:00.000Z"}'::jsonb
      from trips trip where trip.name = '${tripName}';
    insert into discovery_evidence (id, trip_id, run_id, evidence_kind, provider_place_id, source_url, title, attribution, observed_at, expires_at, facts)
      select '${webEvidenceId}', trip.id, '${runId}', 'web-source', null,
        'https://kyoto.example.test/nishiki', 'Official Nishiki Market guide', 'OpenAI web search source', now(), null, '{"sourceOnly":true}'::jsonb
      from trips trip where trip.name = '${tripName}';
    insert into candidate_proposals (id, trip_id, run_id, provider_place_id, name, place_type, address, latitude, longitude, source_url, recommendation, matched_needs, tradeoffs, unknowns, confidence)
      select '${proposalId}', trip.id, '${runId}', 'ChIJ-Nishiki-Market-E2E', 'Nishiki Market', 'activity', 'Nakagyo Ward, Kyoto', 35.005, 135.765,
        'https://www.google.com/maps/search/?api=1&query_place_id=ChIJ-Nishiki-Market-E2E',
        'A compact food-market stop matching the trip focus.', '["food markets","unhurried half-day"]'::jsonb, '["busy around lunch"]'::jsonb, '["holiday opening hours"]'::jsonb, 'medium'
      from trips trip where trip.name = '${tripName}';
    insert into candidate_proposal_evidence (proposal_id, evidence_id) values
      ('${proposalId}', '${googleEvidenceId}'), ('${proposalId}', '${webEvidenceId}');
  `);

  await page.reload();
  const proposal = page.getByRole("article", { name: "AI proposal Nishiki Market" });
  await expect(proposal).toBeVisible();
  await expect(proposal.getByText("A compact food-market stop matching the trip focus.")).toBeVisible();
  await expect(proposal.getByRole("link", { name: "Official Nishiki Market guide" })).toHaveAttribute("href", "https://kyoto.example.test/nishiki");
  await proposal.getByRole("button", { name: "Accept into wishlist" }).click();
  await expect(proposal.getByText("Added to wishlist")).toBeVisible();

  const wishlist = page.getByRole("region", { name: "Shared place wishlist" });
  await expect(wishlist.getByRole("heading", { name: "Nishiki Market" })).toBeVisible();
  await expect(wishlist.getByText("AI proposal", { exact: false })).toBeVisible();
});
