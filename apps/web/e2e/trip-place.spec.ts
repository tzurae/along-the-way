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
  const country = dialog.getByLabel("Add a country");
  await country.fill("Japan");
  await page.getByRole("option", { name: /\(JP\)/ }).dispatchEvent("click");
  await dialog.getByRole("button", { name: "Create trip", exact: true }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function addManualPlace(
  page: Page,
  input: { name: string; address?: string; note: string },
) {
  await page.getByRole("button", { name: "Add wishlist place" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a place" });
  await dialog.getByRole("tab", { name: "Manual" }).click();
  await dialog.getByLabel("Place name").fill(input.name);
  await dialog.getByLabel("Place type").selectOption("restaurant");
  if (input.address) await dialog.getByLabel("Address, if known").fill(input.address);
  await dialog.getByLabel("Your original note").fill(input.note);
  await dialog.getByRole("button", { name: "Add manual place" }).click();
  await expect(dialog).toHaveCount(0);
}

async function addSkeletonPlace(
  page: Page,
  input: { name: string; address: string; note: string },
) {
  await page.getByRole("button", { name: "Add place", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a place" });
  await dialog.getByLabel("Place name").fill(input.name);
  await dialog.getByLabel("Place type").selectOption("restaurant");
  await dialog.getByLabel("Address").fill(input.address);
  await dialog.getByLabel("Notes").fill(input.note);
  await dialog.getByRole("button", { name: "Save place" }).click();
  await expect(dialog).toHaveCount(0);
}

async function setPreference(page: Page, placeName: string, value: string) {
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: placeName }) });
  await card.getByLabel("Your preference").selectOption(value);
  await expect(card.getByLabel("Your preference")).toHaveValue(value);
}

async function cleanup() {
  await executeDatabase("delete from trips where name like 'Wishlist browser %'; delete from users where email like 'wishlist-%@example.test';");
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
    await expect(page.getByRole("heading", { name: "Shared place wishlist" })).toBeVisible();
    await setPreference(page, "Family Cafe", preference!);
    await context.close();
  }

  await ownerPage.reload();
  const card = ownerPage.locator("article").filter({ has: ownerPage.getByRole("heading", { name: "Family Cafe" }) });
  await expect(card.getByText("Preference conflict:")).toBeVisible();
  const preferenceList = card.getByRole("list").first();
  await expect(preferenceList.getByText("Must go", { exact: true })).toBeVisible();
  await expect(preferenceList.getByText("Prefer not to go", { exact: true })).toBeVisible();
  await expect(preferenceList.getByText("Want to go", { exact: true })).toBeVisible();
  await expect(preferenceList.getByText("Optional", { exact: true })).toBeVisible();
  await expect(card.getByText("Owner wants breakfast")).toBeVisible();

  await addManualPlace(ownerPage, { name: "Family Cafe", address: "Kyoto south gate", note: "Different branch" });
  const comparison = ownerPage.getByRole("region", { name: "Possible duplicate comparison" });
  await expect(comparison.getByText("Kyoto north gate")).toBeVisible();
  await expect(comparison.getByText("Kyoto south gate")).toBeVisible();
  await expect(comparison.getByText("Owner wants breakfast")).toBeVisible();
  await comparison.getByRole("button", { name: "Keep separate options" }).click();
  await expect(ownerPage.getByText("Possible duplicate", { exact: true })).toHaveCount(0);

  await addManualPlace(ownerPage, {
    name: "Cross-surface Cafe",
    address: "Cross-surface north",
    note: "Wishlist-side source",
  });
  await expect(ownerPage.getByRole("button", { name: "Edit Cross-surface Cafe" })).toHaveCount(1);
  await addSkeletonPlace(ownerPage, {
    name: "Cross-surface Cafe",
    address: "Cross-surface south",
    note: "Skeleton-side source",
  });
  await expect(ownerPage.getByRole("article", {
    name: "Cross-surface Cafe at Cross-surface south",
  })).toBeVisible();
  await expect(ownerPage.getByRole("button", { name: "Edit Cross-surface Cafe" })).toHaveCount(2);
  const northPlanning = ownerPage.getByRole("article", {
    name: "Cross-surface Cafe at Cross-surface north",
  });
  await northPlanning.getByText("Duration, dates, budget, and notes").click();
  await northPlanning.getByLabel("Shared planning note").fill("North planning note");
  await northPlanning.getByRole("button", { name: "Save planning facts" }).click();
  await expect(northPlanning.getByText("Planning facts saved.")).toBeVisible();
  const southPlanning = ownerPage.getByRole("article", {
    name: "Cross-surface Cafe at Cross-surface south",
  });
  await southPlanning.getByText("Duration, dates, budget, and notes").click();
  await southPlanning.getByLabel("Shared planning note").fill("South planning note");
  await southPlanning.getByRole("button", { name: "Save planning facts" }).click();
  await expect(southPlanning.getByText("Planning facts saved.")).toBeVisible();
  const crossSurfaceComparison = ownerPage.getByRole("region", {
    name: "Possible duplicate comparison",
  });
  await expect(crossSurfaceComparison.getByText("Cross-surface north")).toBeVisible();
  await expect(crossSurfaceComparison.getByText("Cross-surface south")).toBeVisible();
  await crossSurfaceComparison.getByRole("button", { name: "Merge these options" }).click();
  await expect(ownerPage.getByRole("button", { name: "Edit Cross-surface Cafe" })).toHaveCount(1);
  const mergedCard = ownerPage.locator("article").filter({
    has: ownerPage.getByRole("heading", { name: "Cross-surface Cafe" }),
  });
  const mergedNotes = mergedCard.getByLabel("Shared planning note");
  await expect(mergedNotes).toHaveValue(
    /(?=.*North planning note)(?=.*South planning note)/s,
  );
  await mergedCard.getByLabel("Duration in minutes").fill("45");
  await mergedCard.getByRole("button", { name: "Save planning facts" }).click();
  await expect(mergedCard.getByText("Planning facts saved.")).toBeVisible();
  await expect(mergedNotes).toHaveValue(
    /(?=.*North planning note)(?=.*South planning note)/s,
  );
  await ownerPage.getByRole("button", { name: "Edit Cross-surface Cafe" }).click();
  const editMergedDialog = ownerPage.getByRole("dialog", { name: "Edit place" });
  await expect(editMergedDialog.getByLabel("Notes")).toHaveValue(
    /(?=.*North planning note)(?=.*South planning note)/s,
  );
  await editMergedDialog.getByLabel("Address").fill("Cross-surface merged updated");
  await editMergedDialog.getByRole("button", { name: "Save place" }).click();
  await expect(editMergedDialog).toHaveCount(0);
  await expect(ownerPage.getByRole("article", {
    name: "Cross-surface Cafe at Cross-surface merged updated",
  })).toBeVisible();

  await ownerPage.getByRole("button", { name: "Add wishlist place" }).click();
  const searchDialog = ownerPage.getByRole("dialog", { name: "Add a place" });
  await searchDialog.getByRole("tab", { name: "Search" }).click();
  await searchDialog.getByLabel("Search Google Maps").fill("Kiyomizu-dera");
  await searchDialog.getByLabel("Your original note").fill("Keep this text during provider failure");
  await searchDialog.getByRole("button", { name: "Search places" }).click();
  await expect(searchDialog.getByRole("alert")).toContainText("temporarily unavailable");
  await expect(searchDialog.getByLabel("Search Google Maps")).toHaveValue("Kiyomizu-dera");
  await expect(searchDialog.getByLabel("Your original note")).toHaveValue("Keep this text during provider failure");
  await searchDialog.getByRole("button", { name: "Close" }).click();

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
  await page.getByRole("button", { name: "Add wishlist place" }).click();
  const retryDialog = page.getByRole("dialog", { name: "Add a place" });
  await retryDialog.getByRole("tab", { name: "Manual" }).click();
  await retryDialog.getByLabel("Place name").fill("Retry-safe place");
  await retryDialog.getByLabel("Place type").selectOption("restaurant");
  await retryDialog.getByLabel("Your original note").fill("Retry without duplicate contribution");
  await retryDialog.getByRole("button", { name: "Add manual place" }).click();
  await expect(retryDialog.getByRole("alert")).toBeVisible();
  await expect(retryDialog.getByLabel("Place name")).toHaveValue("Retry-safe place");
  await retryDialog.getByRole("button", { name: "Add manual place" }).click();
  await expect(retryDialog).toHaveCount(0);
  await expect(page.getByRole("article", { name: "Retry-safe place at unknown address" })).toHaveCount(1);
  expect(retryKeys).toHaveLength(2);
  expect(retryKeys[1]).toBe(retryKeys[0]);
  await page.unroute(tripPlaceRoute);

  const retryCard = page.getByRole("article", { name: "Retry-safe place at unknown address" });
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
  await retryCard.getByLabel("Your preference").selectOption("want");
  await expect(page.getByRole("alert")).toContainText("Version conflict");
  await expect(retryCard.getByLabel("Your preference")).toHaveValue("want");
  await retryCard.getByRole("button", { name: "Retry preference" }).click();
  await expect(retryCard.getByRole("button", { name: "Retry preference" })).toHaveCount(0);
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
  const preferenceSelect = retryCard.getByLabel("Your preference");
  await preferenceSelect.selectOption("optional");
  await expect(preferenceSelect).toBeDisabled();
  releasePreference();
  await expect(preferenceSelect).toBeEnabled();
  await expect(preferenceSelect).toHaveValue("optional");
  await page.unroute(preferenceRoute);
  await addManualPlace(page, { name: "Private meeting point", note: "Ask host for exact pin" });
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "Private meeting point" }) });
  await expect(card.getByText("Location needed", { exact: true })).toBeVisible();
  await expect(card.getByText("Ask host for exact pin")).toBeVisible();
  await context.close();
});
