import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { parseSessionResponse, parseTripResponse, type TripDto } from "@along-the-way/contracts/private-trips";
import { parseItineraryItemResponse, parsePlaceResponse } from "@along-the-way/contracts/trip-skeleton";

const mailpit = process.env.MAILPIT_API_URL ?? "http://127.0.0.1:8025";
const exec = promisify(execFile);
const createdTrips: string[] = [];
async function database(sql: string) {
  await exec("docker", ["compose", "--project-name", process.env.E2E_COMPOSE_PROJECT ?? "along-the-way", "exec", "--no-TTY", "db", "psql", "--username", process.env.POSTGRES_ADMIN_USER ?? "along_the_way_admin_test", "--dbname", process.env.POSTGRES_DB ?? "along_the_way_test", "--set", "ON_ERROR_STOP=1", "--command", sql]);
}
test.beforeEach(() => database("truncate table rate_limit_windows"));
test.afterAll(async () => {
  if (createdTrips.length) {
    const ids = createdTrips.map((id) => `'${id}'`).join(",");
    await database(`delete from itinerary_items where trip_id in (${ids}); delete from trips where id in (${ids});`);
  }
});

async function mutate(request: APIRequestContext, origin: string, path: string, data: unknown, method = "POST") {
  const response = await request.fetch(path, { method, headers: { Origin: origin, "Idempotency-Key": crypto.randomUUID() }, data });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return response.status() === 204 ? null : response.json();
}
async function deliveredLink(request: APIRequestContext, email: string, subject: string, send: () => Promise<unknown>) {
  const before = await request.get(`${mailpit}/api/v1/messages`).then((response) => response.json());
  const previous = new Set<string>(before.messages.map((message: { ID: string }) => message.ID));
  await send();
  let id = "";
  await expect.poll(async () => {
    const data = await request.get(`${mailpit}/api/v1/messages`).then((response) => response.json());
    id = data.messages.find((message: { ID: string; Subject: string; To: Array<{ Address: string }> }) => !previous.has(message.ID) && message.Subject.includes(subject) && message.To.some((recipient) => recipient.Address === email))?.ID ?? "";
    return id;
  }).not.toBe("");
  const message = await request.get(`${mailpit}/api/v1/message/${id}`).then((response) => response.json());
  const link = String(message.Text).match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error("Email link missing");
  return new URL(link);
}
async function signIn(context: BrowserContext, origin: string, email: string, inviteToken?: string) {
  const link = await deliveredLink(context.request, email, "Sign in to Along the Way", () => mutate(context.request, origin, "/api/auth/magic-links", { email, ...(inviteToken ? { inviteToken } : {}) }));
  const token = new URLSearchParams(link.hash.slice(1)).get("magicToken");
  const session = parseSessionResponse(await mutate(context.request, origin, "/api/auth/magic-links/consume", { token }));
  if (inviteToken) await mutate(context.request, origin, "/api/invites/accept", { token: inviteToken });
  return session.user;
}
async function createTrip(request: APIRequestContext, origin: string, name: string, country = "JP", zone = "Asia/Tokyo", start = "2026-10-21", end = "2026-10-23") {
  const flight = (date: string, hour: string) => ({ serviceNumber: `TEST-${hour}`, carrier: null, departureAirport: { name: "Test departure", timeZone: zone }, arrivalAirport: { name: "Test arrival", timeZone: zone }, departureLocalDateTime: `${date}T${hour}:00`, arrivalLocalDateTime: `${date}T${String(Number(hour) + 1).padStart(2, "0")}:00` });
  const outbound = country === "JP" ? { ...flight(start, "08"), serviceNumber: "TEST-OUTBOUND",
    departureAirport: { name: "台北", timeZone: "Asia/Taipei" }, arrivalAirport: { name: "東京", timeZone: "Asia/Tokyo" },
    departureLocalDateTime: `${start}T09:00`, arrivalLocalDateTime: `${start}T12:30` } : flight(start, "08");
  const trip = parseTripResponse(await mutate(request, origin, "/api/trips", { name, startDate: start, endDate: end, countryCodes: [country], flights: { outbound, return: flight(end, "20") } })).trip;
  createdTrips.push(trip.id);
  return trip;
}
async function activity(request: APIRequestContext, origin: string, trip: TripDto, placeId: string, title: string, hour: string, durationMinutes: number, participantMemberIds: string[] | null) {
  const current = parseTripResponse(await request.get(`/api/trips/${trip.id}`).then((response) => response.json())).trip;
  return parseItineraryItemResponse(await mutate(request, origin, `/api/trips/${trip.id}/items`, {
    expectedTripVersion: current.version,
    type: "activity", title, participantMemberIds, notes: "第一方重要備註", sourceUrl: "https://example.com/official",
    endpoints: [{ role: "start", countryStopId: trip.countryStops[0]!.id, placeId, localDateTime: `2026-10-21T${hour.includes(":") ? hour : `${hour}:00`}`, timeZone: "Asia/Tokyo" }],
    details: { durationMinutes, bookedBy: null, confirmationStatus: "請確認開放時間" },
  })).item;
}

// Run against the production web build: the worker is deliberately not installed by Vite dev.
test("phone Today keeps parallel participants, URL days, private offline snapshots and another zone", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const origin = new URL(baseURL!).origin;
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce" });
  const peers: BrowserContext[] = [];
  try {
    const owner = await signIn(context, origin, "owner@example.test");
    let trip = await createTrip(context.request, origin, `Today issue28 ${Date.now()}`);
    for (let index = 0; index < 3; index++) {
      const email = `today28-${index}-${Date.now()}@example.test`;
      const invite = await deliveredLink(context.request, email, `Join ${trip.name}`, () => mutate(context.request, origin, `/api/trips/${trip.id}/invites`, { email }));
      const peer = await browser.newContext({ baseURL });
      peers.push(peer);
      await signIn(peer, origin, email, new URLSearchParams(invite.hash.slice(1)).get("inviteToken")!);
    }
    trip = parseTripResponse(await context.request.get(`/api/trips/${trip.id}`).then((response) => response.json())).trip;
    expect(trip.members).toHaveLength(4);
    const memberA = trip.members.find((member) => member.userId === owner.id)!;
    const peerSession = parseSessionResponse(await peers[0]!.request.get("/api/session").then((response) => response.json()));
    const memberB = trip.members.find((member) => member.userId === peerSession.user.id)!;
    const place = parsePlaceResponse(await mutate(context.request, origin, `/api/trips/${trip.id}/places`, { expectedTripVersion: trip.version, name: "測試庭園", type: "activity", address: "測試地址", latitude: 34.68, longitude: 135.5, timeZone: "Asia/Tokyo" })).place;
    await activity(context.request, origin, trip, place.id, "甲的 A", "10", 120, [memberA.id]);
    await activity(context.request, origin, trip, place.id, "乙的 B", "11", 120, [memberB.id]);
    const next = await activity(context.request, origin, trip, place.id, "甲的下一項", "14", 60, [memberA.id]);
    await activity(context.request, origin, trip, place.id, "參與待確認", "11", 60, null);
    const otherItem = await activity(context.request, origin, trip, place.id, "其他兩位的安排", "14", 60, trip.members.filter((member) => member.id !== memberA.id && member.id !== memberB.id).map((member) => member.id));
    await activity(context.request, origin, trip, place.id, "跨午夜活動", "23:30", 120, [memberA.id]);
    // A located lodging fixes these TripDays in Tokyo, independently of the outbound Taipei endpoint.
    trip = parseTripResponse(await context.request.get(`/api/trips/${trip.id}`).then((response) => response.json())).trip;
    const hotel = parsePlaceResponse(await mutate(context.request, origin, `/api/trips/${trip.id}/places`, { expectedTripVersion: trip.version, name: "東京住宿", type: "lodging", latitude: 35.68, longitude: 139.76, timeZone: "Asia/Tokyo" })).place;
    trip = parseTripResponse(await context.request.get(`/api/trips/${trip.id}`).then((response) => response.json())).trip;
    await mutate(context.request, origin, `/api/trips/${trip.id}/items`, {
      expectedTripVersion: trip.version, type: "lodging", title: "跨日住宿", participantMemberIds: [memberA.id],
      endpoints: [
        { role: "start", countryStopId: trip.countryStops[0]!.id, placeId: hotel.id, localDateTime: "2026-10-21T15:00", timeZone: "Asia/Tokyo" },
        { role: "end", countryStopId: trip.countryStops[0]!.id, placeId: hotel.id, localDateTime: "2026-10-23T10:00", timeZone: "Asia/Tokyo" },
      ],
      details: { bookedBy: null, confirmationCode: null },
    });
    // A newer-listed trip must never replace the trip explicitly selected in the URL.
    const other = await createTrip(context.request, origin, `Today California ${Date.now()}`, "US", "America/Los_Angeles", "2026-10-20", "2026-10-22");
    const page = await context.newPage();
    // Only pin Date: real browser/network recovery timers keep running unchanged.
    await page.clock.setFixedTime(new Date("2026-10-21T02:30:00Z"));
    await page.goto(`/?trip=${trip.id}`);
    await expect(page.getByRole("tab", { name: "今天", exact: true })).toHaveAttribute("aria-selected", "true");
    const today = page.getByRole("tabpanel", { name: "今天", exact: true });
    const group = today.getByRole("region", { name: "全團時間線" });
    const personal = today.getByRole("region", { name: "我的目前與下一步" });
    const cardA = group.getByRole("article", { name: "甲的 A" });
    const cardB = group.getByRole("article", { name: "乙的 B" });
    await expect(cardA).toContainText(/10:00.*12:00/);
    await expect(cardB).toContainText(/11:00.*13:00/);
    await expect(group.getByRole("article").filter({ hasText: "TEST-OUTBOUND" }).locator("p").first()).toContainText(/09:00.*台北.*Asia\/Taipei.*12:30.*東京.*Asia\/Tokyo/);
    for (const card of [cardA, cardB]) { await expect(card).toContainText("並行"); await expect(card).toContainText("進行中"); }
    await expect(cardA).toContainText(memberA.email);
    await expect(cardB).toContainText(memberB.email);
    await expect(personal).toContainText("進行中：甲的 A");
    await expect(personal).toContainText("下一項：甲的下一項");
    await expect(personal).not.toContainText("乙的 B");
    await expect(personal).not.toContainText("參與待確認");
    await expect(group.getByRole("article", { name: "參與待確認" }).getByText("參與者待確認", { exact: true })).toHaveCount(1);
    await expect(group.getByRole("link", { name: /起終點導航/ })).toHaveCount(0);
    await expect(cardA.getByRole("link", { name: /Google Maps 地點/ })).toHaveAttribute("href", /query=34.68%2C135.5/);
    await expect(cardA.getByRole("link", { name: /Google Maps 地點/ })).toHaveAttribute("rel", "noopener noreferrer");
    await cardA.getByText("重要備註", { exact: true }).click();
    await expect(cardA).toContainText("第一方重要備註");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const boxes = await Promise.all([cardA.boundingBox(), cardB.boundingBox()]);
    expect(boxes[1]!.y).toBeGreaterThanOrEqual(boxes[0]!.y + boxes[0]!.height);
    await page.clock.setFixedTime(new Date("2026-10-21T15:30:00Z"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("combobox", { name: "行程日期", exact: true }).selectOption("2026-10-22");
    await expect(personal).toContainText("進行中：跨午夜活動");
    await expect(group.getByRole("article", { name: "跨午夜活動" })).toContainText("進行中");
    await expect(group.getByRole("article", { name: "跨日住宿" })).toContainText("進行中");
    await page.clock.setFixedTime(new Date("2026-10-21T02:30:00Z"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("combobox", { name: "行程日期", exact: true }).selectOption("2026-10-21");
    await today.getByRole("button", { name: "前一天", exact: true }).focus();
    await expect(today.getByRole("button", { name: "前一天", exact: true })).toBeDisabled();
    await today.getByRole("button", { name: "後一天", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`trip=${trip.id}.*tab=today.*day=2026-10-22`));
    await page.reload();
    await expect(page.getByRole("combobox", { name: "行程日期", exact: true })).toHaveValue("2026-10-22");
    await page.getByRole("combobox", { name: "行程日期", exact: true }).selectOption("2026-10-23");
    await expect(today.getByRole("button", { name: "後一天", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: new RegExp(other.name) }).click();
    await expect(page.getByRole("combobox", { name: "行程日期", exact: true })).toHaveValue("2026-10-20");
    let releaseBack!: () => void;
    const backRead = new Promise<void>((resolve) => { releaseBack = resolve; });
    await page.route(`**/api/trips/${trip.id}`, async (route) => { await backRead; await route.continue(); });
    try {
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`trip=${trip.id}.*day=2026-10-23`));
    } finally { releaseBack(); }
    await expect(page.getByRole("combobox", { name: "行程日期", exact: true })).toHaveValue("2026-10-23");
    await page.unroute(`**/api/trips/${trip.id}`);
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`trip=${other.id}.*day=2026-10-20`));
    await page.goBack();
    await expect(page.getByRole("combobox", { name: "行程日期", exact: true })).toHaveValue("2026-10-23");
    await page.getByRole("combobox", { name: "行程日期", exact: true }).selectOption("2026-10-21");
    // Desktop still preserves both overlapping activities, rather than one shared current item.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(cardA).toContainText("進行中"); await expect(cardB).toContainText("進行中");
    await page.setViewportSize({ width: 390, height: 844 });
    const beta = await peers[0]!.newPage();
    await beta.clock.setFixedTime(new Date("2026-10-21T02:30:00Z"));
    await beta.goto(`/?trip=${trip.id}&tab=today`);
    await expect(beta.getByRole("region", { name: "我的目前與下一步" })).toContainText("進行中：乙的 B");
    await expect(beta.getByRole("region", { name: "我的目前與下一步" })).not.toContainText("甲的 A");
    await beta.close();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    const mutations: string[] = [];
    page.on("request", (request) => { if (request.url().includes("/api/") && !["GET", "HEAD"].includes(request.method())) mutations.push(request.url()); });
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "離線資料", exact: true })).toBeVisible();
    await expect(page.getByText(/快照時間：/)).toBeVisible();
    await expect(page.getByRole("article", { name: "甲的 A" })).toBeVisible();
    await expect(page.getByRole("button", { name: /編輯|建立|確認|儲存|重新排程/ })).toHaveCount(0);
    await page.getByRole("combobox", { name: "行程日期", exact: true }).selectOption("2026-10-22");
    await page.getByRole("combobox", { name: "行程日期", exact: true }).selectOption("2026-10-21");
    expect(mutations).toEqual([]);
    // Change the formal itinerary from another authenticated online context while this phone is offline.
    const online = await browser.newContext({ baseURL, storageState: await context.storageState() });
    await mutate(online.request, origin, `/api/trips/${trip.id}/items/${next.id}`, { expectedVersion: next.version }, "DELETE");
    await context.setOffline(false);
    await expect(page.getByRole("heading", { name: "離線資料", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "我的目前與下一步" })).not.toContainText("甲的下一項");
    const stored = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("along-the-way:today:")).map(([, value]) => value));
    expect(stored.join(" ")).not.toContain("甲的下一項");
    // API unavailability has the same read-only boundary, without requiring a disconnected radio.
    await page.route(`**/api/trips/${trip.id}/skeleton`, (route) => route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Unavailable" } } }));
    await page.getByRole("button", { name: "重新同步", exact: true }).click();
    await expect(page.getByRole("heading", { name: "離線資料", exact: true })).toBeVisible();
    await page.unroute(`**/api/trips/${trip.id}/skeleton`);
    await page.getByRole("button", { name: "重新連線並同步" }).click();
    await expect(page.getByRole("tab", { name: "今天", exact: true })).toBeVisible();
    await mutate(online.request, origin, `/api/trips/${trip.id}/items/${otherItem.id}`, { expectedVersion: otherItem.version }, "DELETE");
    await page.getByRole("button", { name: "重新同步", exact: true }).click();
    await expect(group.getByRole("article", { name: "其他兩位的安排" })).toHaveCount(0);
    await page.getByRole("tab", { name: "行程", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "行程", exact: true })).not.toContainText("其他兩位的安排");
    await page.getByRole("tab", { name: "今天", exact: true }).click();
    await page.goto(`/?trip=${other.id}`);
    await expect(page.getByRole("tab", { name: "今天", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("combobox", { name: "行程日期", exact: true })).toHaveValue("2026-10-20");
    await expect(page.getByRole("heading", { name: /2026-10-20 · America\/Los_Angeles/ })).toBeVisible();
    // Revocation of an unselected saved trip must be learned from the authorized trip list.
    const revoked = await peers[0]!.newPage();
    await revoked.clock.setFixedTime(new Date("2026-10-21T02:30:00Z"));
    await revoked.goto(`/?trip=${trip.id}&tab=today`);
    await expect(revoked.getByRole("article", { name: "乙的 B" })).toBeVisible();
    const retained = await createTrip(peers[0]!.request, origin, `Retained member trip ${Date.now()}`);
    await revoked.goto(`/?trip=${retained.id}&tab=today`);
    await expect(revoked.getByRole("heading", { name: retained.name, exact: true })).toBeVisible();
    await peers[0]!.setOffline(true);
    await mutate(online.request, origin, `/api/trips/${trip.id}/members/${memberB.userId}`, undefined, "DELETE");
    await peers[0]!.setOffline(false);
    await expect(revoked.getByRole("tab", { name: "今天", exact: true })).toBeVisible();
    await expect.poll(() => revoked.evaluate((id) => Object.keys(localStorage).some((key) => key.startsWith("along-the-way:today:") && key.endsWith(`:${id}`)), trip.id)).toBe(false);
    await revoked.goto(`/?trip=${trip.id}&tab=today`);
    await expect(revoked.getByLabel("電子郵件")).toHaveCount(0);
    await revoked.getByRole("button", { name: new RegExp(retained.name) }).click();
    await expect(revoked.getByRole("tab", { name: "今天", exact: true })).toBeVisible();
    await online.close();
    await context.setOffline(true);
    await expect(page.getByRole("heading", { name: "離線資料", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "登出", exact: true }).click();
    expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("along-the-way:today:")))).toEqual([]);
    await context.setOffline(false);
    await page.reload();
    await expect(page.getByLabel("電子郵件")).toBeVisible();
  } finally {
    await context.close();
    for (const peer of peers) await peer.close();
  }
});
