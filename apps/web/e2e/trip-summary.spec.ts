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
  currency: string;
  destinations: string;
  endDate: string;
  name: string;
  startDate: string;
  timeZone: string;
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

async function createTrip(page: Page, input: TripInput) {
  await page.getByRole("button", { name: "Create trip" }).click();
  await page.getByLabel("Trip name").fill(input.name);
  await page.getByLabel("Start date").fill(input.startDate);
  await page.getByLabel("End date").fill(input.endDate);
  await page
    .getByLabel("Destinations, separated by commas")
    .fill(input.destinations);
  await page.getByLabel("IANA time zone").fill(input.timeZone);
  await page.getByLabel("Currency").fill(input.currency);
  await page
    .getByRole("button", { name: "Create trip", exact: true })
    .click();
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
  await createTrip(page, {
    name: "大阪京都家庭旅行",
    startDate: "2026-10-21",
    endDate: "2026-10-27",
    destinations: "大阪, 京都",
    timeZone: "Asia/Tokyo",
    currency: "JPY",
  });
  await expect(page.getByText("7 days", { exact: true })).toBeVisible();
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
    destinations: "台北",
    timeZone: "Asia/Taipei",
    currency: "TWD",
  });
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
    destinations: "首爾",
    timeZone: "Asia/Seoul",
    currency: "KRW",
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
