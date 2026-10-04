import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { isRecord } from "@along-the-way/contracts/private-trips";

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
  await dialog.getByRole("button", { name: "建立旅程", exact: true }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function addManualPlace(
  page: Page,
  input: { name: string; address?: string; note: string },
) {
  await page.getByRole("button", { name: "新增想去地點" }).click();
  const dialog = page.getByRole("dialog", { name: "新增地點" });
  await dialog.getByRole("tab", { name: "手動輸入" }).click();
  await dialog.getByLabel("地點名稱").fill(input.name);
  await dialog.getByLabel("地點類型").selectOption("restaurant");
  if (input.address) await dialog.getByLabel("地址（若知道）").fill(input.address);
  await dialog.getByLabel("你的原始備註").fill(input.note);
  await dialog.getByRole("button", { name: "手動新增地點" }).click();
  await expect(dialog).toHaveCount(0);
}

async function addSkeletonPlace(
  page: Page,
  input: { name: string; address: string; note: string },
) {
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

async function setPreference(page: Page, placeName: string, value: string) {
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: placeName }) });
  await card.getByLabel("你的偏好").selectOption(value);
  await expect(card.getByLabel("你的偏好")).toHaveValue(value);
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

test("members keep independent wishlist contributions and preferences on desktop", async ({ browser, request }) => {
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
  await addManualPlace(ownerPage, { name: "Family Cafe", address: "Kyoto north gate", note: "Owner wants breakfast" });
  await setPreference(ownerPage, "Family Cafe", "must");

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

  for (const [index, preference] of ["dislike", "want", "optional"].entries()) {
    const context = await browser.newContext({ viewport: { width: 1024, height: 900 } });
    const page = await context.newPage();
    await signIn(page, request, memberEmails[index]!);
    await page.getByRole("button", { name: new RegExp(tripName) }).click();
    await expect(page.getByRole("heading", { name: "共享地點想去清單" })).toBeVisible();
    await setPreference(page, "Family Cafe", preference!);
    await context.close();
  }

  await ownerPage.reload();
  const card = ownerPage.locator("article").filter({ has: ownerPage.getByRole("heading", { name: "Family Cafe" }) });
  await expect(card.getByText("偏好衝突：")).toBeVisible();
  const preferenceList = card.getByRole("list").first();
  await expect(preferenceList.getByText("必去", { exact: true })).toBeVisible();
  await expect(preferenceList.getByText("不想去", { exact: true })).toBeVisible();
  await expect(preferenceList.getByText("想去", { exact: true })).toBeVisible();
  await expect(preferenceList.getByText("可有可無", { exact: true })).toBeVisible();
  await expect(card.getByText("Owner wants breakfast")).toBeVisible();

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
  await expect(ownerPage.getByRole("button", { name: "編輯「Cross-surface Cafe」" })).toHaveCount(1);
  await addSkeletonPlace(ownerPage, {
    name: "Cross-surface Cafe",
    address: "Cross-surface south",
    note: "Skeleton-side source",
  });
  await expect(ownerPage.getByRole("article", {
    name: "Cross-surface Cafe，地址：Cross-surface south",
  })).toBeVisible();
  await expect(ownerPage.getByRole("button", { name: "編輯「Cross-surface Cafe」" })).toHaveCount(2);
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
  await expect(ownerPage.getByRole("button", { name: "編輯「Cross-surface Cafe」" })).toHaveCount(1);
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
  await ownerPage.getByRole("button", { name: "編輯「Cross-surface Cafe」" }).click();
  const editMergedDialog = ownerPage.getByRole("dialog", { name: "編輯地點" });
  await expect(editMergedDialog.getByLabel("備註")).toHaveValue(
    /(?=.*North planning note)(?=.*South planning note)/s,
  );
  await editMergedDialog.getByLabel("地址").fill("Cross-surface merged updated");
  await editMergedDialog.getByRole("button", { name: "儲存地點" }).click();
  await expect(editMergedDialog).toHaveCount(0);
  await expect(ownerPage.getByRole("article", {
    name: "Cross-surface Cafe，地址：Cross-surface merged updated",
  })).toBeVisible();
  await expect(ownerPage.locator('input[name="desiredDayIds"]')).toHaveCount(0);
  await expect(ownerPage.locator('input[name="excludedDayIds"]')).toHaveCount(0);

  const firstDay = ownerPage.locator('[data-date="2026-11-03"]');
  await firstDay.getByText("從共用想去清單新增").click();
  await firstDay.getByRole("checkbox", { name: /Cross-surface Cafe/ }).check();
  await firstDay.getByRole("button", { name: "新增所選地點（1）" }).click();
  await expect(firstDay.getByRole("article", {
    name: "已規劃的想去清單地點：Cross-surface Cafe",
  })).toBeVisible();
  await expect(firstDay.getByText(/1 個已規劃項目・¥1,200/)).toBeVisible();
  await expect(mergedCard.getByText("已排在 2026-11-03")).toBeVisible();

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
  await expect(secondDay.getByRole("heading", { name: "Cross-surface timed visit" }))
    .toBeVisible();
  await expect(secondDay.getByRole("article", {
    name: "已規劃的想去清單地點：Cross-surface Cafe",
  })).toHaveCount(0);
  await expect(secondDay.getByText(/1 個已規劃項目・沒有已知費用・1 筆費用未知/))
    .toBeVisible();

  await ownerPage.getByRole("button", { name: "新增想去地點" }).click();
  const searchDialog = ownerPage.getByRole("dialog", { name: "新增地點" });
  await searchDialog.getByRole("tab", { name: "搜尋" }).click();
  await searchDialog.getByLabel("搜尋 Google Maps").fill("Kiyomizu-dera");
  await searchDialog.getByLabel("你的原始備註").fill("Keep this text during provider failure");
  await searchDialog.getByRole("button", { name: "搜尋地點" }).click();
  await expect(searchDialog.getByRole("alert")).toContainText("服務供應商目前無法使用，請稍後再試。");
  await expect(searchDialog.getByLabel("搜尋 Google Maps")).toHaveValue("Kiyomizu-dera");
  await expect(searchDialog.getByLabel("你的原始備註")).toHaveValue("Keep this text during provider failure");
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
  await page.getByRole("button", { name: "新增想去地點" }).click();
  const retryDialog = page.getByRole("dialog", { name: "新增地點" });
  await retryDialog.getByRole("tab", { name: "手動輸入" }).click();
  await retryDialog.getByLabel("地點名稱").fill("Retry-safe place");
  await retryDialog.getByLabel("地點類型").selectOption("restaurant");
  await retryDialog.getByLabel("你的原始備註").fill("Retry without duplicate contribution");
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
  const preferenceRoute = /\/api\/trips\/[^/]+\/trip-places\/[^/]+\/preference$/;
  const preferenceKeys: string[] = [];
  let preferenceInterrupted = false;
  await page.route(preferenceRoute, async (route) => {
    preferenceKeys.push(route.request().headers()["idempotency-key"] ?? "");
    if (!preferenceInterrupted) {
      preferenceInterrupted = true;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "conflict",
            message: "Version conflict",
            currentVersion: 2,
          },
        }),
      });
      return;
    }
    await route.continue();
  });
  await retryCard.getByLabel("你的偏好").selectOption("want");
  await expect(page.getByRole("alert")).toContainText("資料已變更，無法完成操作。");
  await expect(retryCard.getByLabel("你的偏好")).toHaveValue("want");
  await retryCard.getByRole("button", { name: "重試偏好設定" }).click();
  await expect(retryCard.getByRole("button", { name: "重試偏好設定" })).toHaveCount(0);
  expect(preferenceKeys).toHaveLength(2);
  expect(preferenceKeys[1]).toBe(preferenceKeys[0]);
  await page.unroute(preferenceRoute);
  let releasePreference!: () => void;
  const preferenceGate = new Promise<void>((resolve) => {
    releasePreference = resolve;
  });
  await page.route(preferenceRoute, async (route) => {
    await preferenceGate;
    await route.continue();
  });
  const preferenceSelect = retryCard.getByLabel("你的偏好");
  await preferenceSelect.selectOption("optional");
  await expect(preferenceSelect).toBeDisabled();
  releasePreference();
  await expect(preferenceSelect).toBeEnabled();
  await expect(preferenceSelect).toHaveValue("optional");
  await page.unroute(preferenceRoute);
  await addManualPlace(page, { name: "Private meeting point", note: "Ask host for exact pin" });
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "Private meeting point" }) });
  await expect(card.getByText("需要地點資訊", { exact: true })).toBeVisible();
  await expect(card.getByText("Ask host for exact pin")).toBeVisible();

  // Enough wrapped two-line addresses to exceed the picker's capped height.
  for (const [index, address] of [
    "15-chōme-778 Honmachi, Higashiyama Ward, Kyoto, 605-0981 Japan",
    "48 Eikandōchō, Sakyo Ward, Kyoto, 606-8445 Japan",
    "Hirata, Ine, Yoza District, Kyoto 626-0423 Japan",
    "56 Matsuojingatanichō, Nishikyo Ward, Kyoto, 615-8286 Japan",
  ].entries()) {
    await addManualPlace(page, { name: `Long address place ${index + 1}`, address, note: "Day picker layout" });
  }
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
