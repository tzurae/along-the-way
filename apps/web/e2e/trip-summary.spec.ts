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

const execFileAsync = promisify(execFile);

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
        const response = await request.get(
          "http://127.0.0.1:8025/api/v1/messages",
        );
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
  const detail = await request.get(
    `http://127.0.0.1:8025/api/v1/message/${messageId}`,
  );
  const link = mailpitText(await detail.json()).match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error(`Email for ${recipient} omitted its link`);
  return link;
}

async function openEmailLink(page: Page, link: string) {
  await page.goto("about:blank");
  await page.goto(link);
}

async function signIn(page: Page, request: APIRequestContext, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText(
    "If that email can sign in",
  );
  await openEmailLink(
    page,
    await emailLink(request, email, "Sign in to Along the Way"),
  );
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
}

function localDateLabel(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year!, month! - 1, day!).toLocaleDateString("en-US");
}

async function selectDateRange(
  page: Page,
  dialog: ReturnType<Page["getByRole"]>,
  startDate: string,
  endDate: string,
) {
  await dialog.getByRole("button", { name: "Choose a date range" }).click();
  const [year, month] = startDate.split("-").map(Number);
  const current = new Date();
  const monthOffset = year! * 12 + month! - 1 -
    (current.getFullYear() * 12 + current.getMonth());
  const direction = monthOffset >= 0 ? "Next" : "Previous";
  for (let step = 0; step < Math.abs(monthOffset); step += 1) {
    await page.getByRole("button", { name: new RegExp(direction, "i") }).click();
  }
  await page.locator(`[data-day="${localDateLabel(startDate)}"]`).click();
  await page.locator(`[data-day="${localDateLabel(endDate)}"]`).click();
}

async function createTrip(
  page: Page,
  input: TripInput,
  beforeSubmit?: (dialog: ReturnType<Page["getByRole"]>) => Promise<void>,
) {
  await page.getByRole("button", { name: "Create trip" }).click();
  const dialog = page.getByRole("dialog", { name: "Create a trip" });
  await dialog.getByLabel("Trip name").fill(input.name);
  await selectDateRange(page, dialog, input.startDate, input.endDate);
  for (const [index, stop] of input.countryStops.entries()) {
    const search = dialog.getByLabel("Add a country");
    await search.fill(stop.query);
    await expect(page.getByRole("option", { name: new RegExp(`\\(${stop.code}\\)`) })).toBeVisible();
    await search.press("Enter");
    await expect(
      dialog.locator('section[aria-labelledby="country-route-heading"] li'),
    ).toHaveCount(index + 1);
  }
  await beforeSubmit?.(dialog);
  await dialog.getByRole("button", { name: "Create trip", exact: true }).click();
  await expect(page.getByRole("heading", { name: input.name })).toBeVisible();
}

async function inviteEditor(
  page: Page,
  request: APIRequestContext,
  email: string,
) {
  await page.getByLabel("Invite editor by email").fill(email);
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByRole("status")).toContainText(email);
  return emailLink(request, email, "Join 大阪京都家庭旅行");
}

async function acceptEditor(
  context: BrowserContext,
  request: APIRequestContext,
  email: string,
  inviteLink: string,
) {
  const page = await context.newPage();
  await openEmailLink(page, inviteLink);
  await signIn(page, request, email);
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(
    page.getByRole("heading", { name: "大阪京都家庭旅行" }),
  ).toBeVisible();
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
  await request.delete("http://127.0.0.1:8025/api/v1/messages");

  await page.goto("/");
  await signIn(page, request, "owner@example.test");
  const createTripTrigger = page.getByRole("button", { name: "Create trip" });
  await createTripTrigger.click();
  await expect(page.getByRole("dialog", { name: "Create a trip" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Create a trip" })).toHaveCount(0);
  await expect(createTripTrigger).toBeFocused();

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

    const moveTaiwanUp = dialog.getByRole("button", { name: "Move stop 4 up" });
    await moveTaiwanUp.focus();
    await moveTaiwanUp.press("Enter");
    await expect(dialog.getByRole("button", { name: "Move stop 3 up" })).toBeFocused();
    await expect(dialog.getByRole("listitem").nth(2)).toContainText("(TW)");
    await dialog.getByRole("button", { name: "Remove stop 3" }).click();

    const routeItems = dialog.locator('section[aria-labelledby="country-route-heading"] li');
    await expect(routeItems).toHaveCount(3);

    const routeBeforeInvalidRemoval = await routeItems.allTextContents();
    await dialog.getByRole("button", { name: "Remove stop 2" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Removing that stop");
    expect(await routeItems.allTextContents()).toEqual(routeBeforeInvalidRemoval);
    await expect(routeItems.nth(2)).toContainText("(JP)");

    const search = dialog.getByLabel("Add a country");
    await search.fill("Japan");
    await expect(page.getByRole("option", { name: /\(JP\)/ })).toBeDisabled();
    await search.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(routeItems).toHaveCount(3);
    await search.press("Tab");
    await expect(page.getByRole("option", { name: /\(JP\)/ })).toHaveCount(0);

    const routeBeforeInvalidMove = await dialog.getByRole("listitem").allTextContents();
    await dialog.getByRole("button", { name: "Move stop 1 down" }).click();
    await expect(dialog.getByRole("alert")).toContainText("identical countries");
    expect(await dialog.getByRole("listitem").allTextContents()).toEqual(routeBeforeInvalidMove);
  });
  await expect(page.getByText("7 days", { exact: true })).toBeVisible();
  await expect(page.getByText("No inferred default currency")).toBeVisible();
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
  await expect(page.getByText("wife@example.test")).toBeVisible();
  await expect(page.getByText("mother@example.test")).toBeVisible();
  await expect(page.getByText("friend@example.test")).toBeVisible();
  await expect(page.getByText("4 members", { exact: true })).toBeVisible();

  const wifePage = editorPages[0]!;
  const motherPage = editorPages[1]!;
  await motherPage.reload();
  await expect(motherPage.getByText("friend@example.test")).toBeVisible();
  await expect(motherPage.getByText("4 members", { exact: true })).toBeVisible();

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
  await expect(wifePage.getByText("Default currency TWD")).toBeVisible();
  await expect(wifePage.getByText("Asia/Taipei", { exact: true })).toBeVisible();
  await wifePage
    .getByRole("button", { name: /大阪京都家庭旅行/ })
    .click();
  await expect(wifePage.getByText("friend@example.test")).toBeVisible();
  await expect(wifePage.getByText("4 members", { exact: true })).toBeVisible();

  await expect(wifePage.getByLabel("Invite editor by email")).toHaveCount(0);
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
  await wifePage.getByRole("button", { name: "Accept invitation" }).click();
  await expect(wifePage.getByRole("alert")).toContainText("already used");

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
  await outsiderPage.getByRole("button", { name: "Accept invitation" }).click();
  await expect(outsiderPage.getByRole("alert")).toContainText(
    "email address that received",
  );

  const revokedLink = await inviteEditor(
    page,
    request,
    "revoked@example.test",
  );
  const revokedItem = page
    .getByRole("listitem")
    .filter({ hasText: "revoked@example.test" });
  await revokedItem.getByRole("button", { name: "Revoke" }).click();
  await expect(revokedItem).toHaveCount(0);
  const revokedContext = await browser.newContext();
  const revokedPage = await revokedContext.newPage();
  await revokedPage.goto("/");
  await signIn(revokedPage, request, "revoked@example.test");
  await openEmailLink(revokedPage, revokedLink);
  await revokedPage.getByRole("button", { name: "Accept invitation" }).click();
  await expect(revokedPage.getByRole("alert")).toContainText("revoked");

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
  await expiredPage.getByRole("button", { name: "Accept invitation" }).click();
  await expect(expiredPage.getByRole("alert")).toContainText("expired");

  expect(await privateTripStatus(wifePage, osakaTripId)).toBe(200);
  const wifeItem = page
    .getByRole("listitem")
    .filter({ hasText: "wife@example.test" });
  await wifeItem.getByRole("button", { name: "Remove" }).click();
  await expect(wifeItem).toHaveCount(0);
  expect(await privateTripStatus(wifePage, osakaTripId)).toBe(404);

  await createTrip(page, {
    name: "首爾週末",
    startDate: "2027-03-05",
    endDate: "2027-03-07",
    countryStops: [{ code: "KR", query: "kr" }],
  });
  await expect(page.getByText("3 days", { exact: true })).toBeVisible();

  const invalidContext = await browser.newContext();
  const invalidPage = await invalidContext.newPage();
  await invalidPage.goto("/#magicToken=not-a-real-token");
  await expect(invalidPage.getByRole("status")).toContainText(
    "request a new sign-in link",
  );

  await Promise.all([
    ...editorContexts.map((context) => context.close()),
    outsiderContext.close(),
    revokedContext.close(),
    expiredContext.close(),
    invalidContext.close(),
  ]);
});
