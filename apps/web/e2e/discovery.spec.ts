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
  await page.getByRole("button", { name: /切換旅程$/ }).click();
  await page.getByRole("dialog", { name: "切換旅程" }).getByRole("button", { name: "建立旅程" }).click();
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
  await expect(page.getByRole("button", { name: new RegExp(`${name}，切換旅程`) })).toBeVisible();
}

async function openTab(page: Page, name: "AI 找地點" | "想去清單") {
  await page.getByRole("tab", { name: "地點", exact: true }).click();
  await page.getByRole("tab", { name: name === "AI 找地點" ? "AI 建議" : "想去", exact: true }).click();
}

function proposalEntry(page: Page, name: string) {
  return page.locator("tbody[data-discovery-proposal]").filter({
    has: page.getByRole("row", { name: `AI 推薦：${name}`, exact: true }),
  });
}

function wishlistEntry(page: Page, name: string) {
  return page.locator("tbody[data-wishlist-place]").filter({
    has: page.getByRole("row", { name, exact: true }),
  });
}

async function cleanup() {
  // Trips now start with flight endpoints, whose country-stop references block a direct trip delete.
  await executeDatabase("delete from itinerary_items where trip_id in (select id from trips where name like 'Discovery browser %'); delete from trips where name like 'Discovery browser %'; delete from users where email like 'discovery-%@example.test';");
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
  const legacyProposalId = "00000000-0000-4000-8000-000000003605";
  const legacyRecommendation = "This older recommendation is deliberately long enough to be clamped in the table row, while its complete wording remains available after opening the details.";
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
    insert into candidate_proposals (id, trip_id, run_id, provider_place_id, name, place_type, address, latitude, longitude, source_url, recommendation, recommendation_sentences, matched_needs, tradeoffs, unknowns, confidence)
      select '${proposalId}', trip.id, '${runId}', 'ChIJ-Nishiki-Market-E2E', 'Nishiki Market', 'activity', 'Nakagyo Ward, Kyoto', 35.005, 135.765,
        'https://www.google.com/maps/search/?api=1&query_place_id=ChIJ-Nishiki-Market-E2E',
        'A compact food-market stop matching the trip focus.',
        '[{"text":"A compact food-market stop matching the trip focus.","evidenceIds":["${webEvidenceId}"]},{"text":"Visit outside the lunch rush for an easier pace.","evidenceIds":[]}]'::jsonb,
        '["food markets","unhurried half-day"]'::jsonb, '["busy around lunch"]'::jsonb, '["holiday opening hours"]'::jsonb, 'medium'
      from trips trip where trip.name = '${tripName}';
    insert into candidate_proposals (id, trip_id, run_id, provider_place_id, name, place_type, address, recommendation, matched_needs, tradeoffs, unknowns, confidence)
      select '${legacyProposalId}', trip.id, '${runId}', 'ChIJ-Legacy-Garden-E2E', 'Legacy Garden', 'activity', 'Northern Kyoto',
        '${legacyRecommendation}', '["gardens"]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'medium'
      from trips trip where trip.name = '${tripName}';
    insert into candidate_proposal_evidence (proposal_id, evidence_id) values
      ('${proposalId}', '${googleEvidenceId}'), ('${proposalId}', '${webEvidenceId}');
    insert into discovery_feedback (trip_id, proposal_id, actor_id, original_text, interpretation, status, decided_at)
      select trip.id, '${proposalId}', member.user_id, 'Historical market feedback',
        '{"interests":[],"exclusions":["crowds"],"pace":null,"budget":null,"summary":"Visit at a quieter time."}'::jsonb,
        'confirmed', now()
      from trips trip join trip_members member on member.trip_id = trip.id and member.role = 'owner'
      where trip.name = '${tripName}';
  `);

  await page.reload();
  await openTab(page, "AI 找地點");
  const proposal = proposalEntry(page, "Nishiki Market");
  await expect(page.getByRole("row", { name: "AI 推薦：Nishiki Market", exact: true })).toBeVisible();
  await expect(proposal.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "研究意見" }).getByLabel("意見", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "研究意見" }).getByText("針對：Nishiki Market", { exact: true })).toBeVisible();
  await expect(proposal.getByText("A compact food-market stop matching the trip focus.")).toBeVisible();
  await expect(page.getByRole("row", { name: "AI 推薦：Nishiki Market", exact: true }).getByRole("link", { name: "Official Nishiki Market guide" })).toHaveText(/^\[2\]/);
  const legacyProposal = proposalEntry(page, "Legacy Garden");
  await expect(page.getByRole("row", { name: "AI 推薦：Legacy Garden", exact: true }).getByText(legacyRecommendation, { exact: true })).toBeVisible();
  await legacyProposal.getByRole("button", { name: "查看 Legacy Garden 的詳情", exact: true }).click();
  const legacyDetails = page.getByRole("complementary", { name: "Legacy Garden 的詳情" });
  await expect(legacyDetails.getByRole("heading", { name: "Legacy Garden 的詳情" })).toBeFocused();
  await expect(legacyDetails.getByText(legacyRecommendation, { exact: true })).toBeVisible();
  await legacyDetails.getByRole("button", { name: "關閉 AI 建議詳情" }).click();
  await expect(legacyProposal.getByRole("button", { name: "查看 Legacy Garden 的詳情", exact: true })).toBeFocused();
  const rejectLegacy = legacyProposal.getByRole("button", { name: "不要再推薦" });
  await rejectLegacy.click();
  const rejectDialog = page.getByRole("dialog", { name: "不要再推薦「Legacy Garden」？" });
  await expect(rejectDialog).toContainText("未來的研究不會再推薦");
  await rejectDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(legacyProposal.getByText("已設為不要再推薦", { exact: true })).toHaveCount(0);
  await rejectLegacy.click();
  await page.getByRole("dialog", { name: "不要再推薦「Legacy Garden」？" }).getByRole("button", { name: "確定不要再推薦" }).click();
  await expect(legacyProposal.getByText("已設為不要再推薦", { exact: true })).toBeVisible();
  await expect(proposal.getByText("信心程度", { exact: false })).toHaveCount(0);
  await expect(page.getByRole("table", { name: "AI 候選地點清單" }).getByRole("columnheader", { name: "票數" })).toHaveCount(0);
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 720 });
    await expect(proposal.getByRole("cell", { name: "活動", exact: true })).toBeVisible();
  }
  await proposal.getByRole("button", { name: "查看 Nishiki Market 的詳情", exact: true }).click();
  const nishikiDetails = page.getByRole("complementary", { name: "Nishiki Market 的詳情" });
  await expect(nishikiDetails.getByRole("heading", { name: "Nishiki Market 的詳情" })).toBeFocused();
  const recommendationCitation = nishikiDetails.getByRole("listitem").filter({ hasText: "A compact food-market stop matching the trip focus." }).getByRole("link", { name: "Official Nishiki Market guide" });
  await expect(recommendationCitation).toHaveText(/^\[2\]/);
  const evidenceCitation = nishikiDetails.getByText("佐證資料", { exact: true }).locator("..").getByRole("link", { name: "Official Nishiki Market guide" });
  await expect(evidenceCitation).toHaveText(/^\[2\]/);
  await expect(evidenceCitation).toHaveAttribute("href", "https://kyoto.example.test/nishiki");
  await expect(nishikiDetails.getByText("A compact food-market stop matching the trip focus.", { exact: true })).toBeVisible();
  await expect(nishikiDetails.getByText("Visit outside the lunch rush for an easier pace.", { exact: true })).toBeVisible();
  await expect(nishikiDetails.getByText("AI 推論，未查證", { exact: true })).toBeVisible();
  await expect(nishikiDetails.getByRole("link", { name: "在 Google Maps 看照片" }))
    .toHaveAttribute("href", /query_place_id=ChIJ-Nishiki-Market-E2E/);
  await nishikiDetails.getByRole("button", { name: "關閉 AI 建議詳情" }).click();
  await expect(proposal.getByRole("button", { name: "查看 Nishiki Market 的詳情", exact: true })).toBeFocused();
  await expect(proposal.getByRole("button", { name: "投票", exact: true })).toHaveCount(0);
  await executeDatabase(`
    insert into users (email, display_name, status) values ('discovery-member-${suffix}@example.test', 'Discovery member', 'active');
    insert into trip_members (trip_id, user_id, role)
      select trip.id, member.id, 'editor' from trips trip cross join users member
      where trip.name = '${tripName}' and member.email = 'discovery-member-${suffix}@example.test';
  `);
  await page.reload();
  await openTab(page, "AI 找地點");
  await proposal.getByRole("button", { name: "查看 Nishiki Market 的詳情", exact: true }).click();
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 720 });
    const proposalWrapperBox = await page.locator("[data-discovery-table-wrapper]").boundingBox();
    expect(proposalWrapperBox).not.toBeNull();
    for (const action of await proposal.getByRole("button").all()) {
      if (!await action.isVisible()) continue;
      const actionBox = await action.boundingBox();
      expect(actionBox).not.toBeNull();
      expect(actionBox!.x).toBeGreaterThanOrEqual(proposalWrapperBox!.x);
      expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(proposalWrapperBox!.x + proposalWrapperBox!.width);
    }
  }
  await page.getByRole("complementary", { name: "Nishiki Market 的詳情" }).getByRole("button", { name: "關閉 AI 建議詳情" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const proposalTable = page.getByRole("table", { name: "AI 候選地點清單" });
  await expect(proposalTable.getByRole("columnheader", { name: "類別" })).toBeHidden();
  await expect(proposalTable.getByRole("columnheader", { name: "票數" })).toHaveCount(1);
  await expect(proposalTable.getByRole("columnheader", { name: "動作" })).toHaveCount(1);
  await expect(proposal.getByText("活動・busy around lunch", { exact: true })).toBeVisible();
  await expect(page.getByRole("row", { name: "AI 推薦：Nishiki Market", exact: true }).getByRole("button", { name: "加入想去清單" })).toBeVisible();
  expect((await proposal.getByRole("button", { name: "加入想去清單" }).boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const mobileDetailTrigger = proposal.getByRole("button", { name: "查看 Nishiki Market 的詳情", exact: true });
  expect((await mobileDetailTrigger.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await mobileDetailTrigger.click();
  await expect(page.getByRole("dialog", { name: "Nishiki Market 的詳情" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Nishiki Market 的詳情" }).getByRole("heading", { name: "Nishiki Market 的詳情" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(mobileDetailTrigger).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 720 });
  await proposal.getByRole("button", { name: "投票", exact: true }).click();
  await expect(proposal.getByRole("button", { name: "已投票", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(proposal.getByText("1 票", { exact: true })).toBeVisible();
  await proposal.getByRole("button", { name: "加入想去清單" }).click();
  await expect(proposal.getByRole("cell").filter({ hasText: "已加入想去清單" }).getByText("已加入想去清單", { exact: true })).toBeVisible();
  await expect(proposal.getByRole("button", { name: "從想去清單移除" })).toBeVisible();
  await openTab(page, "想去清單");

  const wishlist = page.getByRole("region", { name: "共享地點想去清單" });
  const wishlistPlace = wishlistEntry(page, "Nishiki Market");
  await expect(wishlist.getByRole("row", { name: "Nishiki Market", exact: true })).toBeVisible();
  await wishlistPlace.getByRole("button", { name: "查看 Nishiki Market 的詳情", exact: true }).click();
  const wishlistDetails = page.getByRole("complementary", { name: "Nishiki Market 的詳情" });
  await expect(wishlistDetails.getByText("AI 推薦", { exact: false })).toBeVisible();
  await expect(wishlistDetails.getByRole("link", { name: "在 Google Maps 看照片" }))
    .toHaveAttribute("href", /query_place_id=ChIJ-Nishiki-Market-E2E/);
  await expect(wishlistDetails.getByText("1 票", { exact: true })).toBeVisible();
  await expect(wishlistDetails.getByRole("button", { name: "已投票", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(wishlistDetails.getByRole("link", { name: "開啟原始來源" }))
    .toHaveAttribute("href", /query_place_id=ChIJ-Nishiki-Market-E2E/);
  await openTab(page, "AI 找地點");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("確定要把「Nishiki Market」移出想去清單嗎？票和天數安排會一起清除。");
    await dialog.accept();
  });
  await proposal.getByRole("button", { name: "從想去清單移除" }).click();
  await expect(proposal.getByRole("button", { name: "加入想去清單" })).toBeVisible();
  await expect(proposal.getByRole("button", { name: "不要再推薦" })).toBeVisible();
  await expect(proposal.getByRole("button", { name: "已投票", exact: true })).toHaveAttribute("aria-pressed", "true");
  await openTab(page, "想去清單");
  await expect(wishlist.getByRole("row", { name: "Nishiki Market", exact: true })).toHaveCount(0);
  await openTab(page, "AI 找地點");
  await proposal.getByRole("button", { name: "加入想去清單" }).click();
  await expect(proposal.getByRole("cell").filter({ hasText: "已加入想去清單" }).getByText("已加入想去清單", { exact: true })).toBeVisible();
  await expect(proposal.getByRole("button", { name: "從想去清單移除" })).toBeVisible();
  await openTab(page, "想去清單");
  await expect(wishlist.getByRole("row", { name: "Nishiki Market", exact: true })).toHaveCount(1);
  await expect(wishlist.getByRole("row", { name: "Nishiki Market", exact: true }).getByText("1 票", { exact: true })).toBeVisible();
  // Removing from the wishlist detail must refresh the AI tab and reopen the proposal.
  await wishlistPlace.getByRole("button", { name: "查看 Nishiki Market 的詳情", exact: true }).click();
  page.once("dialog", async (dialog) => dialog.accept());
  await page.getByRole("complementary", { name: "Nishiki Market 的詳情" }).getByRole("button", { name: "從想去清單移除" }).click();
  await expect(wishlist.getByRole("row", { name: "Nishiki Market", exact: true })).toHaveCount(0);
  await openTab(page, "AI 找地點");
  await expect(proposal.getByRole("button", { name: "加入想去清單" })).toBeVisible();
  await expect(proposal.getByRole("button", { name: "不要再推薦" })).toBeVisible();
  await expect(proposal.getByRole("button", { name: "已投票", exact: true })).toHaveAttribute("aria-pressed", "true");
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
  await expect(page.getByRole("button", { name: new RegExp(`${tripName}，切換旅程`) })).toBeVisible();
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
  let createConcurrentBrief = true;
  await page.route(/\/discovery\/brief$/, async (route) => {
    if (createConcurrentBrief) {
      createConcurrentBrief = false;
      const concurrent = await route.fetch({
        headers: { ...route.request().headers(), "idempotency-key": crypto.randomUUID() },
        postData: { ...route.request().postDataJSON(), originalText: "Architecture and temples." },
      });
      expect(concurrent.status()).toBe(200);
    }
    return withServices(route);
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
  await expect(page.getByRole("button", { name: new RegExp(`${tripName}，切換旅程`) })).toBeVisible();
  await openTab(page, "AI 找地點");

  const brief = page.getByRole("region", { name: "旅程研究需求" });
  const text = brief.getByLabel("AI 規劃時該考量什麼？");
  const find = brief.getByRole("button", { name: "尋找候選地點" });
  await text.fill("Food markets and gardens.");

  // A real concurrent save stops this stale request before research. Returning
  // to edit keeps the attempted text but adopts the freshly read brief version.
  await find.click();
  const conflict = page.locator("[data-conflict-panel]");
  await expect(conflict).toContainText("Architecture and temples.");
  await expect(conflict).toContainText("Food markets and gardens.");
  expect(writes).toEqual(["brief"]);
  await conflict.getByRole("button", { name: "返回編輯", exact: true }).click();
  await expect(text).toHaveValue("Food markets and gardens.");

  // A successful save is followed by research of the saved version; its failure stays beside the button.
  await find.click();
  await expect(brief.getByRole("alert")).toContainText("AI 模型目前無法使用，請稍後再試。");
  await expect(text).toHaveValue("Food markets and gardens.");
  expect(writes).toEqual(["brief", "brief", "generate"]);
  expect(generateBodies).toEqual([{ expectedBriefVersion: 2 }]);

  // Unchanged saved text is researched without saving again.
  await find.click();
  await expect(brief.getByRole("alert")).toContainText("AI 模型目前無法使用，請稍後再試。");
  expect(writes).toEqual(["brief", "brief", "generate", "generate"]);

  // Only the missing service is named, and nothing is sent.
  available = { modelAvailable: true, placeProviderAvailable: false };
  await page.reload();
  await expect(page.getByRole("button", { name: new RegExp(`${tripName}，切換旅程`) })).toBeVisible();
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
  await expect(page.getByRole("button", { name: new RegExp(`${tripName}，切換旅程`) })).toBeVisible();
  await openTab(page, "AI 找地點");
  const research = page.getByRole("region", { name: "讓 AI 尋找選項並說明原因" });
  await page.getByText("研究需求與設定", { exact: true }).click();
  await research.getByRole("button", { name: "重新研究" }).click();
  await expect(research.getByRole("alert").first()).toContainText("AI 服務金鑰與模型");
  await expect(brief.getByRole("alert")).toHaveCount(0);
  expect(writes).toHaveLength(4);
});

async function prepareConflictDiscovery(page: Page, request: APIRequestContext, kind: string) {
  const suffix = `${Date.now()}-${kind}`;
  const name = `Discovery browser review ${suffix}`;
  const email = `discovery-review-${suffix}@example.test`;
  await executeDatabase(`insert into users (email, display_name, status) values ('${email}', 'Review editor', 'active');`);
  await signIn(page, request, email);
  await createTrip(page, name);
  const trips = await (await page.request.get("/api/trips")).json();
  const tripId = trips.trips.find((trip: { name: string }) => trip.name === name).id as string;
  await executeDatabase(`
    insert into discovery_briefs (trip_id, original_text, structured_brief, unresolved_questions, updated_by)
      select trip.id, 'Original garden brief',
        '{"interests":["gardens"],"pace":null,"budget":null,"exclusions":[],"areas":["Kyoto"]}'::jsonb,
        '["Preferred walking pace?"]'::jsonb, member.user_id
      from trips trip join trip_members member on member.trip_id = trip.id and member.role = 'owner'
      where trip.id = '${tripId}';
  `);
  await page.route(/\/api\/trips\/[^/]+\/discovery$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    Object.assign(body.discovery, { modelAvailable: true, placeProviderAvailable: true });
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await expect(page.getByRole("button", { name: new RegExp(`${name}，切換旅程`) })).toBeVisible();
  await openTab(page, "AI 找地點");
  return { tripId, headers: { origin: new URL(page.url()).origin, "idempotency-key": crypto.randomUUID() } };
}

async function conflictQuestionAnswer(page: Page, request: APIRequestContext, kind: string) {
  const fixture = await prepareConflictDiscovery(page, request, kind);
  let replaceBrief = true;
  await page.route(/\/discovery\/brief\/questions$/, async (route) => {
    if (replaceBrief) {
      replaceBrief = false;
      const response = await page.request.put(`/api/trips/${fixture.tripId}/discovery/brief`, {
        headers: fixture.headers, data: { originalText: "Another member's new food brief", expectedVersion: 1 },
      });
      expect(response.status()).toBe(200);
    }
    await route.continue();
  });
  await page.getByLabel("Preferred walking pace?").fill("Keep my slow walking answer");
  await page.getByRole("button", { name: "儲存答案", exact: true }).click();
  const conflict = page.locator("[data-conflict-panel]");
  await expect(conflict).toContainText("Keep my slow walking answer");
  return { ...fixture, conflict };
}

test("question conflict return does not rebase and overwrite the unrelated brief", async ({ page, request }) => {
  const { tripId, conflict } = await conflictQuestionAnswer(page, request, "question-return");
  await conflict.getByRole("button", { name: "返回編輯", exact: true }).click();
  await expect(page.getByLabel("AI 規劃時該考量什麼？")).toHaveValue("Original garden brief");
  const attempted = page.waitForResponse((response) => response.url().includes("/discovery/") && response.request().method() !== "GET");
  await page.getByRole("button", { name: "尋找候選地點", exact: true }).click();
  await attempted;
  const saved = await (await page.request.get(`/api/trips/${tripId}/discovery`)).json();
  expect(saved.discovery.brief.originalText).toBe("Another member's new food brief");
});

test("a refused question reapply explains the domain error beside the conflict panel", async ({ page, request }) => {
  const { conflict } = await conflictQuestionAnswer(page, request, "question-reapply");
  const refused = page.waitForResponse((response) => response.url().endsWith("/brief/questions") && response.status() === 400);
  await conflict.getByRole("button", { name: "重新套用我的修改", exact: true }).click();
  await refused;
  await expect(conflict).toBeVisible();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("question");
  await expect(conflict).toContainText("Keep my slow walking answer");
});

for (const previousEdit of [false, true]) {
  test(`direct feedback confirmation compares its own target after prior edit=${previousEdit}`, async ({ page, request }) => {
    const { tripId, headers } = await prepareConflictDiscovery(page, request, `feedback-${previousEdit}`);
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    for (const [id, marker] of [[first, "Unrelated first feedback"], [second, "Target second feedback"]]) {
      await executeDatabase(`
        insert into discovery_feedback (id, trip_id, actor_id, original_text, interpretation, status)
          select '${id}', trip.id, member.user_id, '${marker}',
            '{"interests":[],"exclusions":[],"pace":null,"budget":null,"summary":"${marker} interpretation"}'::jsonb, 'pending'
          from trips trip join trip_members member on member.trip_id = trip.id and member.role = 'owner'
          where trip.id = '${tripId}';
      `);
    }
    await page.reload();
    await openTab(page, "AI 找地點");
    if (previousEdit) {
      const unrelated = page.getByRole("article").filter({ hasText: "Unrelated first feedback" });
      await unrelated.getByRole("button", { name: "修改解讀", exact: true }).click();
      await unrelated.getByRole("button", { name: "取消修改", exact: true }).click();
    }
    let confirmElsewhere = true;
    await page.route(`**/discovery/feedback/${second}/decision`, async (route) => {
      if (!confirmElsewhere) { await route.continue(); return; }
      confirmElsewhere = false;
      expect((await page.request.post(`/api/trips/${tripId}/discovery/feedback/${second}/decision`, {
        headers, data: { expectedVersion: 1, decision: "confirm", interpretation: {
          interests: [], exclusions: [], pace: null, budget: null, summary: "Updated target second feedback interpretation",
        } },
      })).status()).toBe(200);
      await route.continue();
    });
    await page.getByRole("article").filter({ hasText: "Target second feedback" }).getByRole("button", { name: "確認解讀", exact: true }).click();
    const conflict = page.locator("[data-conflict-panel]");
    await expect(conflict.getByRole("button", { name: "重新套用我的修改", exact: true })).toBeEnabled();
    await expect(conflict).toContainText("Target second feedback interpretation");
    await expect(conflict).toContainText("Updated target second feedback interpretation");
    await expect(conflict).not.toContainText("Unrelated first feedback");
  });
}

test("research after saving answers uses the saved aggregate version without another save", async ({ page, request }) => {
  const { tripId } = await prepareConflictDiscovery(page, request, "saved-answer-generation");
  // Only expose the controls: saves and generation still run against the real API.
  // With no model credentials, a valid generation reaches the model-unavailable
  // boundary instead of being rejected as a stale edit.
  await page.route(/\/discovery\/brief\/questions$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (isRecord(body) && isRecord(body.discovery)) {
      Object.assign(body.discovery, { modelAvailable: true, placeProviderAvailable: true });
    }
    await route.fulfill({ response, json: body });
  });
  await page.getByLabel("Preferred walking pace?").fill("Slow walking");
  const savedAnswers = page.waitForResponse((response) => response.url().endsWith("/brief/questions") && response.request().method() === "PUT");
  await page.getByRole("button", { name: "儲存答案", exact: true }).click();
  const saved = await savedAnswers;
  expect(saved.status()).toBe(200);
  expect((await saved.json()).discovery.brief.version).toBe(2);

  const writes: string[] = [];
  page.on("request", (sent) => {
    if (sent.url().includes("/discovery/") && sent.method() !== "GET") writes.push(new URL(sent.url()).pathname.split("/").at(-1)!);
  });
  const generated = page.waitForResponse((response) => response.url().endsWith("/discovery/generate"));
  await page.getByRole("button", { name: "尋找候選地點", exact: true }).click();
  const response = await generated;
  expect(response.status(), await response.text()).toBe(503);
  expect((await response.json()).error.code).toBe("model_unavailable");
  expect(response.request().postDataJSON()).toEqual({ expectedBriefVersion: 2 });
  expect(writes).toEqual(["generate"]);
  await expect(page.getByRole("region", { name: "旅程研究需求" }).getByRole("alert")).toContainText("AI 模型目前無法使用");
  const current = (await (await page.request.get(`/api/trips/${tripId}/discovery`)).json()).discovery.brief;
  expect(current.originalText).toBe("Original garden brief");
  expect(current.questionAnswers).toEqual([{ question: "Preferred walking pace?", answer: "Slow walking" }]);
});

test("accepting a brief conflict preserves an unrelated feedback edit until it is saved", async ({ page, request }) => {
  const { tripId, headers } = await prepareConflictDiscovery(page, request, "accept-brief-keep-feedback");
  const feedbackId = crypto.randomUUID();
  await executeDatabase(`
    insert into discovery_feedback (id, trip_id, actor_id, original_text, interpretation, status)
      select '${feedbackId}', trip.id, member.user_id, 'Independent feedback',
        '{"interests":[],"exclusions":[],"pace":null,"budget":null,"summary":"Saved feedback summary"}'::jsonb, 'pending'
      from trips trip join trip_members member on member.trip_id = trip.id and member.role = 'owner'
      where trip.id = '${tripId}';
  `);
  await page.reload();
  await openTab(page, "AI 找地點");
  const feedback = page.getByRole("article").filter({ hasText: "Independent feedback" });
  await feedback.getByRole("button", { name: "修改解讀", exact: true }).click();
  await feedback.getByLabel("摘要").fill("Unsaved feedback summary");
  await page.getByLabel("AI 規劃時該考量什麼？").fill("My separate brief edit");

  let replaceBrief = true;
  await page.route(/\/discovery\/brief$/, async (route) => {
    if (replaceBrief) {
      replaceBrief = false;
      const response = await page.request.put(`/api/trips/${tripId}/discovery/brief`, {
        headers, data: { originalText: "Another member's accepted brief", expectedVersion: 1 },
      });
      expect(response.status()).toBe(200);
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "尋找候選地點", exact: true }).click();
  const conflict = page.locator("[data-conflict-panel]");
  await expect(conflict).toContainText("My separate brief edit");
  await expect(conflict).toContainText("Another member's accepted brief");
  await conflict.getByRole("button", { name: "接受目前版本", exact: true }).click();
  await expect(page.getByLabel("AI 規劃時該考量什麼？")).toHaveValue("Another member's accepted brief");
  // The editor may remain open; if it was closed, reopening must not reveal a lost draft.
  const reopen = feedback.getByRole("button", { name: "修改解讀", exact: true });
  if (await reopen.isVisible()) await reopen.click();
  await expect(feedback.getByLabel("摘要")).toHaveValue("Unsaved feedback summary");

  const confirmed = page.waitForResponse((response) => response.url().endsWith(`/feedback/${feedbackId}/decision`));
  await feedback.getByRole("button", { name: "確認並套用修改", exact: true }).click();
  expect((await confirmed).status()).toBe(200);
  await expect(feedback.getByLabel("摘要")).toHaveCount(0);
  const current = (await (await page.request.get(`/api/trips/${tripId}/discovery`)).json()).discovery;
  expect(current.feedback.find((entry: { id: string }) => entry.id === feedbackId).interpretation.summary).toBe("Unsaved feedback summary");
  expect(current.brief.originalText).toBe("Another member's accepted brief");
});
