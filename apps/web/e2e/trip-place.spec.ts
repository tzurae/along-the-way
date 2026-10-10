import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { isRecord } from "@along-the-way/contracts/private-trips";
import { parseTripPlaceListResponse } from "@along-the-way/contracts/trip-places";
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
  const identity = page.getByText(`登入帳號：${email}`, { exact: true });
  if (!await identity.isVisible()) {
    await page.getByRole("button", { name: /切換旅程$/ }).click();
    await expect(page.getByRole("dialog", { name: "切換旅程" }).getByText(`登入帳號：${email}`, { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
  }
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
  const country = dialog.getByLabel("新增國家");
  await country.fill("Japan");
  await page.getByRole("option", { name: /\(JP\)/ }).dispatchEvent("click");
  await fillTripFlights(dialog, "2026-11-03", "2026-11-09");
  await dialog.getByRole("button", { name: "建立旅程", exact: true }).click();
  await expect(page.getByRole("button", { name: new RegExp(`${name}，切換旅程`) })).toBeVisible();
}

async function openTab(page: Page, name: "想去清單" | "行程") {
  await page.getByRole("tab", { name: name === "想去清單" ? "地點" : "行程", exact: true }).click();
  await page.getByRole("tab", { name: name === "想去清單" ? "想去" : "每日", exact: true }).click();
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

function wishlistEntry(page: Page, placeName: string) {
  return page.locator("tbody[data-wishlist-place]").filter({
    has: page.getByRole("row", { name: placeName, exact: true }),
  });
}

function wishlistEntryAtAddress(page: Page, placeName: string, address: string) {
  return page.locator("tbody[data-wishlist-place]").filter({
    has: page.getByRole("row", {
      name: `${placeName}，地址：${address}`,
      exact: true,
    }),
  });
}

async function expandWishlistPlace(page: Page, placeName: string) {
  const entry = wishlistEntry(page, placeName);
  await entry.getByRole("button", { name: `查看 ${placeName} 的詳情`, exact: true }).click();
  const detail = (page.viewportSize()?.width ?? 1280) < 1024
    ? page.getByRole("dialog", { name: `${placeName} 的詳情` })
    : page.getByRole("complementary", { name: `${placeName} 的詳情` });
  await expect(detail).toBeVisible();
  return detail;
}

async function setVote(page: Page, placeName: string) {
  const row = page.getByRole("row", { name: placeName, exact: true });
  await row.getByRole("button", { name: "投票", exact: true }).click();
  await expect(row.getByRole("button", { name: "已投票", exact: true })).toHaveAttribute("aria-pressed", "true");
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
  await expect(ownerPage.getByRole("table", { name: "想去清單地點" }).getByRole("columnheader", { name: "票數" })).toHaveCount(0);
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
    await expect(page.getByRole("button", { name: new RegExp(`${tripName}，切換旅程`) })).toBeVisible();
    await openTab(page, "想去清單");
    await expect(page.getByRole("heading", { name: "共享地點想去清單" })).toBeVisible();
    await setVote(page, "Family Cafe");
    await context.close();
  }

  await ownerPage.reload();
  await openTab(ownerPage, "想去清單");
  const card = wishlistEntry(ownerPage, "Family Cafe");
  await setVote(ownerPage, "Family Cafe");
  await expect(card.getByText("4 票", { exact: true })).toBeVisible();
  const familyDetails = await expandWishlistPlace(ownerPage, "Family Cafe");
  for (const name of ["Wishlist owner", "Member two", "Member three", "Member four"]) {
    await expect(familyDetails.getByText(/^投票成員：/)).toContainText(name);
  }
  await expect(familyDetails.getByRole("paragraph").filter({ hasText: "Owner wants breakfast" })).toBeVisible();
  await expect(familyDetails.getByRole("link", { name: "開啟原始來源" })).toHaveAttribute("href", "https://example.test/family-cafe");
  await expect(familyDetails.getByText("新增者與原始備註", { exact: true })).toHaveCount(0);
  await expect(familyDetails.getByRole("button", { name: "撤回我的紀錄" })).toHaveCount(0);
  await addManualPlace(ownerPage, { name: "One-vote cafe", address: "Kyoto east gate", note: "One vote" });
  await setVote(ownerPage, "One-vote cafe");
  await addManualPlace(ownerPage, { name: "Zero-vote cafe", address: "Kyoto west gate", note: "No votes" });
  const wishlistRows = ownerPage.getByRole("table", { name: "想去清單地點" }).locator("tbody > tr:first-child");
  await expect(wishlistRows).toHaveCount(3);
  await expect(wishlistRows.nth(0)).toHaveAttribute("aria-label", "Family Cafe");
  await expect(wishlistRows.nth(1)).toHaveAttribute("aria-label", "One-vote cafe");
  await expect(wishlistRows.nth(2)).toHaveAttribute("aria-label", "Zero-vote cafe");
  const colors = await wishlistRows.evaluateAll((rows) => rows.map((entry) => getComputedStyle(entry).backgroundColor));
  expect(colors[0]).not.toBe(colors[1]);
  expect(colors[1]).not.toBe(colors[2]);

  await addManualPlace(ownerPage, { name: "Family Cafe", address: "Kyoto south gate", note: "Different branch" });
  const duplicateEntry = wishlistEntryAtAddress(ownerPage, "Family Cafe", "Kyoto north gate");
  await duplicateEntry.getByRole("button", { name: "查看 Family Cafe 的詳情", exact: true }).click();
  const comparisonPanel = ownerPage.getByRole("complementary", { name: "Family Cafe 的詳情" });
  await expect(comparisonPanel.getByRole("heading", { name: "Family Cafe 的詳情" })).toBeFocused();
  for (const width of [1280, 1440]) {
    await ownerPage.setViewportSize({ width, height: 720 });
    const wishlistWrapperBox = await ownerPage.locator("[data-wishlist-table-wrapper]").boundingBox();
    expect(wishlistWrapperBox).not.toBeNull();
    for (const action of await duplicateEntry.getByRole("button").all()) {
      if (!await action.isVisible()) continue;
      const actionBox = await action.boundingBox();
      expect(actionBox).not.toBeNull();
      expect(actionBox!.x).toBeGreaterThanOrEqual(wishlistWrapperBox!.x);
      expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(wishlistWrapperBox!.x + wishlistWrapperBox!.width);
    }
  }
  const comparison = comparisonPanel.getByRole("region", { name: "可能重複的地點比較" });
  await expect(comparison.getByRole("region", { name: "這個選項" })).toContainText("Kyoto north gate");
  await expect(comparison.getByRole("region", { name: "這個選項" })).toContainText("Owner wants breakfast");
  await expect(comparison.getByRole("region", { name: "另一個選項" })).toContainText("Kyoto south gate");
  const duplicateOtherEntry = wishlistEntryAtAddress(ownerPage, "Family Cafe", "Kyoto south gate");
  await duplicateOtherEntry.getByRole("button", { name: "查看 Family Cafe 的詳情", exact: true }).click();
  const otherComparison = comparisonPanel.getByRole("region", { name: "可能重複的地點比較" });
  await expect(otherComparison.getByRole("region", { name: "這個選項" })).toContainText("Kyoto south gate");
  await expect(otherComparison.getByRole("region", { name: "另一個選項" })).toContainText("Kyoto north gate");
  await otherComparison.getByRole("button", { name: "保持分開" }).click();
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
  await expect(ownerPage.getByRole("row", {
    name: "Cross-surface Cafe，地址：Cross-surface north",
    exact: true,
  })).toBeVisible();
  await expect(ownerPage.getByRole("row", {
    name: "Cross-surface Cafe，地址：Cross-surface south",
    exact: true,
  })).toBeVisible();
  await openTab(ownerPage, "行程");
  await expect(ownerPage.getByRole("button", { name: "編輯「Cross-surface Cafe」" })).toHaveCount(2);
  await openTab(ownerPage, "想去清單");
  const northPlanning = wishlistEntryAtAddress(ownerPage, "Cross-surface Cafe", "Cross-surface north");
  await northPlanning.getByRole("button", { name: "查看 Cross-surface Cafe 的詳情", exact: true }).click();
  const planningPanel = ownerPage.getByRole("complementary", { name: "Cross-surface Cafe 的詳情" });
  await planningPanel.getByText("停留時間、預算和備註").click();
  await planningPanel.getByLabel("共享規劃備註").fill("North planning note");
  await planningPanel.getByRole("button", { name: "儲存規劃資訊" }).click();
  await expect(planningPanel.getByText("規劃資訊已儲存。")).toBeVisible();
  const southPlanning = wishlistEntryAtAddress(ownerPage, "Cross-surface Cafe", "Cross-surface south");
  await southPlanning.getByRole("button", { name: "查看 Cross-surface Cafe 的詳情", exact: true }).click();
  await planningPanel.getByText("停留時間、預算和備註").click();
  await planningPanel.getByLabel("共享規劃備註").fill("South planning note");
  await planningPanel.getByRole("button", { name: "儲存規劃資訊" }).click();
  await expect(planningPanel.getByText("規劃資訊已儲存。")).toBeVisible();
  const crossSurfaceComparison = planningPanel.getByRole("region", {
    name: "可能重複的地點比較",
  });
  await expect(crossSurfaceComparison.getByRole("region", { name: "這個選項" })).toContainText("Cross-surface south");
  await expect(crossSurfaceComparison.getByRole("region", { name: "另一個選項" })).toContainText("Cross-surface north");
  await crossSurfaceComparison.getByRole("button", { name: "合併" }).click();
  const mergeDialog = ownerPage.getByRole("dialog", { name: "確認合併「Cross-surface Cafe」與「Cross-surface Cafe」？" });
  await expect(mergeDialog).toContainText("這個動作無法復原");
  await mergeDialog.getByRole("button", { name: "取消" }).click();
  await expect(ownerPage.getByRole("row", { name: /Cross-surface Cafe/ })).toHaveCount(2);
  await crossSurfaceComparison.getByRole("button", { name: "合併" }).click();
  await ownerPage.getByRole("dialog", { name: "確認合併「Cross-surface Cafe」與「Cross-surface Cafe」？" }).getByRole("button", { name: "確定合併" }).click();
  await openTab(ownerPage, "行程");
  await expect(ownerPage.getByRole("button", { name: "編輯「Cross-surface Cafe」" })).toHaveCount(1);
  await openTab(ownerPage, "想去清單");
  const mergedCard = await expandWishlistPlace(ownerPage, "Cross-surface Cafe");
  await mergedCard.getByText("停留時間、預算和備註", { exact: true }).click();
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
  await expect(ownerPage.getByRole("row", {
    name: "Cross-surface Cafe",
    exact: true,
  })).toBeVisible();
  const refreshedMerged = await expandWishlistPlace(ownerPage, "Cross-surface Cafe");
  await expect(refreshedMerged.getByText("Cross-surface merged updated", { exact: true })).toBeVisible();
  await expect(ownerPage.locator('input[name="desiredDayIds"]')).toHaveCount(0);
  await expect(ownerPage.locator('input[name="excludedDayIds"]')).toHaveCount(0);
  await refreshedMerged.getByRole("button", { name: "關閉地點詳情" }).click();

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
  for (const width of [1280, 1440]) {
    await ownerPage.setViewportSize({ width, height: 720 });
    await expect(ownerPage.getByRole("row", { name: "Cross-surface Cafe", exact: true }).getByRole("cell", { name: "2026-11-03", exact: true })).toBeVisible();
  }
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
  await expect(removingPage.getByRole("button", { name: new RegExp(`${tripName}，切換旅程`) })).toBeVisible();
  await openTab(removingPage, "想去清單");
  const scheduledCard = await expandWishlistPlace(removingPage, "Cross-surface Cafe");
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
  await expect(page.getByRole("row", { name: "Retry-safe place", exact: true })).toHaveCount(1);
  expect(retryKeys).toHaveLength(2);
  expect(retryKeys[1]).toBe(retryKeys[0]);
  await page.unroute(tripPlaceRoute);

  const retryCard = wishlistEntry(page, "Retry-safe place");
  await expect(page.getByRole("table", { name: "想去清單地點" }).getByRole("columnheader", { name: "票數" })).toHaveCount(0);
  await expect(retryCard.getByRole("button", { name: "投票", exact: true })).toHaveCount(0);
  await executeDatabase(`
    insert into users (email, display_name, status) values ('wishlist-mobile-member-${suffix}@example.test', 'Mobile member', 'active');
    insert into trip_members (trip_id, user_id, role)
      select trip.id, member.id, 'editor' from trips trip cross join users member
      where trip.name = '${tripName}' and member.email = 'wishlist-mobile-member-${suffix}@example.test';
  `);
  await page.reload();
  await openTab(page, "想去清單");
  const mobileTable = page.getByRole("table", { name: "想去清單地點" });
  await expect(mobileTable.getByRole("columnheader", { name: "票數" })).toHaveCount(1);
  await expect(mobileTable.getByRole("columnheader", { name: "類型" })).toBeHidden();
  await expect(mobileTable.getByRole("columnheader", { name: "排在" })).toBeHidden();
  await expect(retryCard.getByText("餐廳或咖啡廳・未排入", { exact: true })).toBeVisible();
  expect((await retryCard.getByRole("button", { name: "投票", exact: true }).boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect((await retryCard.getByRole("button", { name: "查看 Retry-safe place 的詳情", exact: true }).boundingBox())?.height).toBeGreaterThanOrEqual(44);
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
  const card = wishlistEntry(page, "Private meeting point");
  await expect(card.getByText("需要地點資訊", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "查看 Private meeting point 的詳情", exact: true }).click();
  const privateDetail = page.getByRole("dialog", { name: "Private meeting point 的詳情" });
  await expect(privateDetail.getByRole("heading", { name: "Private meeting point 的詳情" })).toBeFocused();
  await expect(privateDetail.getByRole("paragraph").filter({ hasText: "Ask host for exact pin" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card.getByRole("button", { name: "查看 Private meeting point 的詳情", exact: true })).toBeFocused();

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
      await expect(member.getByRole("button", { name: new RegExp(`${tripName}，切換旅程`) })).toBeVisible();
      await openTab(member, "想去清單");
      await expect(member.locator('[title="即時更新已連線"]:visible')).toBeVisible();
      const ownerDetail = await expandWishlistPlace(owner, "Conflict cafe");
      const memberDetail = await expandWishlistPlace(member, "Conflict cafe");
      await ownerDetail.locator("summary", { hasText: "停留時間、預算和備註" }).click();
      await memberDetail.locator("summary", { hasText: "停留時間、預算和備註" }).click();
      await memberDetail.getByLabel("共享規劃備註").fill(attemptedNote);
      await ownerDetail.getByLabel("共享規劃備註").fill(savedNote);
      await ownerDetail.getByRole("button", { name: "儲存規劃資訊" }).click();
      // The card read model refreshes live, but the open editor keeps its base and input.
      await expect(memberDetail.getByRole("paragraph").filter({ hasText: new RegExp(`^${savedNote}$`) })).toBeVisible();
      await expect(memberDetail.getByLabel("共享規劃備註")).toHaveValue(attemptedNote);
      const rejected = member.waitForResponse((response) => response.url().endsWith("/planning") && response.status() === 409);
      await memberDetail.getByRole("button", { name: "儲存規劃資訊" }).click();
      const conflictResponse = await rejected;
      const originalVersion = (await conflictResponse.request().postDataJSON()).expectedVersion as number;
      const panel = memberDetail.locator("[data-conflict-panel]");
      await expect(panel.getByRole("heading", { name: "這份內容已由其他成員更新" })).toBeFocused();
      await expect(panel.locator("dd p")).toHaveText(["Base note", savedNote, attemptedNote]);
      await expect.soft(panel).toContainText(ownerLabel);
      await expect.soft(panel.locator("dt")).toHaveText(["共同備註"]);
      await expect.soft(panel).toContainText("其他 3 個欄位沒有差異");
      await panel.getByRole("button", { name: recovery, exact: true }).click();
      if (recovery === "返回編輯") {
        await expect(panel).toHaveCount(0);
        await expect(memberDetail.getByLabel("共享規劃備註")).toHaveValue(attemptedNote);
        await memberDetail.getByLabel("共享規劃備註").fill("My revised note");
        await memberDetail.getByRole("button", { name: "儲存規劃資訊" }).click();
      }
      const expected = recovery === "接受目前版本" ? savedNote : recovery === "返回編輯" ? "My revised note" : attemptedNote;
      await expect(panel).toHaveCount(0);
      await expect(memberDetail.getByRole("paragraph").filter({ hasText: new RegExp(`^${expected}$`) })).toBeVisible();
      await expect(ownerDetail.getByRole("paragraph").filter({ hasText: new RegExp(`^${expected}$`) })).toBeVisible();
      if ((member.viewportSize()?.width ?? 1280) < 1024) await member.keyboard.press("Escape");
      await member.getByRole("tab", { name: "成員", exact: true }).click();
      const history = member.getByRole("tabpanel", { name: "成員", exact: true });
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
    const pageDetail = await expandWishlistPlace(page, "Same account cafe");
    const otherDetail = await expandWishlistPlace(other, "Same account cafe");
    await pageDetail.locator("summary", { hasText: "停留時間、預算和備註" }).click();
    await otherDetail.locator("summary", { hasText: "停留時間、預算和備註" }).click();
    await pageDetail.getByLabel("共享規劃備註").fill("Unsaved first window");
    await otherDetail.getByLabel("共享規劃備註").fill("Saved other window");
    await otherDetail.getByRole("button", { name: "儲存規劃資訊" }).click();
    await expect(pageDetail.getByRole("paragraph").filter({ hasText: /^Saved other window$/ })).toBeVisible();
    await pageDetail.getByRole("button", { name: "儲存規劃資訊" }).click();
    const conflict = pageDetail.locator("[data-conflict-panel]");
    await expect.soft(conflict.getByRole("heading")).toHaveText("你在另一個視窗或裝置更新了這份內容");
    await expect(conflict).toContainText("Unsaved first window");
    await conflict.getByRole("button", { name: "接受目前版本", exact: true }).click();
    const places = (await (await page.request.get(`/api/trips/${tripId}/trip-places`)).json()).tripPlaces;
    const place = places.find((entry: { name: string }) => entry.name === "Same account cafe");
    expect((await page.request.post(`/api/trips/${tripId}/trip-places/${place.id}/remove`, {
      headers, data: { expectedVersion: place.version },
    })).status()).toBe(204);
    await page.getByRole("tab", { name: "成員", exact: true }).click();
    const history = page.getByRole("tabpanel", { name: "成員", exact: true });
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
    await expect(member.getByRole("button", { name: new RegExp(`${tripName}，切換旅程`) })).toBeVisible();
    await openTab(member, "想去清單");
    await addManualPlace(owner, { name: "Focus recovery cafe", note: "Saved while SSE is down" });
    await member.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(member.getByRole("row", { name: "Focus recovery cafe", exact: true })).toBeVisible();
    await second.unroute("**/api/trips/*/events*");
    await member.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(member.locator('[title="即時更新已連線"]:visible')).toBeVisible();
    await addManualPlace(owner, { name: "Reconnected cafe", note: "Saved after reconnect" });
    await expect(member.getByRole("row", { name: "Reconnected cafe", exact: true })).toBeVisible();
    await expect(member.getByRole("row", { name: "Focus recovery cafe", exact: true })).toHaveCount(1);
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
    await expect(member.getByRole("button", { name: new RegExp(`${tripName}，切換旅程`) })).toBeVisible();
    await openTab(member, "想去清單");
    const ownerDetail = await expandWishlistPlace(owner, "Independent A");
    const memberDetail = await expandWishlistPlace(member, "Independent B");
    await ownerDetail.locator("summary", { hasText: "停留時間、預算和備註" }).click();
    await memberDetail.locator("summary", { hasText: "停留時間、預算和備註" }).click();
    await ownerDetail.getByLabel("共享規劃備註").fill("A independently saved");
    await memberDetail.getByLabel("共享規劃備註").fill("B independently saved");
    const ownerSave = owner.waitForResponse((response) => response.url().endsWith("/planning") && response.request().method() === "PATCH");
    const memberSave = member.waitForResponse((response) => response.url().endsWith("/planning") && response.request().method() === "PATCH");
    await Promise.all([ownerDetail.getByRole("button", { name: "儲存規劃資訊" }).click(), memberDetail.getByRole("button", { name: "儲存規劃資訊" }).click()]);
    expect((await ownerSave).status()).toBe(200);
    expect((await memberSave).status()).toBe(200);
    for (const page of [owner, member]) {
      const detailA = await expandWishlistPlace(page, "Independent A");
      await expect(detailA.getByRole("paragraph").filter({ hasText: /^A independently saved$/ })).toBeVisible();
      const detailB = await expandWishlistPlace(page, "Independent B");
      await expect(detailB.getByRole("paragraph").filter({ hasText: /^B independently saved$/ })).toBeVisible();
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

test("phone shell starts at content, keeps four bottom destinations, and redirects legacy wishlist URLs", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { tripId } = await prepareReviewWishlist(page, request, "phone-shell");
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    const switcherBox = await page.getByRole("button", { name: /切換旅程$/ }).boundingBox();
    const connectionBox = await page.locator('[title="即時更新已連線"]:visible').boundingBox();
    expect(switcherBox).not.toBeNull();
    expect(connectionBox).not.toBeNull();
    expect(switcherBox!.x + switcherBox!.width).toBeLessThanOrEqual(connectionBox!.x);
  }
  await expect(page.getByRole("button", { name: "登出", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /切換旅程$/ }).click();
  await expect(page.getByRole("dialog", { name: "切換旅程" }).getByRole("button", { name: "登出", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });

  const bottomNavigation = page.getByRole("navigation", { name: "旅程主要功能" });
  const destinations = bottomNavigation.getByRole("tab");
  await expect(destinations).toHaveCount(4);
  await expect(destinations).toHaveText(["今天", "行程", "地點", "成員"]);
  for (const destination of await destinations.all()) {
    expect((await destination.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.getByRole("navigation", { name: "旅程", exact: true })).toHaveCount(0);
  const contentHeading = page.getByRole("heading", { name: "固定行程與每日行程" });
  const contentBox = await contentHeading.boundingBox();
  expect(contentBox?.y).toBeLessThan(700);

  await page.goto(`/?trip=${tripId}&tab=wishlist`);
  await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("places");
  await expect.poll(() => new URL(page.url()).searchParams.get("segment")).toBe("wishlist");
  await expect(bottomNavigation.getByRole("tab", { name: "地點", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "想去", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "共享地點想去清單" })).toBeVisible();
});

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
  const closed = wishlistEntry(page, "Closed editor cafe");
  const closedDetail = await expandWishlistPlace(page, "Closed editor cafe");
  await closedDetail.locator("summary", { hasText: "停留時間、預算和備註" }).click();
  await closedDetail.locator("summary", { hasText: "停留時間、預算和備註" }).click();
  await removeThroughApi("Closed editor cafe");
  await expect(closed).toHaveCount(0);

  await addManualPlace(page, { name: "Own removed cafe", note: "Saved note" });
  const own = wishlistEntry(page, "Own removed cafe");
  const ownDetail = await expandWishlistPlace(page, "Own removed cafe");
  await ownDetail.locator("summary", { hasText: "停留時間、預算和備註" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await ownDetail.getByRole("button", { name: "從想去清單移除", exact: true }).click();
  await expect(own).toHaveCount(0);

  await addManualPlace(page, { name: "Unsaved removed cafe", note: "Saved note" });
  const unsaved = wishlistEntry(page, "Unsaved removed cafe");
  const unsavedDetail = await expandWishlistPlace(page, "Unsaved removed cafe");
  await unsavedDetail.locator("summary", { hasText: "停留時間、預算和備註" }).click();
  await unsavedDetail.getByLabel("共享規劃備註").fill("Keep this unsaved deleted-place note");
  await removeThroughApi("Unsaved removed cafe");
  const retainedDetail = page.getByRole("complementary", { name: "Unsaved removed cafe 的詳情" });
  const unavailable = retainedDetail.locator("[data-conflict-panel]");
  await expect(unavailable).toContainText("Keep this unsaved deleted-place note");
  await expect(unavailable.getByRole("button", { name: "重新套用我的修改", exact: true })).toBeDisabled();
  await expect(retainedDetail.getByRole("button", { name: "從想去清單移除", exact: true })).toHaveCount(0);
  await unavailable.getByRole("button", { name: "放棄修改並關閉", exact: true }).click();
  await expect(unsaved).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(unsaved).toHaveCount(0);
});

test("focus recovers a failed history projection after the notification watermark was read", async ({ page, request }) => {
  const { tripId, headers } = await prepareReviewWishlist(page, request, "projection-retry");
  await addManualPlace(page, { name: "Existing projection cafe", note: "Initial saved state" });
  await page.getByRole("tab", { name: "成員", exact: true }).click();
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
  await expect(page.getByRole("tabpanel", { name: "成員", exact: true })).toContainText("變更對象：想去地點 · Recovered projection cafe");
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

test("photo composition and compact credits survive desktop and enlarged-text boundaries", async ({ page, request }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const { tripId } = await prepareReviewWishlist(page, request, "photo-geometry");
  const placeName = "照片版面驗收地點（非實際景點）";
  await addManualPlace(page, { name: placeName, note: "隔離版面回歸；不是實際景點照片。" });
  const listing = await page.request.get(`/api/trips/${tripId}/trip-places`);
  expect(listing.ok()).toBe(true);
  const place = parseTripPlaceListResponse(await listing.json()).tripPlaces.find((entry) => entry.name === placeName)!;
  // Original test-only pixel: real photo provenance is verified separately through the catalog.
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH9sAAAAASUVORK5CYII=", "base64");
  const filename = `${createHash("sha256").update(pixel).digest("hex")}.png`;
  const imageUrl = `/api/trips/${tripId}/place-photo-assets/${filename}?kind=trip-place&id=${place.id}`;
  const author = `版面驗收作者（非真實景點攝影師）；${"同一測試署名；".repeat(80)}`;
  const photo = {
    id: "geometry-test-pixel", title: "原始測試像素", description: "單一測試像素，不是實際景點照片。",
    sourceName: "本機版面驗收資料", sourceUrl: "https://example.test/original-test-pixel",
    fileSourceUrl: "https://example.test/original-test-pixel.png", author, authorUrl: "https://example.test/test-author",
    creditText: `${author}。作品來源：原始測試像素，CC0 1.0。`, licenseName: "CC0 1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    capturedAt: null, checkedAt: new Date().toISOString(), verificationUrl: "https://example.test/test-pixel-record",
    locationEvidence: "不代表任何真實地點。", changes: "原始測試像素，未修改。",
    notices: ["只驗證版面，不作為照片來源或授權查核證據。"],
    originalWidth: 1, originalHeight: 1, width: 1, height: 1, imageUrl, thumbnailUrl: imageUrl,
  };
  await page.route(`**/api/trips/${tripId}/place-details?**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("kind") !== "trip-place" || url.searchParams.get("id") !== place.id) return route.fallback();
    await route.fulfill({ json: { detail: {
      reference: { kind: "trip-place", id: place.id }, canonicalPlaceId: place.placeId, name: placeName,
      asOfDate: url.searchParams.get("date"), sections: [], sources: [], photos: [photo],
    } } });
  });
  await page.route(`**/api/trips/${tripId}/place-photo-assets/${filename}?**`, (route) => route.fulfill({ contentType: "image/png", body: pixel }));
  for (const [width, fontSize] of [[1440, 16], [1024, 32], [390, 32]] as const) {
    await test.step(`${width}px viewport / ${fontSize}px root font`, async () => {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((size) => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
      const detail = await expandWishlistPlace(page, placeName);
      const credit = detail.locator('[data-photo-credit="geometry-test-pixel"]');
      await expect.poll(async () => Math.round((await credit.boundingBox())?.height ?? 0)).toBe(56);
      const information = detail.getByRole("button", { name: "查看「原始測試像素」的完整照片資訊", exact: true });
      const creditBox = (await credit.boundingBox())!;
      const informationBox = (await information.boundingBox())!;
      expect(informationBox.height).toBeGreaterThanOrEqual(44);
      expect(informationBox.y).toBeGreaterThanOrEqual(creditBox.y);
      expect(informationBox.y + informationBox.height).toBeLessThanOrEqual(creditBox.y + creditBox.height + 0.5);
      await information.click();
      const viewer = page.locator('[data-photo-viewer="geometry-test-pixel"]');
      const image = viewer.locator("img");
      await image.evaluate((element) => (element as HTMLImageElement).decode());
      // Fails when desktop constraints collapse the rendered image to zero width.
      await expect.poll(async () => (await image.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(200);
      const imageBox = (await image.boundingBox())!;
      expect(imageBox.x).toBeGreaterThanOrEqual(0);
      expect(imageBox.y).toBeGreaterThanOrEqual(0);
      expect(imageBox.x + imageBox.width).toBeLessThanOrEqual(width);
      expect(imageBox.y + imageBox.height).toBeLessThanOrEqual(900);
      expect(await viewer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect((await viewer.getByRole("link", { name: author, exact: true }).boundingBox())!.width).toBeGreaterThanOrEqual(100);
      await page.keyboard.press("Escape");
      await expect(viewer).toHaveCount(0);
      await expect(information).toBeFocused();
      await detail.getByRole("button", { name: /^關閉/ }).first().click();
      await expect(detail).toHaveCount(0);
    });
  }
  await test.step("reduced motion does not animate the photo viewer", async () => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const detail = await expandWishlistPlace(page, placeName);
    await detail.getByRole("button", { name: "查看「原始測試像素」的完整照片資訊", exact: true }).click();
    const viewer = page.locator('[data-photo-viewer="geometry-test-pixel"]');
    await expect(viewer).toBeVisible();
    expect(await viewer.evaluate((element) => {
      const style = getComputedStyle(element);
      return style.animationName === "none" || style.animationDuration.split(",").every((duration) => parseFloat(duration) <= 0.001);
    })).toBe(true);
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
  });
});
