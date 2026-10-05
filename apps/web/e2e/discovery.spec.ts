import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test, type APIRequestContext, type Page, type Route } from "@playwright/test";
import { isRecord } from "@along-the-way/contracts/private-trips";
import { fillTripFlights } from "./travel-support";

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
  await page.getByLabel("電子郵件").fill(email);
  await page.getByRole("button", { name: "寄登入連結給我" }).click();
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
  await expect(page.getByText(`登入帳號：${email}`)).toBeVisible();
}

async function createTrip(page: Page, name: string) {
  await page.getByRole("button", { name: "建立旅程" }).click();
  const dialog = page.getByRole("dialog", { name: "建立旅程" });
  await dialog.getByLabel("旅程名稱").fill(name);
  await dialog.getByRole("button", { name: "選擇日期範圍" }).click();
  const year = 2026;
  const month = 11;
  const current = new Date();
  const offset = year * 12 + month - 1 - (current.getFullYear() * 12 + current.getMonth());
  const direction = offset >= 0 ? ".rdp-button_next" : ".rdp-button_previous";
  for (let index = 0; index < Math.abs(offset); index += 1) {
    await page.locator(direction).click();
  }
  const label = (day: number) => new Date(year, month - 1, day).toLocaleDateString("zh-TW");
  await page.locator(`[data-day="${label(3)}"]`).click();
  await page.locator(`[data-day="${label(9)}"]`).click();
  await dialog.getByLabel("新增國家").fill("Japan");
  await page.getByRole("option", { name: /\(JP\)/ }).dispatchEvent("click");
  await fillTripFlights(dialog, "2026-11-03", "2026-11-09");
  await dialog.getByRole("button", { name: "建立旅程", exact: true }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function openTab(page: Page, name: "AI 找地點" | "想去清單") {
  await page.getByRole("tab", { name, exact: true }).click();
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
  await openTab(page, "AI 找地點");
  await expect(page.getByRole("heading", { name: "讓 AI 尋找選項並說明原因" })).toBeVisible();
  await expect(page.getByText("伺服器設定 AI 服務金鑰與模型後，才能使用 AI 研究。現有旅程資料仍可使用。", { exact: false })).toBeVisible();
  const briefText = "Food markets and gardens at an unhurried pace; avoid long walking days.";

  const runId = "00000000-0000-4000-8000-000000003601";
  const googleEvidenceId = "00000000-0000-4000-8000-000000003602";
  const webEvidenceId = "00000000-0000-4000-8000-000000003603";
  const proposalId = "00000000-0000-4000-8000-000000003604";
  await executeDatabase(`
    insert into discovery_briefs (trip_id, original_text, structured_brief, unresolved_questions, updated_by)
      select trip.id, '${briefText}',
        '{"interests":["food markets","gardens"],"pace":"unhurried","budget":null,"exclusions":["long walking days"],"areas":["Kyoto"]}'::jsonb,
        '[]'::jsonb, member.user_id
      from trips trip join trip_members member on member.trip_id = trip.id and member.role = 'owner'
      where trip.name = '${tripName}';
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
  await openTab(page, "AI 找地點");
  const proposal = page.getByRole("article", { name: "AI 推薦：Nishiki Market" });
  await expect(proposal).toBeVisible();
  await expect(proposal.getByText("A compact food-market stop matching the trip focus.")).toBeVisible();
  await expect(proposal.getByRole("link", { name: "Official Nishiki Market guide" })).toHaveAttribute("href", "https://kyoto.example.test/nishiki");
  // A run from before the quality checks still reads, and its card links to the place's own Google Maps page.
  await expect(proposal.getByRole("link", { name: "在 Google Maps 看照片" }))
    .toHaveAttribute("href", /query_place_id=ChIJ-Nishiki-Market-E2E/);
  await expect(proposal.getByRole("button", { name: "投票", exact: true })).toHaveCount(0);
  await executeDatabase(`
    insert into users (email, display_name, status) values ('discovery-member-${suffix}@example.test', 'Discovery member', 'active');
    insert into trip_members (trip_id, user_id, role)
      select trip.id, member.id, 'editor' from trips trip cross join users member
      where trip.name = '${tripName}' and member.email = 'discovery-member-${suffix}@example.test';
  `);
  await page.reload();
  await openTab(page, "AI 找地點");
  await proposal.getByRole("button", { name: "投票", exact: true }).click();
  await expect(proposal.getByRole("button", { name: "已投票", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(proposal.getByText("1 票", { exact: true })).toBeVisible();
  await proposal.getByRole("button", { name: "加入想去清單" }).click();
  await expect(proposal.getByText("已加入想去清單")).toBeVisible();
  await openTab(page, "想去清單");

  const wishlist = page.getByRole("region", { name: "共享地點想去清單" });
  await expect(wishlist.getByRole("heading", { name: "Nishiki Market" })).toBeVisible();
  await expect(wishlist.getByText("AI 推薦", { exact: false })).toBeVisible();
  await expect(wishlist.getByRole("link", { name: "在 Google Maps 看照片" }))
    .toHaveAttribute("href", /query_place_id=ChIJ-Nishiki-Market-E2E/);
  await expect(wishlist.getByText("1 票", { exact: true })).toBeVisible();
  await expect(wishlist.getByRole("button", { name: "已投票", exact: true })).toHaveAttribute("aria-pressed", "true");
  await wishlist.getByRole("button", { name: "撤回我的紀錄" }).click();
  await expect(wishlist.getByRole("heading", { name: "Nishiki Market" })).toHaveCount(0);
  await openTab(page, "AI 找地點");
  await expect(proposal.getByText("已從想去清單移除", { exact: true })).toBeVisible();
  await expect(proposal.getByText("已加入想去清單", { exact: true })).toHaveCount(0);
});

test("research and feedback explain missing AI configuration without sending anything", async ({ page, request }) => {
  test.setTimeout(120_000);
  await request.delete(`${MAILPIT_API_URL}/api/v1/messages`);
  const suffix = Date.now();
  const tripName = `Discovery browser unavailable ${suffix}`;
  const email = `discovery-unavailable-${suffix}@example.test`;
  await executeDatabase(`insert into users (email, display_name, status) values ('${email}', 'Discovery owner', 'active') on conflict (email) do nothing;`);
  await signIn(page, request, email);
  await createTrip(page, tripName);
  await openTab(page, "AI 找地點");
  await expect(page.getByText("伺服器設定 AI 服務金鑰與模型後，才能使用 AI 研究。現有旅程資料仍可使用。", { exact: false })).toBeVisible();

  const discoveryWrites: string[] = [];
  page.on("request", (sent) => {
    if (sent.url().includes("/discovery") && sent.method() !== "GET") discoveryWrites.push(`${sent.method()} ${sent.url()}`);
  });

  const brief = page.getByRole("region", { name: "旅程研究需求" });
  const briefText = "Gardens and food markets, unhurried pace.";
  await brief.getByLabel("AI 規劃時該考量什麼？").fill(briefText);
  await expect(brief.getByRole("button")).toHaveCount(1);
  await brief.getByRole("button", { name: "尋找候選地點" }).click();
  const researchAlert = brief.getByRole("alert");
  await expect(researchAlert).toContainText("無法進行 AI 研究");
  await expect(researchAlert).toContainText("AI 服務金鑰與模型");
  await expect(researchAlert).toContainText("Google Maps 金鑰");
  await expect(brief.getByLabel("AI 規劃時該考量什麼？")).toHaveValue(briefText);

  const feedback = page.getByRole("region", { name: "研究意見" });
  await feedback.getByLabel("意見").fill("Fewer temples, more markets.");
  await feedback.getByRole("button", { name: "解讀意見" }).click();
  await expect(feedback.getByRole("alert")).toContainText("無法解讀意見");
  await expect(feedback.getByRole("alert")).toContainText("AI 服務金鑰與模型");
  await expect(feedback.getByLabel("意見")).toHaveValue("Fewer temples, more markets.");

  expect(discoveryWrites).toEqual([]);
  await page.reload();
  await page.getByRole("button", { name: new RegExp(tripName) }).click();
  await openTab(page, "AI 找地點");
  await expect(page.getByLabel("AI 規劃時該考量什麼？")).toHaveValue("");
});

test("one Find candidates action saves changed text, researches the saved version, and reports failures beside its button", async ({ page, request }) => {
  test.setTimeout(120_000);
  await request.delete(`${MAILPIT_API_URL}/api/v1/messages`);
  const suffix = Date.now();
  const tripName = `Discovery browser sequence ${suffix}`;
  const email = `discovery-sequence-${suffix}@example.test`;
  await executeDatabase(`insert into users (email, display_name, status) values ('${email}', 'Discovery owner', 'active') on conflict (email) do nothing;`);
  await signIn(page, request, email);
  await createTrip(page, tripName);

  // The test server has no AI credentials; report services as configured so the
  // client sequencing is exercised, while the real server still persists the brief.
  let available = { modelAvailable: true, placeProviderAvailable: true };
  const withServices = async (route: Route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    if (isRecord(body) && isRecord(body.discovery)) Object.assign(body.discovery, available);
    await route.fulfill({ response, json: body });
  };
  await page.route(/\/api\/trips\/[^/]+\/discovery$/, withServices);
  let failSave = true;
  await page.route(/\/discovery\/brief$/, async (route) => {
    if (!failSave) return withServices(route);
    failSave = false;
    await route.fulfill({ status: 409, json: { error: { code: "conflict", message: "Version conflict; current version is 1", currentVersion: 1 } } });
  });
  const generateBodies: unknown[] = [];
  await page.route(/\/discovery\/generate$/, async (route) => {
    generateBodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 503, json: { error: { code: "model_unavailable", message: "AI discovery is temporarily unavailable" } } });
  });
  const writes: string[] = [];
  page.on("request", (sent) => {
    if (sent.url().includes("/discovery/") && sent.method() !== "GET") writes.push(new URL(sent.url()).pathname.split("/").at(-1)!);
  });
  await page.reload();
  await page.getByRole("button", { name: new RegExp(tripName) }).click();
  await openTab(page, "AI 找地點");

  const brief = page.getByRole("region", { name: "旅程研究需求" });
  const text = brief.getByLabel("AI 規劃時該考量什麼？");
  const find = brief.getByRole("button", { name: "尋找候選地點" });
  await text.fill("Food markets and gardens.");

  // A failed save stops before research and keeps the text.
  await find.click();
  await expect(brief.getByRole("alert")).toContainText("資料已變更，無法完成操作。");
  await expect(text).toHaveValue("Food markets and gardens.");
  expect(writes).toEqual(["brief"]);

  // A successful save is followed by research of the saved version; its failure stays beside the button.
  await find.click();
  await expect(brief.getByRole("alert")).toContainText("AI 模型目前無法使用，請稍後再試。");
  await expect(text).toHaveValue("Food markets and gardens.");
  expect(writes).toEqual(["brief", "brief", "generate"]);
  expect(generateBodies).toEqual([{ expectedBriefVersion: 1 }]);

  // Unchanged saved text is researched without saving again.
  await find.click();
  await expect(brief.getByRole("alert")).toContainText("AI 模型目前無法使用，請稍後再試。");
  expect(writes).toEqual(["brief", "brief", "generate", "generate"]);

  // Only the missing service is named, and nothing is sent.
  available = { modelAvailable: true, placeProviderAvailable: false };
  await page.reload();
  await page.getByRole("button", { name: new RegExp(tripName) }).click();
  await openTab(page, "AI 找地點");
  await brief.getByRole("button", { name: "尋找候選地點" }).click();
  await expect(brief.getByRole("alert")).toContainText("Google Maps 金鑰");
  await expect(brief.getByRole("alert")).not.toContainText("AI 服務金鑰與模型");
  expect(writes).toHaveLength(4);

  // Research again explains missing configuration beside itself without sending anything.
  await executeDatabase(`
    insert into discovery_runs (trip_id, brief_version, policy_version, model_id, status, search_plan, error_code, created_by, completed_at)
      select trip.id, 1, 'discovery-v1', 'gpt-test', 'completed',
        '{"queries":["Kyoto markets"],"areas":["Kyoto"],"categories":["market"],"exclusions":[],"dateRange":{"start":"2026-11-03","end":"2026-11-09"}}'::jsonb,
        null, member.user_id, now()
      from trips trip join trip_members member on member.trip_id = trip.id and member.role = 'owner'
      where trip.name = '${tripName}';
  `);
  available = { modelAvailable: false, placeProviderAvailable: true };
  await page.reload();
  await page.getByRole("button", { name: new RegExp(tripName) }).click();
  await openTab(page, "AI 找地點");
  const research = page.getByRole("region", { name: "讓 AI 尋找選項並說明原因" });
  await research.getByRole("button", { name: "重新研究" }).click();
  await expect(research.getByRole("alert").first()).toContainText("AI 服務金鑰與模型");
  await expect(brief.getByRole("alert")).toHaveCount(0);
  expect(writes).toHaveLength(4);
});
