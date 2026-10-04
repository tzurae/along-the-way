import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  isRecord,
  parseTripListResponse,
  parseTripResponse,
} from "@along-the-way/contracts/private-trips";
import { parseTripSkeletonResponse } from "@along-the-way/contracts/trip-skeleton";
const execFileAsync = promisify(execFile);
const MAILPIT_API_URL = process.env.MAILPIT_API_URL ?? "http://127.0.0.1:8025";


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
function colorChannels(value: string) {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) throw new Error(`Unsupported color: ${value}`);
  return channels.map((channel) => channel / 255);
}

function relativeLuminance(value: string) {
  const [red, green, blue] = colorChannels(value).map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrastRatio(foreground: string, background: string) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function expectReadableText(locator: Locator, pseudoElement?: "::placeholder") {
  const sample = await locator.evaluate((element, pseudo) => {
    const foregroundStyle = getComputedStyle(element, pseudo);
    let backgroundElement: Element | null = element;
    let background = "rgba(0, 0, 0, 0)";
    while (backgroundElement) {
      background = getComputedStyle(backgroundElement).backgroundColor;
      if (!background.endsWith(", 0)")) break;
      backgroundElement = backgroundElement.parentElement;
    }
    return {
      foreground: foregroundStyle.color,
      background,
      opacity: foregroundStyle.opacity,
    };
  }, pseudoElement);
  expect(Number(sample.opacity)).toBe(1);
  expect(contrastRatio(sample.foreground, sample.background)).toBeGreaterThanOrEqual(4.5);
}

async function executeDatabase(command: string) {
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
    command,
  ]);
}

async function cleanupSkeletonTrips() {
  await executeDatabase(
    "delete from itinerary_items where trip_id in (select id from trips where name like '大阪京都家庭旅行 %' or name like 'US Japan pilot %'); delete from trips where name like '大阪京都家庭旅行 %' or name like 'US Japan pilot %';",
  );
}

test.beforeEach(() => executeDatabase("truncate table rate_limit_windows"));
test.afterAll(cleanupSkeletonTrips);

async function signIn(
  page: Page,
  request: APIRequestContext,
  email: string,
  navigate = true,
) {
  if (navigate) await page.goto("/");
  const previousResponse = await request.get(`${MAILPIT_API_URL}/api/v1/messages`);
  const previousMessageIds = new Set(messages(await previousResponse.json()).map((message) => message.id));
  await page.getByLabel("電子郵件").fill(email);
  await page.getByRole("button", { name: "寄登入連結給我" }).click();
  let messageId = "";
  await expect.poll(async () => {
    const response = await request.get(`${MAILPIT_API_URL}/api/v1/messages`);
    messageId = messages(await response.json()).find(
      (message) =>
        !previousMessageIds.has(message.id) &&
        message.subject.includes("Sign in to Along the Way") &&
        message.recipients.includes(email),
    )?.id ?? "";
    return messageId;
  }).not.toBe("");
  const detail = await request.get(`${MAILPIT_API_URL}/api/v1/message/${messageId}`);
  const value: unknown = await detail.json();
  if (!isRecord(value) || typeof value.Text !== "string") throw new Error("Invalid Mailpit body");
  const link = value.Text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error("Magic link missing");
  await page.goto("about:blank");
  await page.goto(link);
  await expect(page.getByText(`登入帳號：${email}`)).toBeVisible();
}

async function emailLink(
  request: APIRequestContext,
  email: string,
  subject: string,
) {
  let messageId = "";
  await expect.poll(async () => {
    const response = await request.get(`${MAILPIT_API_URL}/api/v1/messages`);
    messageId = messages(await response.json()).find(
      (message) =>
        message.subject.includes(subject) &&
        message.recipients.includes(email),
    )?.id ?? "";
    return messageId;
  }).not.toBe("");
  const detail = await request.get(`${MAILPIT_API_URL}/api/v1/message/${messageId}`);
  const value: unknown = await detail.json();
  if (!isRecord(value) || typeof value.Text !== "string") throw new Error("Invalid Mailpit body");
  const link = value.Text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error(`Email for ${email} omitted its link`);
  return link;
}

async function inviteEditor(
  ownerPage: Page,
  request: APIRequestContext,
  tripName: string,
  email: string,
) {
  await ownerPage.getByLabel("透過電子郵件邀請編輯者").fill(email);
  await ownerPage.getByRole("button", { name: "寄出邀請" }).click();
  await expect(ownerPage.getByRole("status")).toContainText(email);
  return emailLink(request, email, `Join ${tripName}`);
}

async function acceptEditor(
  context: BrowserContext,
  request: APIRequestContext,
  tripName: string,
  email: string,
  inviteLink: string,
) {
  const page = await context.newPage();
  await page.goto(inviteLink);
  await signIn(page, request, email, false);
  await page.getByRole("button", { name: "接受邀請" }).click();
  await expect(page.getByRole("heading", { name: tripName })).toBeVisible();
  return page;
}

function localDateLabel(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year!, month! - 1, day!).toLocaleDateString("zh-TW");
}

async function createTrip(
  page: Page,
  input: {
    name: string;
    startDate: string;
    endDate: string;
    countries: Array<{ query: string; code: string }>;
  },
) {
  await page.getByRole("button", { name: "建立旅程" }).click();
  const dialog = page.getByRole("dialog", { name: "建立旅程" });
  await dialog.getByLabel("旅程名稱").fill(input.name);
  await dialog.getByRole("button", { name: "選擇日期範圍" }).click();
  const [year, month] = input.startDate.split("-").map(Number);
  const current = new Date();
  const monthOffset = year! * 12 + month! - 1 - (current.getFullYear() * 12 + current.getMonth());
  const direction = monthOffset >= 0 ? ".rdp-button_next" : ".rdp-button_previous";
  for (let index = 0; index < Math.abs(monthOffset); index += 1) {
    await page.locator(direction).click();
  }
  await page.locator(`[data-day="${localDateLabel(input.startDate)}"]`).click();
  await page.locator(`[data-day="${localDateLabel(input.endDate)}"]`).click();
  for (const [index, country] of input.countries.entries()) {
    const search = dialog.getByLabel("新增國家");
    await search.fill(country.query);
    const option = page.getByRole("option", { name: new RegExp(`\\(${country.code}\\)`) });
    await expect(option).toBeVisible();
    await option.dispatchEvent("click");
    await expect(dialog.locator('section[aria-labelledby="country-route-heading"] li')).toHaveCount(index + 1);
  }
  await dialog.getByRole("button", { name: "建立旅程", exact: true }).click();
  await expect(page.getByRole("heading", { name: input.name })).toBeVisible();
}

async function createPlace(
  page: Page,
  input: { name: string; type: string; address: string; latitude: string; longitude: string; timeZone: string },
) {
  await page.getByRole("button", { name: "新增地點" }).click();
  const dialog = page.getByRole("dialog", { name: "新增地點" });
  await dialog.getByLabel("地點名稱").fill(input.name);
  await dialog.getByLabel("地點類型").selectOption(input.type);
  await dialog.getByLabel("地址").fill(input.address);
  await dialog.getByLabel("緯度").fill(input.latitude);
  await dialog.getByLabel("經度").fill(input.longitude);
  await dialog.getByLabel("IANA 時區").fill(input.timeZone);
  await dialog.getByRole("button", { name: "儲存地點" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "地點", exact: true }).getByRole("heading", { name: input.name }),
  ).toBeVisible();
}

async function chooseEndpoint(
  dialog: ReturnType<Page["getByRole"]>,
  role: "Start" | "End",
  input: { stop: string; place: string; local: string; zone: string },
) {
  const endpoint = role === "Start" ? "開始" : "結束";
  const group = dialog.getByRole("group", { name: `${endpoint}（當地時間）` });
  await group.getByLabel("停留國家").selectOption({ label: input.stop });
  await group.getByLabel("地點").selectOption({ label: input.place });
  await group.getByLabel("當地日期與時間").fill(input.local);
  const timeZone = group.getByLabel("IANA 時區");
  if (await timeZone.inputValue() !== input.zone) await timeZone.fill(input.zone);
  await expect(timeZone).toHaveValue(input.zone);
}

interface EndpointSpec {
  stop: string;
  place: string;
  local: string;
  zone: string;
}

async function addFlight(
  page: Page,
  input: {
    title: string;
    start: EndpointSpec;
    end: EndpointSpec;
    serviceNumber: string;
    constraintType?: "fixed_time" | "minimum_buffer";
    bufferMinutes?: string;
    currency: string;
  },
) {
  await page.getByRole("button", { name: "新增固定行程" }).click();
  const dialog = page.getByRole("dialog", { name: "新增固定行程" });
  await dialog.getByLabel("類型").selectOption("flight");
  await dialog.getByLabel("標題").fill(input.title);
  await chooseEndpoint(dialog, "Start", input.start);
  await chooseEndpoint(dialog, "End", input.end);
  await dialog.getByLabel("航空公司").fill("JAL");
  await dialog.getByLabel("航班號碼").fill(input.serviceNumber);
  await dialog.getByLabel("最小貨幣單位金額").fill("90000");
  await dialog.getByLabel("幣別").fill(input.currency);
  await dialog.getByLabel("限制").selectOption(input.constraintType ?? "fixed_time");
  await dialog.locator("#constraint-status").selectOption("confirmed");
  if (input.constraintType === "minimum_buffer") {
    await dialog.getByLabel("緩衝分鐘數").fill(input.bufferMinutes ?? "180");
  }
  await dialog.getByRole("button", { name: "儲存固定行程" }).click();
  await expect(dialog).toHaveCount(0);
}

async function addLodging(
  page: Page,
  input: { title: string; place: string; start: string; end: string; confirmation: string },
) {
  await page.getByRole("button", { name: "新增固定行程" }).click();
  const dialog = page.getByRole("dialog", { name: "新增固定行程" });
  await dialog.getByLabel("類型").selectOption("lodging");
  await dialog.getByLabel("標題").fill(input.title);
  await chooseEndpoint(dialog, "Start", { stop: "2、JP", place: input.place, local: input.start, zone: "Asia/Tokyo" });
  const end = dialog.getByRole("group", { name: "結束（當地時間）" });
  await expect(end.getByLabel("停留國家")).toBeDisabled();
  await expect(end.getByLabel("地點")).toBeDisabled();
  await expect(end.getByLabel("地點").locator("option:checked")).toHaveText(input.place);
  await expect(end.getByLabel("IANA 時區")).toBeDisabled();
  await expect(end.getByLabel("IANA 時區")).toHaveValue("Asia/Tokyo");
  await end.getByLabel("當地日期與時間").fill(input.end);
  await dialog.getByLabel("預訂者").fill("Family");
  await dialog.getByLabel("確認碼").fill(input.confirmation);
  await dialog.getByLabel("限制").selectOption("immovable");
  await dialog.locator("#constraint-status").selectOption("unknown");
  await dialog.getByRole("button", { name: "儲存固定行程" }).click();
  await expect(dialog).toHaveCount(0);
}

async function addTransport(
  page: Page,
  input: {
    title: string;
    start: EndpointSpec;
    end: EndpointSpec;
    buffer?: { minutes: string; status: "confirmed" | "unknown" | "conflicted" };
  },
) {
  await page.getByRole("button", { name: "新增固定行程" }).click();
  const dialog = page.getByRole("dialog", { name: "新增固定行程" });
  await dialog.getByLabel("類型").selectOption("transport");
  await dialog.getByLabel("標題").fill(input.title);
  await chooseEndpoint(dialog, "Start", input.start);
  await chooseEndpoint(dialog, "End", input.end);
  await dialog.getByLabel("交通方式").fill("Train");
  await dialog.getByLabel("票券資訊").fill("Reserved seats");
  if (input.buffer) {
    await dialog.getByLabel("限制").selectOption("minimum_buffer");
    await dialog.locator("#constraint-status").selectOption(input.buffer.status);
    await dialog.getByLabel("緩衝分鐘數").fill(input.buffer.minutes);
  }
  await dialog.getByRole("button", { name: "儲存固定行程" }).click();
  await expect(dialog).toHaveCount(0);
}

async function addReservation(
  page: Page,
  input: { title: string; endpoint: EndpointSpec },
) {
  await page.getByRole("button", { name: "新增固定行程" }).click();
  const dialog = page.getByRole("dialog", { name: "新增固定行程" });
  await dialog.getByLabel("類型").selectOption("reservation");
  await dialog.getByLabel("標題").fill(input.title);
  await chooseEndpoint(dialog, "Start", input.endpoint);
  await dialog.getByLabel("期間（分鐘）").fill("90");
  await dialog.getByLabel("預訂者").fill("Owner");
  await dialog.locator("#appointment-status").fill("Confirmed");
  await dialog.getByLabel("限制").selectOption("immovable");
  await dialog.locator("#constraint-status").selectOption("conflicted");
  await dialog.getByRole("button", { name: "儲存固定行程" }).click();
  await expect(dialog).toHaveCount(0);
}

async function addMeal(page: Page, input: { title: string; endpoint: EndpointSpec }) {
  await page.getByRole("button", { name: "新增固定行程" }).click();
  const dialog = page.getByRole("dialog", { name: "新增固定行程" });
  await dialog.getByLabel("類型").selectOption("meal");
  await dialog.getByLabel("標題").fill(input.title);
  await chooseEndpoint(dialog, "Start", input.endpoint);
  await expect(dialog.getByRole("group", { name: "結束（當地時間）" })).toHaveCount(0);
  await dialog.getByLabel("期間（分鐘）").fill("60");
  await dialog.getByLabel("預訂者").fill("Family");
  await dialog.locator("#appointment-status").fill("Requested");
  await dialog.getByRole("button", { name: "儲存固定行程" }).click();
  await expect(dialog).toHaveCount(0);
}

async function addFreeTime(page: Page, input: { title: string; endpoint: EndpointSpec }) {
  await page.getByRole("button", { name: "新增固定行程" }).click();
  const dialog = page.getByRole("dialog", { name: "新增固定行程" });
  await dialog.getByLabel("類型").selectOption("free-time");
  await dialog.getByLabel("標題").fill(input.title);
  await chooseEndpoint(dialog, "Start", input.endpoint);
  await expect(dialog.getByLabel("最小貨幣單位金額")).toHaveCount(0);
  await expect(dialog.getByRole("group", { name: "結束（當地時間）" })).toHaveCount(0);
  await dialog.getByLabel("期間（分鐘）").fill("120");
  await dialog.getByRole("button", { name: "儲存固定行程" }).click();
  await expect(dialog).toHaveCount(0);
}

async function addActivity(page: Page, input: { title: string; endpoint: EndpointSpec }) {
  await page.getByRole("button", { name: "新增固定行程" }).click();
  const dialog = page.getByRole("dialog", { name: "新增固定行程" });
  await dialog.getByLabel("類型").selectOption("activity");
  await dialog.getByLabel("標題").fill(input.title);
  await chooseEndpoint(dialog, "Start", input.endpoint);
  await dialog.getByLabel("期間（分鐘）").fill("75");
  await dialog.getByLabel("預訂者").fill("Mobile owner");
  await dialog.locator("#appointment-status").fill("Paid");
  await dialog.getByLabel("限制").selectOption("immovable");
  await dialog.locator("#constraint-status").selectOption("confirmed");
  await dialog.getByRole("button", { name: "儲存固定行程" }).click();
  await expect(dialog).toHaveCount(0);
}

function escaped(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function participantCheckbox(dialog: Locator, email: string) {
  return dialog
    .getByRole("group", { name: "參與成員" })
    .getByRole("checkbox", { name: new RegExp(escaped(email)) });
}

async function addParticipantActivity(
  page: Page,
  input: {
    title: string;
    endpoint: EndpointSpec;
    durationMinutes: string;
    participantEmails: string[];
    expectedRosterSize: number;
  },
) {
  await page.getByRole("button", { name: "新增固定行程" }).click();
  const dialog = page.getByRole("dialog", { name: "新增固定行程" });
  await dialog.getByLabel("類型").selectOption("activity");
  await dialog.getByLabel("標題").fill(input.title);
  await chooseEndpoint(dialog, "Start", input.endpoint);
  await dialog.getByLabel("期間（分鐘）").fill(input.durationMinutes);
  const participantGroup = dialog.getByRole("group", { name: "參與成員" });
  await expect(participantGroup.getByRole("checkbox")).toHaveCount(input.expectedRosterSize);
  for (const checkbox of await participantGroup.getByRole("checkbox").all()) {
    await expect(checkbox).not.toBeChecked();
  }
  for (const email of input.participantEmails) {
    await participantCheckbox(dialog, email).check();
  }
  await dialog.getByRole("button", { name: "儲存固定行程" }).click();
  await expect(dialog).toHaveCount(0);
}

function timelineCard(page: Page, title: string) {
  return page
    .getByRole("region", { name: "每日行程", exact: true })
    .locator(".itinerary-card")
    .filter({ hasText: title })
    .first();
}

async function tripIdentifier(page: Page, name: string) {
  const value: unknown = await page.evaluate(async () =>
    (await fetch("/api/trips")).json()
  );
  const trip = parseTripListResponse(value).trips.find((candidate) => candidate.name === name);
  if (!trip) throw new Error(`Trip ${name} was not listed`);
  return trip.id;
}

async function readTrip(page: Page, id: string) {
  const value: unknown = await page.evaluate(async (tripId) =>
    (await fetch(`/api/trips/${tripId}`)).json(), id
  );
  return parseTripResponse(value).trip;
}

async function readSkeleton(page: Page, id: string) {
  const value: unknown = await page.evaluate(async (tripId) =>
    (await fetch(`/api/trips/${tripId}/skeleton`)).json(), id
  );
  return parseTripSkeletonResponse(value).skeleton;
}

async function openTrip(page: Page, name: string) {
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByRole("heading", { name: "固定行程與每日行程" })).toBeVisible();
}

test("the seven-day Osaka Kyoto pilot works on desktop and mobile", async ({ browser, request }) => {
  test.setTimeout(240_000);
  await request.delete(`${MAILPIT_API_URL}/api/v1/messages`);
  const name = `大阪京都家庭旅行 ${Date.now()}`;
  const desktopContext = await browser.newContext({
    timezoneId: "Pacific/Honolulu",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await desktopContext.newPage();
  await signIn(page, request, "owner@example.test");
  await createTrip(page, {
    name,
    startDate: "2026-10-21",
    endDate: "2026-10-27",
    countries: [
      { query: "Taiwan", code: "TW" },
      { query: "Japan", code: "JP" },
      { query: "Taiwan", code: "TW" },
    ],
  });
  await expectReadableText(page.locator(".empty-state").first());

  await page.getByRole("button", { name: "新增地點" }).click();
  const invalidPlaceDialog = page.getByRole("dialog", { name: "新增地點" });
  await expectReadableText(invalidPlaceDialog.locator('[data-slot="dialog-description"]'));
  await expectReadableText(invalidPlaceDialog.getByLabel("IANA 時區"), "::placeholder");
  await invalidPlaceDialog.getByLabel("地點名稱").fill("Invalid coordinates");
  await invalidPlaceDialog.getByLabel("緯度").fill("north");
  await invalidPlaceDialog.getByLabel("經度").fill("135");
  await invalidPlaceDialog.getByRole("button", { name: "儲存地點" }).click();
  await expect(invalidPlaceDialog.getByRole("alert")).toContainText(
    "緯度必須是 -90 到 90 之間的數字。",
  );
  await expect(invalidPlaceDialog.getByLabel("緯度")).toHaveValue("north");
  await invalidPlaceDialog.press("Escape");
  await expect(invalidPlaceDialog).toHaveCount(0);

  await createPlace(page, { name: "Taoyuan Airport", type: "airport", address: "TPE", latitude: "25.0797", longitude: "121.2342", timeZone: "Asia/Taipei" });
  await createPlace(page, { name: "Kansai Airport", type: "airport", address: "KIX", latitude: "34.4347", longitude: "135.2440", timeZone: "Asia/Tokyo" });
  await createPlace(page, { name: "Osaka Hotel", type: "lodging", address: "Namba", latitude: "34.6654", longitude: "135.5013", timeZone: "Asia/Tokyo" });
  await createPlace(page, { name: "Kyoto Hotel", type: "lodging", address: "Higashiyama", latitude: "35.0116", longitude: "135.7681", timeZone: "Asia/Tokyo" });
  await createPlace(page, { name: "Osaka Station", type: "station", address: "Umeda", latitude: "34.7025", longitude: "135.4959", timeZone: "Asia/Tokyo" });
  await createPlace(page, { name: "Kyoto Station", type: "station", address: "Kyoto", latitude: "34.9858", longitude: "135.7588", timeZone: "Asia/Tokyo" });
  await createPlace(page, { name: "Kyoto Restaurant", type: "restaurant", address: "Gion", latitude: "35.0037", longitude: "135.7788", timeZone: "Asia/Tokyo" });
  await createPlace(page, { name: "Kyoto venue to confirm", type: "activity", address: "", latitude: "", longitude: "", timeZone: "" });
  const incompletePlace = page.locator(".place-card").filter({ hasText: "Kyoto venue to confirm" });
  await expect(incompletePlace).toContainText("位置資訊不完整");

  await addFlight(page, {
    title: "Taipei to Osaka",
    start: { stop: "1、TW", place: "Taoyuan Airport", local: "2026-10-21T08:00", zone: "Asia/Taipei" },
    end: { stop: "2、JP", place: "Kansai Airport", local: "2026-10-21T11:30", zone: "Asia/Tokyo" },
    serviceNumber: "JL814",
    currency: "TWD",
  });
  await addFlight(page, {
    title: "Osaka to Taipei",
    start: { stop: "2、JP", place: "Kansai Airport", local: "2026-10-27T10:00", zone: "Asia/Tokyo" },
    end: { stop: "3、TW", place: "Taoyuan Airport", local: "2026-10-27T12:15", zone: "Asia/Taipei" },
    serviceNumber: "JL813",
    constraintType: "minimum_buffer",
    bufferMinutes: "180",
    currency: "TWD",
  });
  await addLodging(page, { title: "大阪住宿", place: "Osaka Hotel", start: "2026-10-21T15:00", end: "2026-10-24T09:00", confirmation: "OSAKA-ROOM" });
  await addLodging(page, { title: "京都住宿", place: "Kyoto Hotel", start: "2026-10-24T15:00", end: "2026-10-27T07:30", confirmation: "KYOTO-ROOM" });
  await addTransport(page, {
    title: "大阪到京都",
    start: { stop: "2、JP", place: "Osaka Station", local: "2026-10-24T10:00", zone: "Asia/Tokyo" },
    end: { stop: "2、JP", place: "Kyoto Station", local: "2026-10-24T11:00", zone: "Asia/Tokyo" },
  });
  await addTransport(page, {
    title: "京都住宿到關西機場",
    start: { stop: "2、JP", place: "Kyoto Hotel", local: "2026-10-27T08:00", zone: "Asia/Tokyo" },
    end: { stop: "2、JP", place: "Kansai Airport", local: "2026-10-27T09:00", zone: "Asia/Tokyo" },
    buffer: { minutes: "240", status: "unknown" },
  });
  await addReservation(page, {
    title: "京都固定晚餐",
    endpoint: { stop: "2、JP", place: "Kyoto Restaurant", local: "2026-10-25T19:00", zone: "Asia/Tokyo" },
  });
  await addMeal(page, {
    title: "京都午餐",
    endpoint: { stop: "2、JP", place: "Kyoto Restaurant", local: "2026-10-26T12:00", zone: "Asia/Tokyo" },
  });
  await addFreeTime(page, {
    title: "抵達後自由時間",
    endpoint: { stop: "2、JP", place: "Osaka Hotel", local: "2026-10-21T17:00", zone: "Asia/Tokyo" },
  });

  const days = page.getByRole("region", { name: "每日行程", exact: true }).locator(".day-column");
  await expect(days).toHaveCount(7);
  await expect(days.first()).toHaveAttribute("data-date", "2026-10-21");
  await expect(days.last()).toHaveAttribute("data-date", "2026-10-27");
  const arrivalPriorities = page.getByTestId("arrival-priorities");
  await expect(arrivalPriorities).toContainText("Taipei to Osaka");
  await expect(arrivalPriorities).toContainText("Kansai Airport");
  await expect(arrivalPriorities).toContainText("大阪住宿");
  const departurePriorities = page.getByTestId("departure-priorities");
  await expect(departurePriorities).toContainText("京都住宿");
  await expect(departurePriorities).toContainText("Osaka to Taipei");
  await expect(departurePriorities).toContainText("至少 180 分鐘");
  await expect(departurePriorities).toContainText("240 分鐘・未確認");
  const tripInformation = page.getByRole("region", { name: "旅程資訊", exact: true });
  await expect(tripInformation.getByRole("heading", { name: "Taipei to Osaka" })).toBeVisible();
  await expect(tripInformation.getByRole("heading", { name: "Osaka to Taipei" })).toBeVisible();
  await expect(tripInformation.getByRole("heading", { name: "大阪住宿" })).toBeVisible();
  await expect(tripInformation.getByRole("heading", { name: "京都住宿", exact: true })).toBeVisible();
  await expect(tripInformation.getByRole("heading", { name: "大阪到京都" })).toBeVisible();
  await page.reload();
  await openTrip(page, name);
  await expect(page.locator(".day-column")).toHaveCount(7);
  await expect(page.getByText("京都固定晚餐").first()).toBeVisible();
  await expect(page.getByText("京都午餐").first()).toBeVisible();
  await expect(page.getByText("抵達後自由時間").first()).toBeVisible();

  const authState = await desktopContext.storageState();
  const mobileContext = await browser.newContext({
    storageState: authState,
    timezoneId: "America/Los_Angeles",
    viewport: { width: 390, height: 844 },
  });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto("/");
  await openTrip(mobilePage, name);
  await expect(mobilePage.getByTestId("departure-priorities")).toContainText(
    "240 分鐘・未確認",
  );
  await addActivity(mobilePage, {
    title: "Mobile museum ticket",
    endpoint: { stop: "2、JP", place: "Kyoto venue to confirm", local: "2026-10-25T10:00", zone: "Asia/Tokyo" },
  });
  const mobileTimeline = mobilePage.getByRole("region", { name: "每日行程", exact: true });
  const activityCard = mobileTimeline.locator(".itinerary-card").filter({ hasText: "Mobile museum ticket" }).first();
  await activityCard.getByRole("button", { name: "鎖定" }).click();
  await expect(activityCard.getByText("已鎖定", { exact: true })).toBeVisible();
  await activityCard.getByRole("button", { name: "解鎖" }).click();
  const unlockDialog = mobilePage.getByRole("dialog", { name: "要解鎖「Mobile museum ticket」嗎？" });
  await expect(unlockDialog).toContainText("未來的排程流程");
  await unlockDialog.getByRole("button", { name: "解鎖固定行程" }).click();
  await activityCard.getByRole("button", { name: "編輯「Mobile museum ticket」" }).click();
  const editDialog = mobilePage.getByRole("dialog", { name: "編輯固定行程" });
  await editDialog.getByLabel("標題").fill("Mobile museum ticket · confirmed");
  await editDialog.getByRole("button", { name: "儲存固定行程" }).click();
  await expect(editDialog).toHaveCount(0);
  const shellBox = await mobilePage.locator(".trip-skeleton-shell").boundingBox();
  expect(shellBox?.x).toBeGreaterThanOrEqual(0);
  expect(shellBox ? shellBox.x + shellBox.width : Number.POSITIVE_INFINITY).toBeLessThanOrEqual(390);

  await page.reload();
  await openTrip(page, name);
  await expect(page.getByText("Mobile museum ticket · confirmed").first()).toBeVisible();
  await Promise.all([desktopContext.close(), mobileContext.close()]);
});

test("a US to Japan skeleton survives locking, concurrent edits, reload, and mobile", async ({ browser, request }) => {
  test.setTimeout(240_000);
  await request.delete(`${MAILPIT_API_URL}/api/v1/messages`);
  const name = `US Japan pilot ${Date.now()}`;
  const desktopContext = await browser.newContext({
    timezoneId: "America/Los_Angeles",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await desktopContext.newPage();
  await signIn(page, request, "owner@example.test");
  const authState = await desktopContext.storageState();
  await createTrip(page, {
    name,
    startDate: "2027-11-01",
    endDate: "2027-11-05",
    countries: [
      { query: "United States", code: "US" },
      { query: "Japan", code: "JP" },
    ],
  });

  await createPlace(page, { name: "San Francisco Airport", type: "airport", address: "SFO", latitude: "37.6213", longitude: "-122.379", timeZone: "America/Los_Angeles" });
  await createPlace(page, { name: "Haneda Airport", type: "airport", address: "HND", latitude: "35.5494", longitude: "139.7798", timeZone: "Asia/Tokyo" });
  await createPlace(page, { name: "Osaka Hotel", type: "lodging", address: "Osaka", latitude: "34.6937", longitude: "135.5023", timeZone: "Asia/Tokyo" });
  await createPlace(page, { name: "Kyoto Station", type: "station", address: "Kyoto", latitude: "34.9858", longitude: "135.7588", timeZone: "Asia/Tokyo" });
  await createPlace(page, { name: "Kyoto Restaurant", type: "restaurant", address: "Gion", latitude: "35.0037", longitude: "135.7788", timeZone: "Asia/Tokyo" });

  await addFlight(page, {
    title: "SFO to Haneda",
    start: { stop: "1、US", place: "San Francisco Airport", local: "2027-11-01T10:00", zone: "America/Los_Angeles" },
    end: { stop: "2、JP", place: "Haneda Airport", local: "2027-11-02T14:00", zone: "Asia/Tokyo" },
    serviceNumber: "JL001",
    currency: "USD",
  });
  await addLodging(page, { title: "大阪・京都 stay", place: "Osaka Hotel", start: "2027-11-02T16:00", end: "2027-11-05T08:00", confirmation: "OSAKA-21" });
  await addTransport(page, {
    title: "Airport to Kyoto train",
    start: { stop: "2、JP", place: "Haneda Airport", local: "2027-11-02T15:00", zone: "Asia/Tokyo" },
    end: { stop: "2、JP", place: "Kyoto Station", local: "2027-11-02T18:00", zone: "Asia/Tokyo" },
  });
  await addReservation(page, {
    title: "Kyoto dinner reservation",
    endpoint: { stop: "2、JP", place: "Kyoto Restaurant", local: "2027-11-03T19:00", zone: "Asia/Tokyo" },
  });

  const timeline = page.getByRole("region", { name: "每日行程", exact: true });
  await expect(timeline.getByText("SFO to Haneda").first()).toBeVisible();
  await expect(timeline.getByText(/2027-11-01 10:00 · America\/Los_Angeles \(.+, -07:00\)/).first()).toBeVisible();
  await expect(timeline.getByText(/2027-11-02 14:00 · Asia\/Tokyo \(.+, \+09:00\)/).first()).toBeVisible();
  const arrivalContext = page.getByTestId("arrival-priorities");
  await expect(arrivalContext).toContainText("尚未設定抵達端點。");
  await expect(arrivalContext).toContainText("尚未設定住宿入住時間。");
  const arrivalContinuation = timeline
    .locator('.day-column[data-date="2027-11-02"] .itinerary-card')
    .filter({ hasText: "SFO to Haneda" });
  await expect(arrivalContinuation).toContainText("Haneda Airport");
  await expect(page.getByTestId("departure-priorities")).toContainText("大阪・京都 stay");
  await expect(page.getByText("不可移動・未確認").first()).toBeVisible();
  await expect(page.getByText("不可移動・有衝突").first()).toBeVisible();

  const flightCard = timeline.locator(".itinerary-card").filter({ hasText: "SFO to Haneda" }).first();
  await flightCard.getByRole("button", { name: "鎖定" }).click();
  await expect(flightCard.getByText("已鎖定", { exact: true })).toBeVisible();
  await expect(flightCard.getByRole("button", { name: /編輯/ })).toHaveCount(0);
  await expect(flightCard.getByRole("button", { name: "刪除" })).toHaveCount(0);
  const hanedaPlace = page.locator(".place-card").filter({ hasText: "Haneda Airport" });
  await expect(hanedaPlace).toContainText("請先解鎖引用此地點的固定行程，才能編輯地點。");
  await expect(hanedaPlace.getByRole("button", { name: "編輯「Haneda Airport」" })).toHaveCount(0);
  await flightCard.getByRole("button", { name: "解鎖" }).click();
  const unlockDialog = page.getByRole("dialog", { name: "要解鎖「SFO to Haneda」嗎？" });
  await expect(unlockDialog).toContainText("未來的排程流程");
  await unlockDialog.getByRole("button", { name: "解鎖固定行程" }).click();
  await expect(flightCard.getByRole("button", { name: "編輯「SFO to Haneda」" })).toBeVisible();

  const tripInformationFlight = page
    .getByRole("region", { name: "旅程資訊", exact: true })
    .locator(".itinerary-card")
    .filter({ hasText: "SFO to Haneda" });
  await tripInformationFlight.getByRole("button", { name: "編輯「SFO to Haneda」" }).click();
  let samePageEdit = page.getByRole("dialog", { name: "編輯固定行程" });
  await expect(
    samePageEdit.getByRole("group", { name: "開始（當地時間）" }).getByLabel("當地日期與時間"),
  ).toHaveValue("2027-11-01T10:00");
  await samePageEdit.press("Escape");
  await expect(samePageEdit).toHaveCount(0);

  await flightCard.getByRole("button", { name: "編輯「SFO to Haneda」" }).click();
  samePageEdit = page.getByRole("dialog", { name: "編輯固定行程" });
  await samePageEdit
    .getByRole("group", { name: "開始（當地時間）" })
    .getByLabel("當地日期與時間")
    .fill("2027-11-01T11:00");
  await samePageEdit.getByRole("button", { name: "儲存固定行程" }).click();
  await expect(samePageEdit).toHaveCount(0);

  await tripInformationFlight.getByRole("button", { name: "編輯「SFO to Haneda」" }).click();
  samePageEdit = page.getByRole("dialog", { name: "編輯固定行程" });
  await expect(
    samePageEdit.getByRole("group", { name: "開始（當地時間）" }).getByLabel("當地日期與時間"),
  ).toHaveValue("2027-11-01T11:00");
  await samePageEdit.getByLabel("備註", { exact: true }).fill("Retain the refreshed departure time");
  await samePageEdit.getByRole("button", { name: "儲存固定行程" }).click();
  await expect(samePageEdit).toHaveCount(0);

  const secondContext = await browser.newContext({
    storageState: authState,
    timezoneId: "Pacific/Honolulu",
    viewport: { width: 1180, height: 900 },
  });
  const secondPage = await secondContext.newPage();
  await secondPage.goto("/");
  await openTrip(secondPage, name);
  const secondTimeline = secondPage.getByRole("region", { name: "每日行程", exact: true });
  const secondFlight = secondTimeline.locator(".itinerary-card").filter({ hasText: "SFO to Haneda" }).first();

  await flightCard.getByRole("button", { name: "編輯「SFO to Haneda」" }).click();
  await secondFlight.getByRole("button", { name: "編輯「SFO to Haneda」" }).click();
  const firstEdit = page.getByRole("dialog", { name: "編輯固定行程" });
  const secondEdit = secondPage.getByRole("dialog", { name: "編輯固定行程" });
  await firstEdit.getByLabel("標題").fill("SFO to Haneda · family confirmed");
  await secondEdit.getByLabel("標題").fill("SFO to Haneda · stale overwrite");
  await firstEdit.getByRole("button", { name: "儲存固定行程" }).click();
  await expect(firstEdit).toHaveCount(0);
  await secondEdit.getByRole("button", { name: "儲存固定行程" }).click();
  await expect(secondEdit.getByRole("alert")).toContainText("資料已變更，無法完成操作。");
  await expect(secondEdit.getByRole("alert")).toContainText("目前版本：");
  await expect(secondEdit.getByLabel("標題")).toHaveValue("SFO to Haneda · stale overwrite");

  await page.reload();
  await openTrip(page, name);
  await expect(page.getByText("SFO to Haneda · family confirmed").first()).toBeVisible();
  await expect(page.getByText("SFO to Haneda · stale overwrite")).toHaveCount(0);
  await expect(page.getByText("修改了固定行程").first()).toBeVisible();

  const mobileContext = await browser.newContext({
    storageState: authState,
    timezoneId: "Europe/London",
    viewport: { width: 390, height: 844 },
  });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto("/");
  await openTrip(mobilePage, name);
  await expect(mobilePage.getByText("SFO to Haneda · family confirmed").first()).toBeVisible();
  await expect(mobilePage.getByText(/2027-11-01 11:00 · America\/Los_Angeles \(.+, -07:00\)/).first()).toBeVisible();
  await expect(mobilePage.getByText(/2027-11-02 14:00 · Asia\/Tokyo \(.+, \+09:00\)/).first()).toBeVisible();
  const shellBox = await mobilePage.locator(".trip-skeleton-shell").boundingBox();
  expect(shellBox?.x).toBeGreaterThanOrEqual(0);
  expect(shellBox ? shellBox.x + shellBox.width : Number.POSITIVE_INFINITY).toBeLessThanOrEqual(390);

  await Promise.all([desktopContext.close(), secondContext.close(), mobileContext.close()]);
});

test("activity participants persist exact subsets, history, times, and concurrency", async ({
  browser,
  request,
}) => {
  test.setTimeout(300_000);
  await request.delete(`${MAILPIT_API_URL}/api/v1/messages`);
  const stamp = Date.now();
  const name = `大阪京都家庭旅行 participants ${stamp}`;
  const participantA = `participant-a-${stamp}@example.test`;
  const participantB = `participant-b-${stamp}@example.test`;
  const fourthParticipant = `participant-four-${stamp}@example.test`;
  const ownerEmail = "owner@example.test";
  const ownerContext = await browser.newContext({
    timezoneId: "Pacific/Honolulu",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await ownerContext.newPage();
  await signIn(page, request, ownerEmail);
  await createTrip(page, {
    name,
    startDate: "2027-03-10",
    endDate: "2027-03-11",
    countries: [{ query: "Japan", code: "JP" }],
  });

  const editorContexts: BrowserContext[] = [];
  const editorPages: Page[] = [];
  for (const email of [participantA, participantB, fourthParticipant]) {
    const inviteLink = await inviteEditor(page, request, name, email);
    const context = await browser.newContext();
    editorContexts.push(context);
    editorPages.push(
      await acceptEditor(context, request, name, email, inviteLink),
    );
  }

  await page.reload();
  await openTrip(page, name);
  await expect(page.getByText("4位成員", { exact: true })).toBeVisible();
  await createPlace(page, {
    name: "Participant activity venue",
    type: "activity",
    address: "Osaka",
    latitude: "34.6937",
    longitude: "135.5023",
    timeZone: "Asia/Tokyo",
  });

  await addParticipantActivity(page, {
    title: "甲",
    endpoint: {
      stop: "1、JP",
      place: "Participant activity venue",
      local: "2027-03-10T10:00",
      zone: "Asia/Tokyo",
    },
    durationMinutes: "120",
    participantEmails: [participantA],
    expectedRosterSize: 4,
  });
  await addParticipantActivity(page, {
    title: "乙",
    endpoint: {
      stop: "1、JP",
      place: "Participant activity venue",
      local: "2027-03-10T11:00",
      zone: "Asia/Tokyo",
    },
    durationMinutes: "120",
    participantEmails: [participantB],
    expectedRosterSize: 4,
  });
  await addParticipantActivity(page, {
    title: "Participation pending",
    endpoint: {
      stop: "1、JP",
      place: "Participant activity venue",
      local: "2027-03-10T14:00",
      zone: "Asia/Tokyo",
    },
    durationMinutes: "60",
    participantEmails: [],
    expectedRosterSize: 4,
  });

  let alphaCard = timelineCard(page, "甲");
  let betaCard = timelineCard(page, "乙");
  const pendingCard = timelineCard(page, "Participation pending");
  await expect(alphaCard).toContainText("開始： 2027-03-10 10:00");
  await expect(alphaCard).toContainText("結束： 2027-03-10 12:00");
  await expect(betaCard).toContainText("開始： 2027-03-10 11:00");
  await expect(betaCard).toContainText("結束： 2027-03-10 13:00");
  await expect(alphaCard.locator('[aria-label="參與成員"]')).toContainText(participantA);
  await expect(alphaCard.locator('[aria-label="參與成員"]')).not.toContainText(participantB);
  await expect(betaCard.locator('[aria-label="參與成員"]')).toContainText(participantB);
  await expect(betaCard.locator('[aria-label="參與成員"]')).not.toContainText(participantA);
  await expect(pendingCard.locator('[aria-label="參與成員"]')).toContainText(
    "待確認",
  );

  await page.reload();
  await openTrip(page, name);
  alphaCard = timelineCard(page, "甲");
  betaCard = timelineCard(page, "乙");
  await expect(alphaCard).toContainText("結束： 2027-03-10 12:00");
  await expect(betaCard).toContainText("結束： 2027-03-10 13:00");
  await expect(alphaCard.locator('[aria-label="參與成員"]')).toContainText(participantA);
  await expect(alphaCard.locator('[aria-label="參與成員"]')).not.toContainText(participantB);
  await expect(betaCard.locator('[aria-label="參與成員"]')).toContainText(participantB);
  await expect(betaCard.locator('[aria-label="參與成員"]')).not.toContainText(participantA);
  await expect(
    timelineCard(page, "Participation pending").locator('[aria-label="參與成員"]'),
  ).toContainText("待確認");
  const id = await tripIdentifier(page, name);
  const trip = await readTrip(page, id);
  const memberA = trip.members.find((member) => member.email === participantA);
  const memberB = trip.members.find((member) => member.email === participantB);
  const memberFour = trip.members.find((member) => member.email === fourthParticipant);
  if (!memberA || !memberB || !memberFour) throw new Error("Invited members were not returned");
  expect(memberA.id).not.toBe(memberA.userId);
  expect(memberB.id).not.toBe(memberB.userId);
  expect(memberFour.id).not.toBe(memberFour.userId);
  let skeleton = await readSkeleton(page, id);
  let alphaItem = skeleton.items.find((item) => item.title === "甲");
  let betaItem = skeleton.items.find((item) => item.title === "乙");
  const pendingItem = skeleton.items.find((item) => item.title === "Participation pending");
  if (!alphaItem || !betaItem || !pendingItem) throw new Error("Participant activities were not returned");
  expect(alphaItem.participants?.map((participant) => participant.memberId)).toEqual([memberA.id]);
  expect(betaItem.participants?.map((participant) => participant.memberId)).toEqual([memberB.id]);
  expect(pendingItem.participants).toBeNull();

  const stableAlphaId = alphaItem.id;
  await alphaCard.getByRole("button", { name: "編輯「甲」" }).click();
  let editDialog = page.getByRole("dialog", { name: "編輯固定行程" });
  await expect(participantCheckbox(editDialog, participantA)).toBeChecked();
  await expect(participantCheckbox(editDialog, participantB)).not.toBeChecked();
  await participantCheckbox(editDialog, participantB).check();
  await editDialog.getByRole("button", { name: "儲存固定行程" }).click();
  await expect(editDialog).toHaveCount(0);
  alphaCard = timelineCard(page, "甲");
  await expect(alphaCard).toHaveAttribute("data-item-id", stableAlphaId);
  await expect(alphaCard.locator('[aria-label="參與成員"]')).toContainText(participantA);
  await expect(alphaCard.locator('[aria-label="參與成員"]')).toContainText(participantB);

  await alphaCard.getByRole("button", { name: "編輯「甲」" }).click();
  editDialog = page.getByRole("dialog", { name: "編輯固定行程" });
  await participantCheckbox(editDialog, participantB).uncheck();
  await editDialog.press("Escape");
  await alphaCard.getByRole("button", { name: "編輯「甲」" }).click();
  editDialog = page.getByRole("dialog", { name: "編輯固定行程" });
  await expect(participantCheckbox(editDialog, participantB)).toBeChecked();
  await editDialog.press("Escape");

  skeleton = await readSkeleton(page, id);
  alphaItem = skeleton.items.find((item) => item.id === stableAlphaId);
  expect(alphaItem?.participants?.map((participant) => participant.memberId).sort()).toEqual(
    [memberA.id, memberB.id].sort(),
  );
  await page.reload();
  await openTrip(page, name);
  alphaCard = timelineCard(page, "甲");
  await expect(alphaCard).toHaveAttribute("data-item-id", stableAlphaId);
  await expect(alphaCard.locator('[aria-label="參與成員"]')).toContainText(participantA);
  await expect(alphaCard.locator('[aria-label="參與成員"]')).toContainText(participantB);


  const fourthPage = editorPages[2]!;
  await fourthPage.reload();
  await openTrip(fourthPage, name);
  betaCard = timelineCard(page, "乙");
  const fourthBetaCard = timelineCard(fourthPage, "乙");
  await betaCard.getByRole("button", { name: "編輯「乙」" }).click();
  await fourthBetaCard.getByRole("button", { name: "編輯「乙」" }).click();
  const ownerEdit = page.getByRole("dialog", { name: "編輯固定行程" });
  const staleEdit = fourthPage.getByRole("dialog", { name: "編輯固定行程" });
  await participantCheckbox(ownerEdit, fourthParticipant).check();
  await participantCheckbox(staleEdit, participantA).check();
  await ownerEdit.getByRole("button", { name: "儲存固定行程" }).click();
  await expect(ownerEdit).toHaveCount(0);
  await staleEdit.getByRole("button", { name: "儲存固定行程" }).click();
  await expect(staleEdit.getByRole("alert")).toContainText("資料已變更，無法完成操作。");
  await expect(staleEdit.getByRole("alert")).toContainText("目前版本：");
  await expect(participantCheckbox(staleEdit, participantA)).toBeChecked();
  await expect(participantCheckbox(staleEdit, participantB)).toBeChecked();
  await staleEdit.press("Escape");

  betaCard = timelineCard(page, "乙");
  await expect(betaCard.locator('[aria-label="參與成員"]')).toContainText(
    fourthParticipant,
  );
  skeleton = await readSkeleton(page, id);
  betaItem = skeleton.items.find((item) => item.title === "乙");
  expect(betaItem?.participants?.map((participant) => participant.memberId).sort()).toEqual(
    [memberB.id, memberFour.id].sort(),
  );

  await betaCard.getByRole("button", { name: "鎖定" }).click();
  await expect(betaCard.getByText("已鎖定", { exact: true })).toBeVisible();
  await expect(betaCard.getByRole("button", { name: "編輯「乙」" })).toHaveCount(0);
  await betaCard.getByRole("button", { name: "解鎖" }).click();
  const unlockDialog = page.getByRole("dialog", { name: "要解鎖「乙」嗎？" });
  await unlockDialog.getByRole("button", { name: "解鎖固定行程" }).click();
  await expect(betaCard.getByRole("button", { name: "編輯「乙」" })).toBeVisible();

  const membersPanel = page.getByRole("heading", { name: "成員", exact: true }).locator("..");
  const memberARow = membersPanel.getByRole("listitem").filter({ hasText: participantA });
  await memberARow.getByRole("button", { name: "移除" }).click();
  await expect(memberARow).toHaveCount(0);
  await page.reload();
  await openTrip(page, name);
  alphaCard = timelineCard(page, "甲");
  await expect(alphaCard).toHaveAttribute("data-item-id", stableAlphaId);
  const alphaParticipants = alphaCard.locator('[aria-label="參與成員"]');
  await expect(alphaParticipants).toContainText(participantA);
  await expect(alphaParticipants).toContainText("已移除");
  await expect(alphaParticipants).toContainText(participantB);
  await expect(
    timelineCard(page, "乙").locator('[aria-label="參與成員"]'),
  ).toContainText(fourthParticipant);

  const tripAfterRemoval = await readTrip(page, id);
  expect(tripAfterRemoval.members.some((member) => member.id === memberA.id)).toBe(false);
  skeleton = await readSkeleton(page, id);
  alphaItem = skeleton.items.find((item) => item.id === stableAlphaId);
  const removedParticipant = alphaItem?.participants?.find(
    (participant) => participant.memberId === memberA.id,
  );
  expect(removedParticipant).toMatchObject({
    email: participantA,
    removed: true,
  });

  await alphaCard.getByRole("button", { name: "編輯「甲」" }).click();
  editDialog = page.getByRole("dialog", { name: "編輯固定行程" });
  const participantGroup = editDialog.getByRole("group", { name: "參與成員" });
  await expect(participantGroup.getByRole("checkbox")).toHaveCount(4);
  await expect(participantGroup).toContainText("已不是旅程成員");
  await expect(participantCheckbox(editDialog, participantA)).toBeChecked();
  await expect(participantCheckbox(editDialog, participantB)).toBeChecked();
  await editDialog.getByLabel("備註", { exact: true }).fill(
    "Ordinary edit retains the removed participant",
  );
  await editDialog.getByRole("button", { name: "儲存固定行程" }).click();
  await expect(editDialog).toHaveCount(0);
  alphaCard = timelineCard(page, "甲");
  await expect(alphaCard.locator('[aria-label="參與成員"]')).toContainText(participantA);
  await expect(alphaCard.locator('[aria-label="參與成員"]')).toContainText("已移除");
  skeleton = await readSkeleton(page, id);
  alphaItem = skeleton.items.find((item) => item.id === stableAlphaId);
  expect(alphaItem?.participants?.map((participant) => participant.memberId).sort()).toEqual(
    [memberA.id, memberB.id].sort(),
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await alphaCard.scrollIntoViewIfNeeded();
  await expect(alphaCard.locator('[aria-label="參與成員"]')).toContainText(participantA);
  await expect(alphaCard.locator('[aria-label="參與成員"]')).toContainText(participantB);
  const mobileWidths = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(mobileWidths.document).toBeLessThanOrEqual(mobileWidths.viewport);

  await alphaCard.getByRole("button", { name: "編輯「甲」" }).click();
  const mobileEditDialog = page.getByRole("dialog", { name: "編輯固定行程" });
  const mobileParticipantGroup = mobileEditDialog.getByRole("group", { name: "參與成員" });
  await expect(mobileParticipantGroup).toContainText(participantA);
  await expect(mobileParticipantGroup).toContainText(participantB);
  await expect(participantCheckbox(mobileEditDialog, participantA)).toBeChecked();
  await expect(participantCheckbox(mobileEditDialog, participantB)).toBeChecked();
  const mobilePickerWidths = await mobileParticipantGroup.evaluate((element) => ({
    visible: element.clientWidth,
    content: element.scrollWidth,
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    labels: [...element.querySelectorAll("label")].map((label) => {
      const contents = document.createRange();
      contents.selectNodeContents(label);
      return {
        rowBottom: label.getBoundingClientRect().bottom,
        contentBottom: contents.getBoundingClientRect().bottom,
      };
    }),
  }));
  expect(mobilePickerWidths.content).toBeLessThanOrEqual(mobilePickerWidths.visible);
  expect(mobilePickerWidths.document).toBeLessThanOrEqual(mobilePickerWidths.viewport);
  for (const label of mobilePickerWidths.labels) {
    expect(label.contentBottom).toBeLessThanOrEqual(label.rowBottom);
  }
  await mobileEditDialog.press("Escape");

  await Promise.all([
    ownerContext.close(),
    ...editorContexts.map((context) => context.close()),
  ]);
});
