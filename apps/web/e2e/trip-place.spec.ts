import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { isRecord } from "@along-the-way/contracts/private-trips";
import { fillTripFlights } from "./travel-support";

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

async function signIn(page: Page, request: APIRequestContext, email: string) {
  await page.goto("/");
  const previousResponse = await request.get(`${MAILPIT_API_URL}/api/v1/messages`);
  const previousIds = new Set(messages(await previousResponse.json()).map((message) => message.id));
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
  const country = dialog.getByLabel("新增國家");
  await country.fill("Japan");
  await page.getByRole("option", { name: /\(JP\)/ }).dispatchEvent("click");
  await fillTripFlights(dialog, "2026-11-03", "2026-11-09");
  await dialog.getByRole("button", { name: "建立旅程", exact: true }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function openTab(page: Page, name: "想去清單" | "行程") {
  await page.getByRole("tab", { name, exact: true }).click();
}

async function addManualPlace(
  page: Page,
  input: { name: string; address?: string; note: string; sourceUrl?: string },
) {
  await openTab(page, "想去清單");
  await page.getByRole("button", { name: "新增想去地點" }).click();
  const dialog = page.getByRole("dialog", { name: "新增地點" });
  await dialog.getByRole("tab", { name: "手動輸入" }).click();
  await dialog.getByLabel("地點名稱").fill(input.name);
  await dialog.getByLabel("地點類型").selectOption("restaurant");
  if (input.address) await dialog.getByLabel("地址（若知道）").fill(input.address);
  await dialog.getByLabel("地點備註").fill(input.note);
  if (input.sourceUrl) await dialog.getByLabel("來源連結（若有）").fill(input.sourceUrl);
  await dialog.getByRole("button", { name: "手動新增地點" }).click();
  await expect(dialog).toHaveCount(0);
}

async function addSkeletonPlace(
  page: Page,
  input: { name: string; address: string; note: string },
) {
  await openTab(page, "行程");
  await page.getByRole("button", { name: "新增地點", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增地點" });
  await dialog.getByLabel("地點名稱").fill(input.name);
  await dialog.getByLabel("地點類型").selectOption("restaurant");
  await dialog.getByLabel("地址").fill(input.address);
  await dialog.getByLabel("備註").fill(input.note);
  await dialog.getByRole("button", { name: "儲存地點" }).click();
  await expect(dialog).toHaveCount(0);
}

async function addTimedActivity(
  page: Page,
  input: { title: string; place: string; localDateTime: string },
) {
  await openTab(page, "行程");
  await page.getByRole("button", { name: "新增固定行程" }).click();
  const dialog = page.getByRole("dialog", { name: "新增固定行程" });
  await dialog.getByLabel("類型").selectOption("activity");
  await dialog.getByLabel("標題").fill(input.title);
  const start = dialog.getByRole("group", { name: "開始（當地時間）" });
  await start.getByLabel("停留國家").selectOption({ label: "1、JP" });
  await start.getByLabel("地點").selectOption({ label: input.place });
  await start.getByLabel("當地日期與時間").fill(input.localDateTime);
  const timeZone = start.getByLabel("IANA 時區");
  if (await timeZone.inputValue() !== "Asia/Tokyo") {
    await timeZone.fill("Asia/Tokyo");
  }
  await dialog.getByLabel("期間（分鐘）").fill("60");
  await dialog.getByLabel("預訂者").fill("Wishlist owner");
  await dialog.locator("#appointment-status").fill("Confirmed");
  await dialog.getByLabel("限制").selectOption("fixed_time");
  await dialog.locator("#constraint-status").selectOption("confirmed");
  await dialog.getByRole("button", { name: "儲存固定行程" }).click();
  await expect(dialog).toHaveCount(0);
}

async function setVote(page: Page, placeName: string) {
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: placeName, exact: true }) });
  await card.getByRole("button", { name: "投票", exact: true }).click();
  await expect(card.getByRole("button", { name: "已投票", exact: true })).toHaveAttribute("aria-pressed", "true");
}

async function cleanup() {
  await executeDatabase(`
    delete from itinerary_items
    where trip_id in (select id from trips where name like 'Wishlist browser %');
    delete from trips where name like 'Wishlist browser %';
    delete from users where email like 'wishlist-%@example.test';
  `);
}

test.beforeEach(() => executeDatabase("truncate table rate_limit_windows"));
test.afterAll(cleanup);

test("members vote on shared wishlist places and can remove another member's scheduled place", async ({ browser, request }) => {
  test.setTimeout(240_000);
  await request.delete(`${MAILPIT_API_URL}/api/v1/messages`);
  const suffix = Date.now();
  const tripName = `Wishlist browser ${suffix}`;
  const ownerEmail = `wishlist-owner-${suffix}@example.test`;
  const memberEmails = [2, 3, 4].map((number) => `wishlist-member-${number}-${suffix}@example.test`);
  await executeDatabase(`insert into users (email, display_name, status) values ('${ownerEmail}', 'Wishlist owner', 'active') on conflict (email) do nothing;`);

  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const ownerPage = await ownerContext.newPage();
  await signIn(ownerPage, request, ownerEmail);
  await createTrip(ownerPage, tripName);
  await addManualPlace(ownerPage, { name: "Family Cafe", address: "Kyoto north gate", note: "Owner wants breakfast", sourceUrl: "https://example.test/family-cafe" });
  await expect(ownerPage.getByRole("button", { name: "投票", exact: true })).toHaveCount(0);

  await executeDatabase(`
    insert into users (email, display_name, status) values
      ('${memberEmails[0]}', 'Member two', 'active'),
      ('${memberEmails[1]}', 'Member three', 'active'),
      ('${memberEmails[2]}', 'Member four', 'active')
    on conflict (email) do nothing;
    insert into trip_members (trip_id, user_id, role)
      select trip.id, member.id, 'editor'
      from trips trip cross join users member
      where trip.name = '${tripName}' and member.email in ('${memberEmails.join("','")}')
    on conflict (trip_id, user_id) do nothing;
  `);

  for (const memberEmail of memberEmails) {
    const context = await browser.newContext({ viewport: { width: 1024, height: 900 } });
    const page = await context.newPage();
    await signIn(page, request, memberEmail);
    await page.getByRole("button", { name: new RegExp(tripName) }).click();
    await openTab(page, "想去清單");
    await expect(page.getByRole("heading", { name: "共享地點想去清單" })).toBeVisible();
    await setVote(page, "Family Cafe");
    await context.close();
  }

  await ownerPage.reload();
  await openTab(ownerPage, "想去清單");
  const card = ownerPage.locator("article").filter({ has: ownerPage.getByRole("heading", { name: "Family Cafe" }) });
  await setVote(ownerPage, "Family Cafe");
  await expect(card.getByText("4 票", { exact: true })).toBeVisible();
  for (const name of ["Wishlist owner", "Member two", "Member three", "Member four"]) {
    await expect(card.getByText(/^投票成員：/)).toContainText(name);
  }
  // The note is shown on the card itself (the planning form below also holds it).
  await expect(card.getByRole("paragraph").filter({ hasText: "Owner wants breakfast" })).toBeVisible();
  await expect(card.getByRole("link", { name: "開啟原始來源" })).toHaveAttribute("href", "https://example.test/family-cafe");
  await expect(card.getByText("新增者與原始備註", { exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "撤回我的紀錄" })).toHaveCount(0);
  await addManualPlace(ownerPage, { name: "One-vote cafe", address: "Kyoto east gate", note: "One vote" });
  await setVote(ownerPage, "One-vote cafe");
  await addManualPlace(ownerPage, { name: "Zero-vote cafe", address: "Kyoto west gate", note: "No votes" });
  const wishlistCards = ownerPage.getByRole("region", { name: "共享地點想去清單" }).getByRole("article");
  await expect(wishlistCards.nth(0).getByRole("heading", { name: "Family Cafe", exact: true })).toBeVisible();
  await expect(wishlistCards.nth(1).getByRole("heading", { name: "One-vote cafe", exact: true })).toBeVisible();
  await expect(wishlistCards.nth(2).getByRole("heading", { name: "Zero-vote cafe", exact: true })).toBeVisible();
  const colors = await wishlistCards.evaluateAll((cards) => cards.map((entry) => getComputedStyle(entry).backgroundColor));
  expect(colors[0]).not.toBe(colors[1]);
  expect(colors[1]).not.toBe(colors[2]);

  await addManualPlace(ownerPage, { name: "Family Cafe", address: "Kyoto south gate", note: "Different branch" });
  const comparison = ownerPage.getByRole("region", { name: "可能重複的地點比較" });
  await expect(comparison.getByText("Kyoto north gate")).toBeVisible();
  await expect(comparison.getByText("Kyoto south gate")).toBeVisible();
  await expect(comparison.getByText("Owner wants breakfast")).toBeVisible();
  await comparison.getByRole("button", { name: "保持分開" }).click();
  await expect(ownerPage.getByText("可能重複", { exact: true })).toHaveCount(0);

  await addManualPlace(ownerPage, {
    name: "Cross-surface Cafe",
    address: "Cross-surface north",
    note: "Wishlist-side source",
  });
  await openTab(ownerPage, "行程");
  await expect(ownerPage.getByRole("button", { name: "編輯「Cross-surface Cafe」" })).toHaveCount(1);
  await addSkeletonPlace(ownerPage, {
    name: "Cross-surface Cafe",
    address: "Cross-surface south",
    note: "Skeleton-side source",
  });
  await openTab(ownerPage, "想去清單");
  await expect(ownerPage.getByRole("article", {
    name: "Cross-surface Cafe，地址：Cross-surface south",
  })).toBeVisible();
  await openTab(ownerPage, "行程");
  await expect(ownerPage.getByRole("button", { name: "編輯「Cross-surface Cafe」" })).toHaveCount(2);
  await openTab(ownerPage, "想去清單");
  const northPlanning = ownerPage.getByRole("article", {
    name: "Cross-surface Cafe，地址：Cross-surface north",
  });
  await northPlanning.getByText("停留時間、預算和備註").click();
  await northPlanning.getByLabel("共享規劃備註").fill("North planning note");
  await northPlanning.getByRole("button", { name: "儲存規劃資訊" }).click();
  await expect(northPlanning.getByText("規劃資訊已儲存。")).toBeVisible();
  const southPlanning = ownerPage.getByRole("article", {
    name: "Cross-surface Cafe，地址：Cross-surface south",
  });
  await southPlanning.getByText("停留時間、預算和備註").click();
  await southPlanning.getByLabel("共享規劃備註").fill("South planning note");
  await southPlanning.getByRole("button", { name: "儲存規劃資訊" }).click();
  await expect(southPlanning.getByText("規劃資訊已儲存。")).toBeVisible();
  const crossSurfaceComparison = ownerPage.getByRole("region", {
    name: "可能重複的地點比較",
  });
  await expect(crossSurfaceComparison.getByText("Cross-surface north")).toBeVisible();
  await expect(crossSurfaceComparison.getByText("Cross-surface south")).toBeVisible();
  await crossSurfaceComparison.getByRole("button", { name: "合併" }).click();
  await openTab(ownerPage, "行程");
  await expect(ownerPage.getByRole("button", { name: "編輯「Cross-surface Cafe」" })).toHaveCount(1);
  await openTab(ownerPage, "想去清單");
  const mergedCard = ownerPage.locator("article").filter({
    has: ownerPage.getByRole("heading", { name: "Cross-surface Cafe" }),
  });
  const mergedNotes = mergedCard.getByLabel("共享規劃備註");
  await expect(mergedNotes).toHaveValue(
    /(?=.*North planning note)(?=.*South planning note)/s,
  );
  await mergedCard.getByLabel("停留時間（分鐘）").fill("45");
  await mergedCard.getByLabel("預算（最小貨幣單位）").fill("1200");
  await mergedCard.getByLabel("貨幣代碼").fill("JPY");
  await mergedCard.getByRole("button", { name: "儲存規劃資訊" }).click();
  await expect(mergedCard.getByText("規劃資訊已儲存。")).toBeVisible();
  await expect(mergedNotes).toHaveValue(
    /(?=.*North planning note)(?=.*South planning note)/s,
  );
  await openTab(ownerPage, "行程");
  await ownerPage.getByRole("button", { name: "編輯「Cross-surface Cafe」" }).click();
  const editMergedDialog = ownerPage.getByRole("dialog", { name: "編輯地點" });
  await expect(editMergedDialog.getByLabel("備註")).toHaveValue(
    /(?=.*North planning note)(?=.*South planning note)/s,
  );
  await editMergedDialog.getByLabel("地址").fill("Cross-surface merged updated");
  await editMergedDialog.getByRole("button", { name: "儲存地點" }).click();
  await expect(editMergedDialog).toHaveCount(0);
  await openTab(ownerPage, "想去清單");
  await expect(ownerPage.getByRole("article", {
    name: "Cross-surface Cafe，地址：Cross-surface merged updated",
  })).toBeVisible();
  await expect(ownerPage.locator('input[name="desiredDayIds"]')).toHaveCount(0);
  await expect(ownerPage.locator('input[name="excludedDayIds"]')).toHaveCount(0);

  await openTab(ownerPage, "行程");
  const firstDay = ownerPage.locator('[data-date="2026-11-03"]');
  await firstDay.getByText("從共用想去清單新增").click();
  await firstDay.getByRole("checkbox", { name: /Cross-surface Cafe/ }).check();
  await firstDay.getByRole("button", { name: "新增所選地點（1）" }).click();
  await expect(firstDay.getByRole("article", {
    name: "已規劃的想去清單地點：Cross-surface Cafe",
  })).toBeVisible();
  // The required outbound flight lands on the first day, so the day also lists it.
  await expect(firstDay.getByText(/2 個已規劃項目・¥1,200/)).toBeVisible();
  await openTab(ownerPage, "想去清單");
  await expect(mergedCard.getByText("已排在 2026-11-03")).toBeVisible();
  await openTab(ownerPage, "行程");

  // A place planned for one day is not offered to another day until removed there.
  const secondDay = ownerPage.locator('[data-date="2026-11-04"]');
  await secondDay.getByText("從共用想去清單新增").click();
  await expect(secondDay.getByRole("checkbox", { name: /Cross-surface Cafe/ })).toHaveCount(0);
  const firstDayPlace = firstDay.getByRole("article", {
    name: "已規劃的想去清單地點：Cross-surface Cafe",
  });
  // Removing reloads the timeline in place. It must never leave the page: the page would get
  // shorter for a moment and throw the reader's scroll position far up.
  await ownerPage.evaluate(() => {
    const probe = window as unknown as { timelineLeft?: boolean; timelineWatch?: MutationObserver };
    probe.timelineLeft = false;
    probe.timelineWatch = new MutationObserver(() => {
      if (!document.querySelector(".timeline-grid")) probe.timelineLeft = true;
    });
    probe.timelineWatch.observe(document.body, { childList: true, subtree: true });
  });
  const timelineReloaded = ownerPage.waitForResponse((response) =>
    response.request().method() === "GET" && new URL(response.url()).pathname.endsWith("/skeleton")
  );
  await firstDayPlace.getByRole("button", { name: "從這天移除" }).click();
  await timelineReloaded;
  await expect(firstDayPlace).toHaveCount(0);
  expect(await ownerPage.evaluate(() => {
    const probe = window as unknown as { timelineLeft?: boolean; timelineWatch?: MutationObserver };
    probe.timelineWatch?.disconnect();
    return probe.timelineLeft;
  })).toBe(false);
  const secondPicker = secondDay.locator("details").filter({ hasText: "從共用想去清單新增" });
  const freedPlace = secondDay.getByRole("checkbox", { name: /Cross-surface Cafe/ });
  await expect(async () => {
    if (await secondPicker.getAttribute("open") === null) await secondPicker.locator("summary").click();
    await expect(freedPlace).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await freedPlace.check();
  await secondDay.getByRole("button", { name: "新增所選地點（1）" }).click();
  const movedPlace = secondDay.getByRole("article", {
    name: "已規劃的想去清單地點：Cross-surface Cafe",
  });
  await expect(movedPlace).toBeVisible();
  await movedPlace.getByRole("button", { name: "從這天移除" }).click();
  await expect(movedPlace).toHaveCount(0);

  await addTimedActivity(ownerPage, {
    title: "Cross-surface timed visit",
    place: "Cross-surface Cafe",
    localDateTime: "2026-11-04T10:00",
  });
  await executeDatabase(`
    insert into trip_place_desired_days (trip_id, trip_place_id, trip_day_id)
    select trip.id, trip_place.id, day.id
    from trips trip
    join trip_places trip_place on trip_place.trip_id = trip.id
    join places place
      on place.trip_id = trip_place.trip_id
      and place.id = trip_place.legacy_place_id
    join trip_days day
      on day.trip_id = trip.id
      and day.date = '2026-11-04'
    where trip.name = '${tripName}'
      and place.name = 'Cross-surface Cafe'
    on conflict (trip_place_id, trip_day_id) do nothing;
  `);
  await ownerPage.reload();
  await openTab(ownerPage, "行程");
  await expect(secondDay.getByRole("heading", { name: "Cross-surface timed visit" }))
    .toBeVisible();
  await expect(secondDay.getByRole("article", {
    name: "已規劃的想去清單地點：Cross-surface Cafe",
  })).toHaveCount(0);
  await expect(secondDay.getByText(/1 個已規劃項目・沒有已知費用・1 筆費用未知/))
    .toBeVisible();

  const removingContext = await browser.newContext({ viewport: { width: 1024, height: 900 } });
  const removingPage = await removingContext.newPage();
  await signIn(removingPage, request, memberEmails[0]!);
  await removingPage.getByRole("button", { name: new RegExp(tripName) }).click();
  await openTab(removingPage, "想去清單");
  const scheduledCard = removingPage.getByRole("article", { name: "Cross-surface Cafe，地址：Cross-surface merged updated" });
  removingPage.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("確定要把「Cross-surface Cafe」移出想去清單嗎？票和天數安排會一起清除。");
    await dialog.dismiss();
  });
  await scheduledCard.getByRole("button", { name: "從想去清單移除" }).click();
  await expect(scheduledCard).toBeVisible();
  removingPage.once("dialog", (dialog) => dialog.accept());
  await scheduledCard.getByRole("button", { name: "從想去清單移除" }).click();
  await expect(scheduledCard).toHaveCount(0);
  await openTab(removingPage, "行程");
  await expect(removingPage.getByRole("heading", { name: "Cross-surface timed visit" })).toBeVisible();
  await expect(removingPage.getByRole("button", { name: "編輯「Cross-surface Cafe」" })).toHaveCount(1);
  await removingContext.close();

  await openTab(ownerPage, "想去清單");
  await ownerPage.getByRole("button", { name: "新增想去地點" }).click();
  const searchDialog = ownerPage.getByRole("dialog", { name: "新增地點" });
  await searchDialog.getByRole("tab", { name: "搜尋" }).click();
  await searchDialog.getByLabel("搜尋 Google Maps").fill("Kiyomizu-dera");
  await searchDialog.getByLabel("地點備註").fill("Keep this text during provider failure");
  await searchDialog.getByRole("button", { name: "搜尋地點" }).click();
  await expect(searchDialog.getByRole("alert")).toContainText("服務供應商目前無法使用，請稍後再試。");
  await expect(searchDialog.getByLabel("搜尋 Google Maps")).toHaveValue("Kiyomizu-dera");
  await expect(searchDialog.getByLabel("地點備註")).toHaveValue("Keep this text during provider failure");
  await searchDialog.getByRole("button", { name: "關閉" }).click();

  await ownerContext.close();
});

test("manual wishlist intake remains usable on a mobile viewport", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const suffix = Date.now();
  const email = `wishlist-mobile-${suffix}@example.test`;
  const tripName = `Wishlist browser mobile ${suffix}`;
  await executeDatabase(`insert into users (email, display_name, status) values ('${email}', 'Mobile owner', 'active') on conflict (email) do nothing;`);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await signIn(page, request, email);
  await createTrip(page, tripName);
  const tripPlaceRoute = /\/api\/trips\/[^/]+\/trip-places$/;
  const retryKeys: string[] = [];
  let interrupted = false;
  await page.route(tripPlaceRoute, async (route) => {
    const body = route.request().postDataJSON() as { method?: string; name?: string } | null;
    if (
      route.request().method() === "POST" &&
      body?.method === "manual" &&
      body.name === "Retry-safe place"
    ) {
      retryKeys.push(route.request().headers()["idempotency-key"] ?? "");
      if (!interrupted) {
        interrupted = true;
        await route.fetch();
        await route.abort("connectionreset");
        return;
      }
    }
    await route.continue();
  });
  await openTab(page, "想去清單");
  await page.getByRole("button", { name: "新增想去地點" }).click();
  const retryDialog = page.getByRole("dialog", { name: "新增地點" });
  await retryDialog.getByRole("tab", { name: "手動輸入" }).click();
  await retryDialog.getByLabel("地點名稱").fill("Retry-safe place");
  await retryDialog.getByLabel("地點類型").selectOption("restaurant");
  await retryDialog.getByLabel("地點備註").fill("Retry without duplicate place");
  await retryDialog.getByRole("button", { name: "手動新增地點" }).click();
  await expect(retryDialog.getByRole("alert")).toBeVisible();
  await expect(retryDialog.getByLabel("地點名稱")).toHaveValue("Retry-safe place");
  await retryDialog.getByRole("button", { name: "手動新增地點" }).click();
  await expect(retryDialog).toHaveCount(0);
  await expect(page.getByRole("article", { name: "Retry-safe place，地址：地址未知" })).toHaveCount(1);
  expect(retryKeys).toHaveLength(2);
  expect(retryKeys[1]).toBe(retryKeys[0]);
  await page.unroute(tripPlaceRoute);

  const retryCard = page.getByRole("article", { name: "Retry-safe place，地址：地址未知" });
  await expect(retryCard.getByRole("button", { name: "投票", exact: true })).toHaveCount(0);
  await executeDatabase(`
    insert into users (email, display_name, status) values ('wishlist-mobile-member-${suffix}@example.test', 'Mobile member', 'active');
    insert into trip_members (trip_id, user_id, role)
      select trip.id, member.id, 'editor' from trips trip cross join users member
      where trip.name = '${tripName}' and member.email = 'wishlist-mobile-member-${suffix}@example.test';
  `);
  await page.reload();
  await openTab(page, "想去清單");
  const voteRoute = /\/api\/trips\/[^/]+\/trip-places\/[^/]+\/vote$/;
  const voteKeys: string[] = [];
  let voteInterrupted = false;
  await page.route(voteRoute, async (route) => {
    voteKeys.push(route.request().headers()["idempotency-key"] ?? "");
    if (!voteInterrupted) {
      voteInterrupted = true;
      await route.fetch();
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  });
  await retryCard.getByRole("button", { name: "投票", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await retryCard.getByRole("button", { name: "重試投票" }).click();
  await expect(retryCard.getByRole("button", { name: "重試投票" })).toHaveCount(0);
  await expect(retryCard.getByText("1 票", { exact: true })).toBeVisible();
  expect(voteKeys).toHaveLength(2);
  expect(voteKeys[1]).toBe(voteKeys[0]);
  await page.unroute(voteRoute);
  let releaseVote!: () => void;
  const voteGate = new Promise<void>((resolve) => { releaseVote = resolve; });
  await page.route(voteRoute, async (route) => {
    await voteGate;
    await route.continue();
  });
  const voteButton = retryCard.getByRole("button", { name: "已投票", exact: true });
  await voteButton.click();
  await expect(voteButton).toBeDisabled();
  releaseVote();
  await expect(retryCard.getByRole("button", { name: "投票", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(retryCard.getByText("0 票", { exact: true })).toBeVisible();
  await page.unroute(voteRoute);
  await addManualPlace(page, { name: "Private meeting point", note: "Ask host for exact pin" });
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "Private meeting point" }) });
  await expect(card.getByText("需要地點資訊", { exact: true })).toBeVisible();
  await expect(card.getByRole("paragraph").filter({ hasText: "Ask host for exact pin" })).toBeVisible();

  // Enough wrapped two-line addresses to exceed the picker's capped height.
  for (const [index, address] of [
    "15-chōme-778 Honmachi, Higashiyama Ward, Kyoto, 605-0981 Japan",
    "48 Eikandōchō, Sakyo Ward, Kyoto, 606-8445 Japan",
    "Hirata, Ine, Yoza District, Kyoto 626-0423 Japan",
    "56 Matsuojingatanichō, Nishikyo Ward, Kyoto, 615-8286 Japan",
  ].entries()) {
    await addManualPlace(page, { name: `Long address place ${index + 1}`, address, note: "Day picker layout" });
  }
  await openTab(page, "行程");
  const firstDay = page.locator("[data-date]").first();
  await firstDay.getByText("從共用想去清單新增").click();
  const picker = firstDay.getByRole("group", { name: "要新增的想去清單地點" });
  const rows = await picker.evaluate((group) => [...group.querySelectorAll("label")].map((label) => {
    const contents = document.createRange();
    contents.selectNodeContents(label);
    const row = label.getBoundingClientRect();
    const text = contents.getBoundingClientRect();
    return { rowBottom: row.bottom, textBottom: text.bottom, rowRight: row.right, textRight: text.right };
  }));
  expect(rows.length).toBeGreaterThanOrEqual(5);
  for (const row of rows) {
    expect(row.textBottom).toBeLessThanOrEqual(row.rowBottom);
    expect(row.textRight).toBeLessThanOrEqual(row.rowRight);
  }
  await context.close();
});

for (const recovery of ["接受目前版本", "重新套用我的修改", "返回編輯"] as const) {
  test(`two members compare a TripPlace conflict and choose ${recovery}`, async ({ browser, request }) => {
    test.setTimeout(180_000);
    const suffix = `${Date.now()}-${recovery === "返回編輯" ? "mobile" : "desktop"}`;
    const tripName = `Wishlist browser conflict ${suffix}`;
    const ownerEmail = `wishlist-conflict-owner-${suffix}@example.test`;
    const memberEmail = `wishlist-conflict-member-${suffix}@example.test`;
    const ownerLabel = recovery === "重新套用我的修改" ? ownerEmail : "Conflict owner";
    const savedNote = recovery === "重新套用我的修改" ? "步行" : "Current saved note";
    const attemptedNote = recovery === "重新套用我的修改" ? "walking" : "My unsaved note";
    await executeDatabase(`insert into users (email, display_name, status) values
      ('${ownerEmail}', ${recovery === "重新套用我的修改" ? "null" : "'Conflict owner'"}, 'active'), ('${memberEmail}', 'Conflict editor', 'active');`);
    const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const memberContext = await browser.newContext({ viewport: recovery === "返回編輯" ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    try {
      const owner = await ownerContext.newPage();
      const member = await memberContext.newPage();
      await signIn(owner, request, ownerEmail);
      await createTrip(owner, tripName);
      await addManualPlace(owner, { name: "Conflict cafe", address: "Test district", note: "Base note" });
      await executeDatabase(`insert into trip_members (trip_id, user_id, role)
        select trip.id, member.id, 'editor' from trips trip cross join users member
        where trip.name = '${tripName}' and member.email = '${memberEmail}';`);
      await signIn(member, request, memberEmail);
      await member.getByRole("button", { name: new RegExp(tripName) }).click();
      await openTab(member, "想去清單");
      await expect(member.getByText("即時更新已連線", { exact: true })).toBeVisible();
      const ownerCard = owner.getByRole("article").filter({ has: owner.getByRole("heading", { name: "Conflict cafe", exact: true }) });
      const memberCard = member.getByRole("article").filter({ has: member.getByRole("heading", { name: "Conflict cafe", exact: true }) });
      for (const card of [ownerCard, memberCard]) await card.locator("summary", { hasText: "停留時間、預算和備註" }).click();
      await memberCard.getByLabel("共享規劃備註").fill(attemptedNote);
      await ownerCard.getByLabel("共享規劃備註").fill(savedNote);
      await ownerCard.getByRole("button", { name: "儲存規劃資訊" }).click();
      // The card read model refreshes live, but the open editor keeps its base and input.
      await expect(memberCard.getByRole("paragraph").filter({ hasText: new RegExp(`^${savedNote}$`) })).toBeVisible();
      await expect(memberCard.getByLabel("共享規劃備註")).toHaveValue(attemptedNote);
      const rejected = member.waitForResponse((response) => response.url().endsWith("/planning") && response.status() === 409);
      await memberCard.getByRole("button", { name: "儲存規劃資訊" }).click();
      const conflictResponse = await rejected;
      const originalVersion = (await conflictResponse.request().postDataJSON()).expectedVersion as number;
      const panel = memberCard.locator("[data-conflict-panel]");
      await expect(panel.getByRole("heading", { name: "這份內容已由其他成員更新" })).toBeFocused();
      await expect(panel.locator("dd p")).toHaveText(["Base note", savedNote, attemptedNote]);
      await expect.soft(panel).toContainText(ownerLabel);
      await expect.soft(panel.locator("dt")).toHaveText(["共同備註"]);
      await expect.soft(panel).toContainText("其他 3 個欄位沒有差異");
      await panel.getByRole("button", { name: recovery, exact: true }).click();
      if (recovery === "返回編輯") {
        await expect(panel).toHaveCount(0);
        await expect(memberCard.getByLabel("共享規劃備註")).toHaveValue(attemptedNote);
        await memberCard.getByLabel("共享規劃備註").fill("My revised note");
        await memberCard.getByRole("button", { name: "儲存規劃資訊" }).click();
      }
      const expected = recovery === "接受目前版本" ? savedNote : recovery === "返回編輯" ? "My revised note" : attemptedNote;
      await expect(panel).toHaveCount(0);
      await expect(memberCard.getByRole("paragraph").filter({ hasText: new RegExp(`^${expected}$`) })).toBeVisible();
      await expect(ownerCard.getByRole("paragraph").filter({ hasText: new RegExp(`^${expected}$`) })).toBeVisible();
      await member.getByRole("tab", { name: "最近變更", exact: true }).click();
      const history = member.getByRole("tabpanel", { name: "最近變更", exact: true });
      await expect.soft(history).toContainText(ownerLabel);
      await expect.soft(history).toContainText("變更對象：想去地點 · Conflict cafe");
      if (recovery !== "接受目前版本") {
        await expect.soft(history).toContainText(`比較衝突後重新套用（從第 ${originalVersion} 版開始編輯）`);
        await expect.soft(history).not.toContainText(`目前版本 ${originalVersion}`);
      }
    } finally { await ownerContext.close(); await memberContext.close(); }
  });
}

test("two windows of one account identify the writer and hide deleted history target names", async ({ page, request }) => {
  const { tripId, headers } = await prepareReviewWishlist(page, request, "same-account");
  await addManualPlace(page, { name: "Same account cafe", note: "Original note" });
  const other = await page.context().newPage();
  try {
    await other.goto(page.url());
    await openTab(other, "想去清單");
    const card = (window: Page) => window.getByRole("article").filter({ has: window.getByRole("heading", { name: "Same account cafe", exact: true }) });
    for (const window of [page, other]) await card(window).locator("summary", { hasText: "停留時間、預算和備註" }).click();
    await card(page).getByLabel("共享規劃備註").fill("Unsaved first window");
    await card(other).getByLabel("共享規劃備註").fill("Saved other window");
    await card(other).getByRole("button", { name: "儲存規劃資訊" }).click();
    await expect(card(page).getByRole("paragraph").filter({ hasText: /^Saved other window$/ })).toBeVisible();
    await card(page).getByRole("button", { name: "儲存規劃資訊" }).click();
    const conflict = card(page).locator("[data-conflict-panel]");
    await expect.soft(conflict.getByRole("heading")).toHaveText("你在另一個視窗或裝置更新了這份內容");
    await expect(conflict).toContainText("Unsaved first window");
    await conflict.getByRole("button", { name: "接受目前版本", exact: true }).click();
    const places = (await (await page.request.get(`/api/trips/${tripId}/trip-places`)).json()).tripPlaces;
    const place = places.find((entry: { name: string }) => entry.name === "Same account cafe");
    expect((await page.request.post(`/api/trips/${tripId}/trip-places/${place.id}/remove`, {
      headers, data: { expectedVersion: place.version },
    })).status()).toBe(204);
    await page.getByRole("tab", { name: "最近變更", exact: true }).click();
    const history = page.getByRole("tabpanel", { name: "最近變更", exact: true });
    await expect(history.getByText("變更對象：想去地點", { exact: true }).first()).toBeVisible();
    await expect(history).not.toContainText("Same account cafe");
    await expect(history).not.toContainText(place.id.slice(0, 8));
  } finally { await other.close(); }
});

test("live refresh recovers by focus while SSE is unavailable and then reconnects", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const suffix = Date.now();
  const tripName = `Wishlist browser live ${suffix}`;
  const ownerEmail = `wishlist-live-owner-${suffix}@example.test`;
  const memberEmail = `wishlist-live-member-${suffix}@example.test`;
  await executeDatabase(`insert into users (email, display_name, status) values
    ('${ownerEmail}', 'Live owner', 'active'), ('${memberEmail}', 'Live member', 'active');`);
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const owner = await first.newPage();
    const member = await second.newPage();
    await signIn(owner, request, ownerEmail);
    await createTrip(owner, tripName);
    await executeDatabase(`insert into trip_members (trip_id, user_id, role)
      select trip.id, member.id, 'editor' from trips trip cross join users member
      where trip.name = '${tripName}' and member.email = '${memberEmail}';`);
    await second.route("**/api/trips/*/events*", (route) => route.abort());
    await signIn(member, request, memberEmail);
    await member.getByRole("button", { name: new RegExp(tripName) }).click();
    await openTab(member, "想去清單");
    await addManualPlace(owner, { name: "Focus recovery cafe", note: "Saved while SSE is down" });
    await member.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(member.getByRole("heading", { name: "Focus recovery cafe", exact: true })).toBeVisible();
    await second.unroute("**/api/trips/*/events*");
    await member.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(member.getByText("即時更新已連線", { exact: true })).toBeVisible();
    await addManualPlace(owner, { name: "Reconnected cafe", note: "Saved after reconnect" });
    await expect(member.getByRole("heading", { name: "Reconnected cafe", exact: true })).toBeVisible();
    await expect(member.getByRole("heading", { name: "Focus recovery cafe", exact: true })).toHaveCount(1);
  } finally { await first.close(); await second.close(); }
});

test("independent place edits converge while a stale day window requires an explicit retry", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const suffix = Date.now();
  const tripName = `Wishlist browser independent ${suffix}`;
  const ownerEmail = `wishlist-independent-owner-${suffix}@example.test`;
  const memberEmail = `wishlist-independent-member-${suffix}@example.test`;
  await executeDatabase(`insert into users (email, display_name, status) values
    ('${ownerEmail}', 'Day owner', 'active'), ('${memberEmail}', 'Day member', 'active');`);
  const ownerContext = await browser.newContext();
  const memberContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    const member = await memberContext.newPage();
    await signIn(owner, request, ownerEmail);
    await createTrip(owner, tripName);
    await addManualPlace(owner, { name: "Independent A", note: "A base" });
    await addManualPlace(owner, { name: "Independent B", note: "B base" });
    await executeDatabase(`insert into trip_members (trip_id, user_id, role)
      select trip.id, member.id, 'editor' from trips trip cross join users member
      where trip.name = '${tripName}' and member.email = '${memberEmail}';`);
    await signIn(member, request, memberEmail);
    await member.getByRole("button", { name: new RegExp(tripName) }).click();
    await openTab(member, "想去清單");
    const card = (page: Page, name: string) => page.getByRole("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
    const ownerCard = card(owner, "Independent A");
    const memberCard = card(member, "Independent B");
    for (const editor of [ownerCard, memberCard]) await editor.locator("summary", { hasText: "停留時間、預算和備註" }).click();
    await ownerCard.getByLabel("共享規劃備註").fill("A independently saved");
    await memberCard.getByLabel("共享規劃備註").fill("B independently saved");
    const ownerSave = owner.waitForResponse((response) => response.url().endsWith("/planning") && response.request().method() === "PATCH");
    const memberSave = member.waitForResponse((response) => response.url().endsWith("/planning") && response.request().method() === "PATCH");
    await Promise.all([ownerCard.getByRole("button", { name: "儲存規劃資訊" }).click(), memberCard.getByRole("button", { name: "儲存規劃資訊" }).click()]);
    expect((await ownerSave).status()).toBe(200);
    expect((await memberSave).status()).toBe(200);
    for (const page of [owner, member]) {
      await expect(card(page, "Independent A").getByRole("paragraph").filter({ hasText: /^A independently saved$/ })).toBeVisible();
      await expect(card(page, "Independent B").getByRole("paragraph").filter({ hasText: /^B independently saved$/ })).toBeVisible();
      await openTab(page, "行程");
      const firstDay = page.locator("[data-date]").first();
      if (page === owner) {
        await firstDay.getByText("從共用想去清單新增").click();
        await firstDay.getByRole("checkbox", { name: /Independent A/ }).check();
        await firstDay.getByRole("button", { name: "新增所選地點（1）" }).click();
      }
      await expect(firstDay.getByRole("button", { name: "排這一天", exact: true })).toBeVisible();
      await firstDay.getByRole("button", { name: "排這一天", exact: true }).click();
      await expect(page.getByRole("dialog").getByRole("button", { name: "重新排", exact: true })).toBeEnabled();
    }
    const ownerDay = owner.getByRole("dialog");
    const memberDay = member.getByRole("dialog");
    await ownerDay.getByLabel("開始", { exact: true }).fill("08:00");
    await memberDay.getByLabel("開始", { exact: true }).fill("10:00");
    const windowSaved = owner.waitForResponse((response) => response.url().endsWith("/window") && response.request().method() === "PUT");
    await ownerDay.getByRole("button", { name: "重新排", exact: true }).click();
    expect((await windowSaved).status()).toBe(200);
    await expect(memberDay.getByLabel("開始", { exact: true })).toHaveValue("10:00");
    const rejected = member.waitForResponse((response) => response.url().endsWith("/window") && response.status() === 409);
    await memberDay.getByRole("button", { name: "重新排", exact: true }).click();
    await rejected;
    const panel = memberDay.locator("[data-conflict-panel]");
    await expect(panel).toContainText("09:00");
    await expect(panel).toContainText("08:00");
    await expect(panel).toContainText("10:00");
    await expect(panel).toContainText("Day owner");
    await panel.getByRole("button", { name: "返回編輯", exact: true }).click();
    await expect(memberDay.getByLabel("開始", { exact: true })).toHaveValue("10:00");
    await memberDay.getByLabel("開始", { exact: true }).fill("10:30");
    const retried = member.waitForResponse((response) => response.url().endsWith("/window") && response.request().method() === "PUT");
    await memberDay.getByRole("button", { name: "重新排", exact: true }).click();
    expect((await retried).status()).toBe(200);
    await expect(memberDay.getByRole("button", { name: "重新排", exact: true })).toBeEnabled();
    await expect(memberDay.getByLabel("開始", { exact: true })).toHaveValue("10:30");
  } finally { await ownerContext.close(); await memberContext.close(); }
});

async function prepareReviewWishlist(page: Page, request: APIRequestContext, kind: string) {
  const suffix = `${Date.now()}-${kind}`;
  const name = `Wishlist browser review ${suffix}`;
  const email = `wishlist-review-${suffix}@example.test`;
  await executeDatabase(`insert into users (email, display_name, status) values ('${email}', 'Review owner', 'active');`);
  await signIn(page, request, email);
  await createTrip(page, name);
  const trips = await (await page.request.get("/api/trips")).json();
  const tripId = trips.trips.find((trip: { name: string }) => trip.name === name).id as string;
  return { tripId, headers: { origin: new URL(page.url()).origin, "idempotency-key": crypto.randomUUID() } };
}

test("deleted planning editors can be dismissed and closed editors do not resurrect places", async ({ page, request }) => {
  const { tripId, headers } = await prepareReviewWishlist(page, request, "deleted-editor");
  const removeThroughApi = async (name: string) => {
    const list = await (await page.request.get(`/api/trips/${tripId}/trip-places`)).json();
    const place = list.tripPlaces.find((entry: { name: string }) => entry.name === name);
    expect((await page.request.post(`/api/trips/${tripId}/trip-places/${place.id}/remove`, {
      headers: { ...headers, "idempotency-key": crypto.randomUUID() }, data: { expectedVersion: place.version },
    })).status()).toBe(204);
  };
  await addManualPlace(page, { name: "Closed editor cafe", note: "Saved note" });
  const closed = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Closed editor cafe", exact: true }) });
  await closed.locator("summary", { hasText: "停留時間、預算和備註" }).click();
  await closed.locator("summary", { hasText: "停留時間、預算和備註" }).click();
  await removeThroughApi("Closed editor cafe");
  await expect(closed).toHaveCount(0);

  await addManualPlace(page, { name: "Own removed cafe", note: "Saved note" });
  const own = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Own removed cafe", exact: true }) });
  await own.locator("summary", { hasText: "停留時間、預算和備註" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await own.getByRole("button", { name: "從想去清單移除", exact: true }).click();
  await expect(own).toHaveCount(0);

  await addManualPlace(page, { name: "Unsaved removed cafe", note: "Saved note" });
  const unsaved = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Unsaved removed cafe", exact: true }) });
  await unsaved.locator("summary", { hasText: "停留時間、預算和備註" }).click();
  await unsaved.getByLabel("共享規劃備註").fill("Keep this unsaved deleted-place note");
  await removeThroughApi("Unsaved removed cafe");
  const unavailable = unsaved.locator("[data-conflict-panel]");
  await expect(unavailable).toContainText("Keep this unsaved deleted-place note");
  await expect(unavailable.getByRole("button", { name: "重新套用我的修改", exact: true })).toBeDisabled();
  await expect(unsaved.getByRole("button", { name: "從想去清單移除", exact: true })).toHaveCount(0);
  await unavailable.getByRole("button", { name: "放棄修改並關閉", exact: true }).click();
  await expect(unsaved).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(unsaved).toHaveCount(0);
});

test("focus recovers a failed history projection after the notification watermark was read", async ({ page, request }) => {
  const { tripId, headers } = await prepareReviewWishlist(page, request, "projection-retry");
  await addManualPlace(page, { name: "Existing projection cafe", note: "Initial saved state" });
  await page.getByRole("tab", { name: "最近變更", exact: true }).click();
  const endpoint = `**/api/trips/${tripId}/history`;
  let failNextRead = true;
  await page.route(endpoint, async (route) => {
    if (route.request().method() === "GET" && failNextRead) {
      failNextRead = false;
      await route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Temporary projection failure" } } });
    } else await route.continue();
  });
  const failed = page.waitForResponse((response) => response.url().endsWith(`/trips/${tripId}/history`) && response.status() === 503);
  expect((await page.request.post(`/api/trips/${tripId}/trip-places`, {
    headers, data: { method: "manual", name: "Recovered projection cafe", type: "restaurant", address: null, latitude: null, longitude: null, timeZone: null, sourceUrl: null, originalNote: null },
  })).status()).toBe(201);
  await failed;
  await page.unroute(endpoint);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("tabpanel", { name: "最近變更", exact: true })).toContainText("變更對象：想去地點 · Recovered projection cafe");
});

test("open create dialogs keep their input and use fresh creation preconditions", async ({ page, request }) => {
  const { tripId, headers } = await prepareReviewWishlist(page, request, "create-preconditions");
  await openTab(page, "行程");
  const createElsewhere = async (name: string) => {
    const before = (await (await page.request.get(`/api/trips/${tripId}/skeleton`)).json()).skeleton.tripVersion;
    const response = await page.request.post(`/api/trips/${tripId}/places`, {
      headers: { ...headers, "idempotency-key": crypto.randomUUID() },
      data: { name, type: "activity", address: null, latitude: null, longitude: null, timeZone: "Asia/Tokyo", sourceUrl: null, notes: null, expectedTripVersion: before },
    });
    expect(response.status(), await response.text()).toBe(201);
    const current = (await (await page.request.get(`/api/trips/${tripId}`)).json()).trip;
    await expect(page.locator('[aria-labelledby="trip-title-heading"]')).toContainText(`版本 ${current.version}`);
  };
  await page.getByRole("button", { name: "新增地點", exact: true }).click();
  const place = page.getByRole("dialog", { name: "新增地點", exact: true });
  await place.getByLabel("地點名稱").fill("My preserved new place");
  await place.getByLabel("備註").fill("Unsaved creation input");
  await createElsewhere("Other creator's place");
  await expect(place.getByLabel("地點名稱")).toHaveValue("My preserved new place");
  await place.getByRole("button", { name: "儲存地點", exact: true }).click();
  await expect(place).toHaveCount(0);
  await expect(page.getByRole("button", { name: "編輯「My preserved new place」", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新增地點", exact: true }).click();
  await place.getByLabel("地點名稱").fill("Retry without discarding new place");
  const createPath = `**/api/trips/${tripId}/places`;
  let interfereWithCreate = true;
  await page.route(createPath, async (route) => {
    if (!interfereWithCreate) { await route.continue(); return; }
    interfereWithCreate = false;
    await createElsewhere("Concurrent create after submission");
    await route.continue();
  });
  const staleCreate = page.waitForResponse((response) => response.url().endsWith(`/trips/${tripId}/places`) && response.status() === 409);
  await place.getByRole("button", { name: "儲存地點", exact: true }).click();
  await staleCreate;
  await expect(place.getByRole("alert")).toBeVisible();
  await expect(place.getByLabel("地點名稱")).toHaveValue("Retry without discarding new place");
  await place.getByRole("button", { name: "儲存地點", exact: true }).click();
  await expect(place).toHaveCount(0);

  await page.getByRole("button", { name: "新增固定行程", exact: true }).click();
  const item = page.getByRole("dialog", { name: "新增固定行程", exact: true });
  await item.getByLabel("類型", { exact: true }).selectOption("activity");
  await item.getByLabel("標題", { exact: true }).fill("My preserved new activity");
  const start = item.getByRole("group", { name: "開始（當地時間）", exact: true });
  await start.getByLabel("停留國家").selectOption({ label: "1、JP" });
  await start.getByLabel("地點", { exact: true }).selectOption({ label: "Other creator's place" });
  await start.getByLabel("當地日期與時間").fill("2026-11-04T10:00");
  await start.getByLabel("IANA 時區").fill("Asia/Tokyo");
  await item.getByLabel("期間（分鐘）").fill("60");
  await createElsewhere("Another concurrent place");
  await expect(item.getByLabel("標題", { exact: true })).toHaveValue("My preserved new activity");
  const itemPath = `**/api/trips/${tripId}/items`;
  let loseItemResponse = true;
  await page.route(itemPath, async (route) => {
    if (!loseItemResponse) { await route.continue(); return; }
    loseItemResponse = false;
    const saved = await route.fetch();
    expect(saved.status()).toBe(201);
    await route.abort("failed");
  });
  await item.getByRole("button", { name: "儲存固定行程", exact: true }).click();
  await expect(item.getByRole("alert")).toBeVisible();
  await expect(item.getByLabel("標題", { exact: true })).toHaveValue("My preserved new activity");
  await item.getByRole("button", { name: "儲存固定行程", exact: true }).click();
  await expect(item).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "My preserved new activity", exact: true })).toBeVisible();
  const savedItems = (await (await page.request.get(`/api/trips/${tripId}/skeleton`)).json()).skeleton.items;
  expect(savedItems.filter((entry: { title: string }) => entry.title === "My preserved new activity")).toHaveLength(1);
});
