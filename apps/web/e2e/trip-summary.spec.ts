import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import {
  isRecord,
  parseTripListResponse,
} from "@along-the-way/contracts/private-trips";
import { fillTripFlights } from "./travel-support";

const execFileAsync = promisify(execFile);
const mailpit = process.env.MAILPIT_API_URL ?? "http://127.0.0.1:8025";

interface MailpitMessage {
  id: string;
  recipients: string[];
  subject: string;
}

interface TripInput {
  countryStops: Array<{ code: string; query: string }>;
  endDate: string;
  name: string;
  startDate: string;
}

function mailpitMessages(value: unknown): MailpitMessage[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new Error("Mailpit returned an invalid message list");
  }
  return value.messages.map((message) => {
    if (
      !isRecord(message) ||
      typeof message.ID !== "string" ||
      typeof message.Subject !== "string" ||
      !Array.isArray(message.To)
    ) {
      throw new Error("Mailpit returned an invalid message");
    }
    const recipients = message.To.map((recipient) => {
      if (!isRecord(recipient) || typeof recipient.Address !== "string") {
        throw new Error("Mailpit returned an invalid recipient");
      }
      return recipient.Address;
    });
    return {
      id: message.ID,
      recipients,
      subject: message.Subject,
    };
  });
}

function mailpitText(value: unknown) {
  if (!isRecord(value) || typeof value.Text !== "string") {
    throw new Error("Mailpit returned an invalid message body");
  }
  return value.Text;
}

function linkToken(link: string, name: "magicToken" | "inviteToken") {
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get(name);
  if (!token) throw new Error(`${name} was missing from the email link`);
  return token;
}

async function emailLink(
  request: APIRequestContext,
  recipient: string,
  subject: string,
) {
  let messageId = "";
  await expect
    .poll(
      async () => {
        const response = await request.get(`${mailpit}/api/v1/messages`);
        messageId =
          mailpitMessages(await response.json()).find(
            (message) =>
              message.subject.includes(subject) &&
              message.recipients.includes(recipient),
          )?.id ?? "";
        return messageId;
      },
      { timeout: 15_000 },
    )
    .not.toBe("");
  const detail = await request.get(`${mailpit}/api/v1/message/${messageId}`);
  const link = mailpitText(await detail.json()).match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error(`Email for ${recipient} omitted its link`);
  return link;
}

async function openEmailLink(page: Page, link: string) {
  await page.goto(link);
}

async function signIn(page: Page, request: APIRequestContext, email: string) {
  await page.getByLabel("電子郵件").fill(email);
  await page.getByRole("button", { name: "寄送登入連結" }).click();
  await expect(page.getByRole("status")).toContainText(
    `如果 ${email} 可以登入`,
  );
  await openEmailLink(
    page,
    await emailLink(request, email, "登入 Along the Way"),
  );
  await expect(page.getByRole("button", { name: /切換旅程$/ })).toBeVisible();
}

function localDateLabel(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year!, month! - 1, day!).toLocaleDateString("zh-TW");
}

async function selectDateRange(
  page: Page,
  dialog: ReturnType<Page["getByRole"]>,
  startDate: string,
  endDate: string,
) {
  await dialog.getByRole("button", { name: "選擇日期範圍" }).click();
  const [year, month] = startDate.split("-").map(Number);
  const current = new Date();
  const monthOffset = year! * 12 + month! - 1 -
    (current.getFullYear() * 12 + current.getMonth());
  const direction = monthOffset >= 0 ? ".rdp-button_next" : ".rdp-button_previous";
  for (let step = 0; step < Math.abs(monthOffset); step += 1) {
    await page.locator(direction).click();
  }
  await page.locator(`[data-day="${localDateLabel(startDate)}"]`).click();
  await page.locator(`[data-day="${localDateLabel(endDate)}"]`).click();
  await page.getByRole("button", { name: "確定", exact: true }).click();
}

async function openMembers(page: Page) {
  await page.getByRole("tab", { name: "成員", exact: true }).click();
}

async function createTrip(
  page: Page,
  input: TripInput,
  beforeSubmit?: (dialog: ReturnType<Page["getByRole"]>) => Promise<void>,
) {
  await page.getByRole("button", { name: /切換旅程$/ }).click();
  await page.getByRole("dialog", { name: "切換旅程" }).getByRole("button", { name: "建立旅程" }).click();
  const dialog = page.getByRole("dialog", { name: "建立旅程" });
  await dialog.getByLabel("旅程名稱").fill(input.name);
  await selectDateRange(page, dialog, input.startDate, input.endDate);
  await dialog.getByRole("button", { name: "下一步" }).click();
  for (const [index, stop] of input.countryStops.entries()) {
    const search = dialog.getByLabel("新增國家");
    await search.fill(stop.query);
    const option = page.getByRole("option", { name: new RegExp(`\\(${stop.code}\\)`) });
    await expect(option).toBeVisible();
    await option.dispatchEvent("click");
    await expect(
      dialog.locator('section[aria-labelledby="country-route-heading"] li'),
    ).toHaveCount(index + 1);
  }
  await beforeSubmit?.(dialog);
  const preservedRouteCount = await dialog.locator('section[aria-labelledby="country-route-heading"] li').count();
  await dialog.getByRole("button", { name: "上一步" }).click();
  await expect(dialog.getByLabel("旅程名稱")).toHaveValue(input.name);
  await expect(dialog.getByRole("button", { name: new RegExp(input.startDate.replaceAll("-", "/")) })).toBeVisible();
  await dialog.getByRole("button", { name: "下一步" }).click();
  await expect(dialog.locator('section[aria-labelledby="country-route-heading"] li')).toHaveCount(preservedRouteCount);
  await dialog.getByRole("button", { name: "下一步" }).click();
  await expect(dialog.getByRole("heading", { name: "步驟 3 / 3・去回程航班" })).toBeFocused();
  await fillTripFlights(dialog, input.startDate, input.endDate);
  await dialog.getByRole("button", { name: "建立旅程", exact: true }).click();
  await expect(page.getByRole("button", { name: new RegExp(`${input.name}，切換旅程`) })).toBeVisible();
  await openMembers(page);
}

async function inviteEditor(
  page: Page,
  request: APIRequestContext,
  email: string,
) {
  await openMembers(page);
  await page.getByLabel("透過電子郵件邀請編輯者").fill(email);
  await page.getByRole("button", { name: "寄出邀請" }).click();
  await expect(page.getByRole("status").filter({ hasText: email })).toBeVisible();
  return emailLink(request, email, "邀請你加入「大阪京都家庭旅行」");
}

async function acceptEditor(
  context: BrowserContext,
  request: APIRequestContext,
  email: string,
  inviteLink: string,
) {
  const page = await context.newPage();
  await page.goto(inviteLink);
  await expect(page.getByLabel("電子郵件")).toHaveCount(0);
  await page.getByRole("button", { name: "寄送登入連結到受邀信箱" }).click();
  await expect(page.getByRole("status")).toContainText(
    "如果這個邀請仍然有效，登入連結已寄到受邀的信箱。",
  );
  const magicLink = await emailLink(request, email, "登入 Along the Way");
  expect(new URLSearchParams(new URL(magicLink).hash.slice(1)).has("inviteToken"))
    .toBe(false);
  let consumeCount = 0;
  page.on("request", (sentRequest) => {
    if (sentRequest.url().endsWith("/api/auth/magic-links/consume")) {
      consumeCount += 1;
    }
  });
  await page.evaluate((link) => {
    window.location.href = link;
  }, magicLink);
  await expect(page.getByRole("button", { name: /大阪京都家庭旅行，切換旅程/ }))
    .toBeVisible();
  await expect.poll(() => consumeCount).toBe(1);
  await expect(page.getByRole("button", { name: "接受邀請" })).toHaveCount(0);
  await openMembers(page);
  return page;
}

async function tripId(page: Page, name: string) {
  const value = await page.evaluate(async () => {
    const response = await fetch("/api/trips");
    return response.json();
  });
  const trip = parseTripListResponse(value).trips.find(
    (candidate) => candidate.name === name,
  );
  if (!trip) throw new Error(`Trip ${name} was not listed`);
  return trip.id;
}

async function privateTripStatus(page: Page, id: string) {
  return page.evaluate(
    async (tripIdentifier) => (await fetch(`/api/trips/${tripIdentifier}`)).status,
    id,
  );
}

async function expireInvite(link: string) {
  const tokenHash = createHash("sha256")
    .update(linkToken(link, "inviteToken"))
    .digest("hex");
  const project = process.env.E2E_COMPOSE_PROJECT ?? "along-the-way";
  const database = process.env.POSTGRES_DB ?? "along_the_way_test";
  const user = process.env.POSTGRES_ADMIN_USER ?? "along_the_way_admin_test";
  await execFileAsync("docker", [
    "compose",
    "--project-name",
    project,
    "exec",
    "--no-TTY",
    "db",
    "psql",
    "--username",
    user,
    "--dbname",
    database,
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    `update invites set expires_at = now() - interval '1 second' where token_hash = '${tokenHash}'`,
  ]);
}

test("private trips work across four identities, viewports, and rejection paths", async ({
  browser,
  page,
  request,
}) => {
  test.setTimeout(180_000);
  await request.delete(`${mailpit}/api/v1/messages`);

  await page.goto("/");
  await signIn(page, request, "owner@example.test");
  await expect(page.getByRole("heading", { name: "先建立一趟旅程" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /今天|行程|地點|成員/ })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "先建立一趟旅程" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /今天|行程|地點|成員/ })).toHaveCount(0);
  await page.getByRole("button", { name: "建立旅程", exact: true }).click();
  let createDialog = page.getByRole("dialog", { name: "建立旅程" });
  await expect(createDialog).toContainText("步驟 1 / 3・旅程");
  await createDialog.getByLabel("旅程名稱").fill("保留中的草稿");
  const closeBox = await createDialog.getByRole("button", { name: "關閉" }).boundingBox();
  expect(closeBox?.width).toBeGreaterThanOrEqual(44);
  expect(closeBox?.height).toBeGreaterThanOrEqual(44);
  await selectDateRange(page, createDialog, "2026-10-21", "2026-10-27");
  const dateTrigger = createDialog.getByRole("button", { name: /2026\/10\/21 – 2026\/10\/27/ });
  await dateTrigger.click();
  const rangeMiddle = page.locator('[data-range-middle="true"]').first();
  await expect(rangeMiddle).toHaveCSS("background-color", "rgb(181, 87, 55)");
  await expect(rangeMiddle).toHaveCSS("color", "rgb(255, 250, 242)");
  await expect(page.getByRole("button", { name: "確定", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "確定", exact: true }).click();
  await page.mouse.click(5, 5);
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByLabel("旅程名稱")).toHaveValue("保留中的草稿");
  await page.keyboard.press("Escape");
  await expect(createDialog).toHaveCount(0);
  await page.getByRole("button", { name: "建立旅程", exact: true }).click();
  createDialog = page.getByRole("dialog", { name: "建立旅程" });
  await expect(createDialog.getByLabel("旅程名稱")).toHaveValue("保留中的草稿");
  await expect(createDialog.getByRole("button", { name: /2026\/10\/21 – 2026\/10\/27/ })).toBeVisible();
  await expect(createDialog.getByRole("heading", { name: "步驟 1 / 3・旅程" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 720 });
  const switchTripControl = page.getByRole("button", { name: /切換旅程$/ });
  await switchTripControl.click();
  const switcher = page.getByRole("dialog", { name: "切換旅程" });
  const createTripTrigger = switcher.getByRole("button", { name: "建立旅程" });
  await createTripTrigger.click();
  await expect(page.getByRole("dialog", { name: "建立旅程" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "建立旅程" })).toHaveCount(0);
  await expect(switchTripControl).toBeFocused();
  await page.keyboard.press("Escape");

  await createTrip(page, {
    name: "大阪京都家庭旅行",
    startDate: "2026-10-21",
    endDate: "2026-10-27",
    countryStops: [
      { code: "JP", query: "日本" },
      { code: "KR", query: "kr" },
      { code: "JP", query: "Japan" },
      { code: "TW", query: "Taiwan" },
    ],
  }, async (dialog) => {
    const bounds = await dialog.boundingBox();
    expect(bounds?.width).toBeGreaterThan(272);

    const moveTaiwanUp = dialog.getByRole("button", { name: "將第 4 個停靠點往上移" });
    await moveTaiwanUp.focus();
    await moveTaiwanUp.press("Enter");
    await expect(dialog.getByRole("button", { name: "將第 3 個停靠點往上移" })).toBeFocused();
    await expect(dialog.getByRole("listitem").nth(2)).toContainText("(TW)");
    await dialog.getByRole("button", { name: "移除第 3 個停靠點" }).click();

    const routeItems = dialog.locator('section[aria-labelledby="country-route-heading"] li');
    await expect(routeItems).toHaveCount(3);

    const routeBeforeInvalidRemoval = await routeItems.allTextContents();
    await dialog.getByRole("button", { name: "移除第 2 個停靠點" }).click();
    await expect(dialog.getByRole("alert")).toContainText("移除後會讓相同國家相鄰。");
    expect(await routeItems.allTextContents()).toEqual(routeBeforeInvalidRemoval);
    await expect(routeItems.nth(2)).toContainText("(JP)");

    const search = dialog.getByLabel("新增國家");
    await search.fill("Japan");
    await expect(page.getByRole("option", { name: /\(JP\)/ })).toBeDisabled();
    await search.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(routeItems).toHaveCount(3);
    await search.press("Tab");
    await expect(page.getByRole("option", { name: /\(JP\)/ })).toHaveCount(0);

    const routeBeforeInvalidMove = await dialog.getByRole("listitem").allTextContents();
    await dialog.getByRole("button", { name: "將第 1 個停靠點往下移" }).click();
    await expect(dialog.getByRole("alert")).toContainText("移動後會讓相同國家相鄰。");
    expect(await dialog.getByRole("listitem").allTextContents()).toEqual(routeBeforeInvalidMove);
  });
  const checklist = page.getByRole("region", { name: "接著完成這些安排" });
  await expect(checklist).toContainText("旅程已建立，去回程航班也已加入行程。");
  await expect(checklist.getByRole("button", { name: "新增住宿（可稍後）" })).toBeVisible();
  await expect(checklist.getByRole("button", { name: "加入第一個地點" })).toBeVisible();
  await expect(checklist.getByRole("button", { name: "邀請同行成員（可稍後）" })).toBeVisible();
  await checklist.getByRole("button", { name: "略過" }).click();
  await expect(checklist).toHaveCount(0);
  await page.getByRole("tab", { name: "行程", exact: true }).click();
  await page.getByRole("button", { name: "FIXTURE-OUT 航班 05:00", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "到航班修改航班", exact: true }).click();
  await expect(page.getByText("2026-10-21 – 2026-10-27", { exact: false })).toBeVisible();
  await expect(page.getByText("無法推定預設幣別")).toBeVisible();
  const countryRoute = page.locator('section[aria-labelledby="trip-country-route"]');
  await expect(countryRoute.getByRole("listitem").nth(0)).toContainText("(JP)");
  await expect(countryRoute.getByRole("listitem").nth(1)).toContainText("(KR)");
  await expect(countryRoute.getByRole("listitem").nth(2)).toContainText("(JP)");
  await expect(countryRoute.getByText("Asia/Tokyo", { exact: true })).toHaveCount(2);
  await expect(countryRoute.getByText("Asia/Seoul", { exact: true })).toBeVisible();
  const osakaTripId = await tripId(page, "大阪京都家庭旅行");

  const editorPages: Page[] = [];
  const editorContexts: BrowserContext[] = [];
  const inviteLinks: string[] = [];
  for (const [index, email] of [
    "wife@example.test",
    "mother@example.test",
    "friend@example.test",
  ].entries()) {
    const inviteLink = await inviteEditor(page, request, email);
    inviteLinks.push(inviteLink);
    const context = await browser.newContext({
      viewport: index === 0 ? { width: 390, height: 844 } : undefined,
    });
    editorContexts.push(context);
    editorPages.push(await acceptEditor(context, request, email, inviteLink));
  }

  await page.reload();
  // A reload selects the first listed trip; other specs' trips may be listed before this one.
  await page.getByRole("button", { name: /切換旅程$/ }).click();
  const switcherDialog = page.getByRole("dialog", { name: "切換旅程" });
  const ownTrip = switcherDialog.getByRole("button", { name: /^大阪京都家庭旅行 2026-10-21 – 2026-10-27・4 位成員$/ });
  await expect(ownTrip).toBeVisible();
  await ownTrip.click();
  await expect(page.getByRole("button", { name: /大阪京都家庭旅行，切換旅程/ })).toBeVisible();
  await openMembers(page);
  const membersPanel = page.getByRole("tabpanel", { name: "成員", exact: true });
  await expect(membersPanel.getByText("wife@example.test", { exact: true })).toBeVisible();
  await expect(membersPanel.getByText("mother@example.test", { exact: true })).toBeVisible();
  await expect(membersPanel.getByText("friend@example.test", { exact: true })).toBeVisible();
  await expect(membersPanel.getByRole("list").first().getByRole("listitem")).toHaveCount(4);
  await expect(membersPanel.getByText("沒有待處理的邀請。", { exact: true }))
    .toBeVisible();

  const wifePage = editorPages[0]!;
  const motherPage = editorPages[1]!;
  await motherPage.reload();
  await openMembers(motherPage);
  const motherMembers = motherPage.getByRole("tabpanel", { name: "成員", exact: true });
  await expect(motherMembers.getByText("friend@example.test", { exact: true })).toBeVisible();
  await expect(motherMembers.getByRole("list").first().getByRole("listitem")).toHaveCount(4);

  await createTrip(wifePage, {
    name: "手機建立的台北旅程",
    startDate: "2027-01-15",
    endDate: "2027-01-16",
    countryStops: [{ code: "TW", query: "台灣" }],
  }, async (dialog) => {
    const bounds = await dialog.boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect(bounds ? bounds.x + bounds.width : Number.POSITIVE_INFINITY)
      .toBeLessThanOrEqual(390);
  });
  await wifePage.getByRole("tab", { name: "行程", exact: true }).click();
  await wifePage.getByRole("button", { name: "FIXTURE-OUT 航班 05:00", exact: true }).click();
  await wifePage.getByRole("dialog").getByRole("button", { name: "到航班修改航班", exact: true }).click();
  await expect(wifePage.getByText("Asia/Taipei", { exact: true })).toBeVisible();
  await wifePage.getByRole("button", { name: /切換旅程$/ }).click();
  const wifeSwitcher = wifePage.getByRole("dialog", { name: "切換旅程" });
  await expect(wifeSwitcher.getByText("預設幣別 TWD")).toBeVisible();
  await wifeSwitcher.getByRole("button", { name: /^大阪京都家庭旅行/ }).click();
  await openMembers(wifePage);
  const wifeMembers = wifePage.getByRole("tabpanel", { name: "成員", exact: true });
  await expect(wifeMembers.getByText("friend@example.test", { exact: true })).toBeVisible();
  await expect(wifeMembers.getByRole("list").first().getByRole("listitem")).toHaveCount(4);

  await expect(wifePage.getByLabel("透過電子郵件邀請編輯者")).toHaveCount(0);
  const forbiddenStatus = await wifePage.evaluate(async (id) => {
    const response = await fetch(`/api/trips/${id}/invites`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ email: "blocked@example.test" }),
    });
    return response.status;
  }, osakaTripId);
  expect(forbiddenStatus).toBe(403);

  await openEmailLink(wifePage, inviteLinks[0]!);
  await wifePage.getByRole("button", { name: "接受邀請" }).click();
  await expect(wifePage.getByRole("alert")).toContainText("這個邀請已使用。");

  const outsiderLink = await inviteEditor(
    page,
    request,
    "outsider@example.test",
  );
  expect(linkToken(outsiderLink, "inviteToken")).not.toBe("");
  const outsiderContext = await browser.newContext();
  const outsiderPage = await outsiderContext.newPage();
  await outsiderPage.goto("/");
  await signIn(outsiderPage, request, "outsider@example.test");
  expect(await privateTripStatus(outsiderPage, osakaTripId)).toBe(404);

  const mismatchLink = await inviteEditor(
    page,
    request,
    "intended@example.test",
  );
  await openEmailLink(outsiderPage, mismatchLink);
  await outsiderPage.getByRole("button", { name: "接受邀請" }).click();
  await expect(outsiderPage.getByRole("alert")).toContainText(
    "這個邀請不適用於目前登入的電子郵件。",
  );

  const revokedLink = await inviteEditor(
    page,
    request,
    "revoked@example.test",
  );
  const revokedItem = page
    .getByRole("listitem")
    .filter({ hasText: "revoked@example.test" });
  await revokedItem.getByRole("button", { name: "撤銷" }).click();
  await expect(revokedItem).toHaveCount(0);
  const revokedContext = await browser.newContext();
  const revokedPage = await revokedContext.newPage();
  await revokedPage.goto("/");
  await signIn(revokedPage, request, "revoked@example.test");
  await openEmailLink(revokedPage, revokedLink);
  await revokedPage.getByRole("button", { name: "接受邀請" }).click();
  await expect(revokedPage.getByRole("alert")).toContainText("這個邀請已撤銷。");

  const expiredLink = await inviteEditor(
    page,
    request,
    "expired@example.test",
  );
  const expiredContext = await browser.newContext();
  const expiredPage = await expiredContext.newPage();
  await expiredPage.goto("/");
  await signIn(expiredPage, request, "expired@example.test");
  await expireInvite(expiredLink);
  await openEmailLink(expiredPage, expiredLink);
  await expiredPage.getByRole("button", { name: "接受邀請" }).click();
  await expect(expiredPage.getByRole("alert")).toContainText("這個邀請已過期。");

  expect(await privateTripStatus(wifePage, osakaTripId)).toBe(200);
  const wifeItem = membersPanel
    .getByRole("list")
    .first()
    .getByRole("listitem")
    .filter({ hasText: "wife@example.test" });
  await wifeItem.getByRole("button", { name: "移除" }).click();
  await expect(wifeItem).toHaveCount(0);
  expect(await privateTripStatus(wifePage, osakaTripId)).toBe(404);

  await createTrip(page, {
    name: "首爾週末",
    startDate: "2027-03-05",
    endDate: "2027-03-07",
    countryStops: [{ code: "KR", query: "kr" }],
  });
  await expect(page.getByRole("button", { name: /首爾週末，切換旅程/ })).toBeVisible();

  const invalidContext = await browser.newContext();
  const invalidPage = await invalidContext.newPage();
  await invalidPage.goto("/#magicToken=not-a-real-token");
  await expect(invalidPage.getByRole("alert")).toContainText(
    "請寄一封新的登入信。",
  );

  await Promise.all([
    ...editorContexts.map((context) => context.close()),
    outsiderContext.close(),
    revokedContext.close(),
    expiredContext.close(),
    invalidContext.close(),
  ]);
});
