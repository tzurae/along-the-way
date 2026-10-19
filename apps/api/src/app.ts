import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { PostgresCollaborationModule } from "./private-trips/postgres-collaboration-module";
import { conflictResolutionContext, normalizeEmail } from "./private-trips/postgres-private-trip-store";
import type {
  ConstraintInput,
  CreateItineraryItemInput,
  CreatePlaceInput,
  ItineraryItemDetails,
  ItineraryItemType,
  PlaceType,
  UpdateItineraryItemInput,
  UpdatePlaceInput,
  ZonedEndpointInput,
  TripLodgingInput,
} from "@along-the-way/contracts/trip-skeleton";
import type { TripFlightInput } from "@along-the-way/contracts/private-trips";
import type {
  CreateTripPlaceInput,
  MergeTripPlacesInput,
  MustItemKind,
  UpdateMemberVoteInput,
  UpdateTripPlaceDayAssignmentsInput,
  UpdateTripPlacePlanningInput,
} from "@along-the-way/contracts/trip-places";
import type { CreateDayRouteInput } from "@along-the-way/contracts/day-plans";
import type { MapsConfigResponse } from "@along-the-way/contracts/maps";
import type {
  CreateFeedbackInput,
  CreatePhotoFeedbackInput,
  FeedbackStatus,
  FeedbackType,
  PhotoFeedbackReason,
  UpdateFeedbackAdminInput,
} from "@along-the-way/contracts/admin";
import type { DiscoveryModule } from "./discovery/discovery-module";
import type { DayPlanModule } from "./planning/postgres-day-plan-module";
import type { PlanningSettingsModule } from "./planning/postgres-planning-settings-module";
import type { WholeTripPlanModule } from "./planning/postgres-whole-trip-plan-module";
import {
  parseDeletePlanningOverrideInput,
  parsePlanningDrafts,
  parsePutPlanningOverrideInput,
  parsePutPlanningSettingsInput,
} from "@along-the-way/contracts/planning";

import {
  AppError,
  type AuthenticatedUser,
  type CreateTripInput,
  type IdentityAccessModule,
  type LoginResult,
  type ReadinessProbe,
  type TripWorkspaceModule,
} from "./private-trips/private-trip-module";
import type { RateLimiter } from "./private-trips/postgres-rate-limiter";
import {
  MAX_ITINERARY_ITEM_CONSTRAINTS,
  MAX_ITINERARY_ITEM_PARTICIPANTS,
  type TripSkeletonModule,
} from "./trip-skeleton/trip-skeleton-module";
import type { TripPlaceModule } from "./trip-places/trip-place-module";
import {
  parsePlaceDetailDate,
  parsePlaceDetailReference,
  parsePlacePreviewIds,
} from "@along-the-way/contracts/place-details";
import type { PlaceDetailModule } from "./place-details/place-detail-module";
import type { PlaceGuideModule } from "./place-guides/place-guide-module";
import type { FeedbackModule } from "./admin/postgres-feedback-module";
import type { GoogleUsageModule } from "./admin/google-usage-module";

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface AppDependencies {
  collaboration: PostgresCollaborationModule;
  dayPlans: DayPlanModule;
  discovery: DiscoveryModule;
  feedback?: FeedbackModule;
  googleUsage?: GoogleUsageModule;
  identityAccess: IdentityAccessModule;
  mapsConfig?: MapsConfigResponse;
  appVersion?: string;
  placeDetails: PlaceDetailModule;
  placeGuides?: PlaceGuideModule;
  planningSettings?: PlanningSettingsModule;
  wholeTripPlans?: WholeTripPlanModule;
  rateLimiter: RateLimiter;
  readiness: ReadinessProbe;
  siteAddress: string;
  tripWorkspace: TripWorkspaceModule;
  tripSkeleton: TripSkeletonModule;
  tripPlaces: TripPlaceModule;
}

function objectBody(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("validation_error", "Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (typeof value !== "string") {
    throw new AppError("validation_error", `${name} must be a string`);
  }
  return value;
}

function optionalStringField(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") {
    throw new AppError("validation_error", `${name} must be a string or null`);
  }
  return value;
}

/** Requires the field to be present; null is an explicit value, not a missing one. */
function nullableStringField(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (value === null || typeof value === "string") return value;
  throw new AppError("validation_error", `${name} must be a string or null`);
}

function numberField(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (typeof value !== "number") {
    throw new AppError("validation_error", `${name} must be a number`);
  }
  return value;
}

function booleanField(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (typeof value !== "boolean") {
    throw new AppError("validation_error", `${name} must be true or false`);
  }
  return value;
}

function characterLength(value: string) {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

function feedbackTypeValue(value: unknown): FeedbackType {
  if (value === "bug" || value === "idea" || value === "other" || value === "photo") return value;
  throw new AppError("validation_error", "type must be bug, idea, other, or photo");
}

function photoFeedbackReasonValue(value: unknown): PhotoFeedbackReason {
  if (value === "wrong_place" || value === "poor_quality" || value === "other") return value;
  throw new AppError(
    "validation_error",
    "reason must be wrong_place, poor_quality, or other",
  );
}

function feedbackStatusValue(value: unknown): FeedbackStatus {
  if (value === "new" || value === "in_progress" || value === "done" || value === "wont_do") {
    return value;
  }
  throw new AppError("validation_error", "status must be new, in_progress, done, or wont_do");
}

function optionalNumberField(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (value === undefined || value === null) return value;
  if (typeof value !== "number") {
    throw new AppError("validation_error", `${name} must be a number or null`);
  }
  return value;
}

function arrayField(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (!Array.isArray(value)) {
    throw new AppError("validation_error", `${name} must be an array`);
  }
  return value;
}

function placeInput(body: Record<string, unknown>): CreatePlaceInput {
  return {
    name: stringField(body, "name"),
    type: stringField(body, "type") as PlaceType,
    address: optionalStringField(body, "address"),
    latitude: optionalNumberField(body, "latitude"),
    longitude: optionalNumberField(body, "longitude"),
    timeZone: optionalStringField(body, "timeZone"),
    sourceUrl: optionalStringField(body, "sourceUrl"),
    notes: optionalStringField(body, "notes"),
  };
}

function endpointInput(value: unknown): ZonedEndpointInput {
  const endpoint = objectBody(value);
  return {
    role: stringField(endpoint, "role") as ZonedEndpointInput["role"],
    countryStopId: nullableStringField(endpoint, "countryStopId"),
    placeId: stringField(endpoint, "placeId"),
    localDateTime: stringField(endpoint, "localDateTime"),
    timeZone: stringField(endpoint, "timeZone"),
    utcOffset: optionalStringField(endpoint, "utcOffset"),
  };
}

function constraintInput(value: unknown): ConstraintInput {
  const constraint = objectBody(value);
  return {
    type: stringField(constraint, "type") as ConstraintInput["type"],
    status: stringField(constraint, "status") as ConstraintInput["status"],
    minimumBufferMinutes: optionalNumberField(
      constraint,
      "minimumBufferMinutes",
    ),
  };
}

function itineraryItemInput(
  body: Record<string, unknown>,
): CreateItineraryItemInput {
  const type = stringField(body, "type") as ItineraryItemType;
  const details = objectBody(body.details);
  const moneyValue = body.money;
  const money =
    moneyValue === undefined || moneyValue === null
      ? null
      : (() => {
          const value = objectBody(moneyValue);
          return {
            amountMinor: numberField(value, "amountMinor"),
            currency: stringField(value, "currency"),
          };
        })();
  const participantMemberIds = body.participantMemberIds === null
    ? null
    : stringArrayField(body, "participantMemberIds");
  if (participantMemberIds && participantMemberIds.length > MAX_ITINERARY_ITEM_PARTICIPANTS) {
    throw new AppError("validation_error", `participantMemberIds cannot contain more than ${MAX_ITINERARY_ITEM_PARTICIPANTS} members`);
  }
  const endpointValues = arrayField(body, "endpoints");
  const expectedEndpointCount = type === "flight" || type === "lodging" || type === "transport" ? 2 : 1;
  if (endpointValues.length !== expectedEndpointCount) {
    throw new AppError("validation_error", `${type} must have exactly ${expectedEndpointCount} endpoint${expectedEndpointCount === 1 ? "" : "s"}`);
  }
  const constraintValues = body.constraints === undefined ? undefined : arrayField(body, "constraints");
  if (constraintValues && constraintValues.length > MAX_ITINERARY_ITEM_CONSTRAINTS) {
    throw new AppError("validation_error", `constraints cannot contain more than ${MAX_ITINERARY_ITEM_CONSTRAINTS} entries`);
  }
  return {
    type,
    title: stringField(body, "title"),
    participantMemberIds,
    notes: optionalStringField(body, "notes"),
    sourceUrl: optionalStringField(body, "sourceUrl"),
    money,
    endpoints: endpointValues.map(endpointInput),
    details: details as unknown as ItineraryItemDetails,
    constraints: constraintValues?.map(constraintInput),
  };
}
function stringArrayField(body: Record<string, unknown>, name: string) {
  const values = arrayField(body, name);
  if (values.some((value) => typeof value !== "string")) {
    throw new AppError("validation_error", `${name} must be an array of strings`);
  }
  return values as string[];
}

function discoveryClarifyAnswersField(body: Record<string, unknown>) {
  return arrayField(body, "answers").map((value) => {
    const answer = objectBody(value);
    return {
      id: stringField(answer, "id"),
      answer: nullableStringField(answer, "answer"),
    };
  });
}


function tripPlaceInput(body: Record<string, unknown>): CreateTripPlaceInput {
  const method = stringField(body, "method");
  if (method === "manual") {
    return {
      method,
      name: stringField(body, "name"),
      type: stringField(body, "type") as PlaceType,
      address: optionalStringField(body, "address"),
      latitude: optionalNumberField(body, "latitude"),
      longitude: optionalNumberField(body, "longitude"),
      timeZone: optionalStringField(body, "timeZone"),
      sourceUrl: optionalStringField(body, "sourceUrl"),
      originalNote: optionalStringField(body, "originalNote"),
    };
  }
  if (method === "google-maps-url" || method === "search") {
    return {
      method,
      providerPlaceId: stringField(body, "providerPlaceId"),
      sourceUrl: optionalStringField(body, "sourceUrl"),
      originalNote: optionalStringField(body, "originalNote"),
    };
  }
  throw new AppError("validation_error", "method is invalid");
}

function planningInput(
  body: Record<string, unknown>,
): UpdateTripPlacePlanningInput {
  const effortLevel = optionalNumberField(body, "effortLevel");
  if (effortLevel !== undefined && effortLevel !== null
    && (!Number.isInteger(effortLevel) || effortLevel < 1 || effortLevel > 5)) {
    throw new AppError("validation_error", "effortLevel must be an integer from 1 to 5 or null");
  }
  return {
    expectedVersion: numberField(body, "expectedVersion"),
    durationMinutes: optionalNumberField(body, "durationMinutes"),
    ...(effortLevel === undefined ? {} : { effortLevel }),
    budgetAmountMinor: optionalNumberField(body, "budgetAmountMinor"),
    budgetCurrency: optionalStringField(body, "budgetCurrency"),
    notes: optionalStringField(body, "notes"),
  };
}

function dayAssignmentsInput(
  body: Record<string, unknown>,
): UpdateTripPlaceDayAssignmentsInput {
  return {
    assignments: arrayField(body, "assignments").map((value) => {
      const assignment = objectBody(value);
      return {
        tripPlaceId: stringField(assignment, "tripPlaceId"),
        tripDayId: assignment.tripDayId === null
          ? null
          : stringField(assignment, "tripDayId"),
        expectedVersion: numberField(assignment, "expectedVersion"),
      };
    }),
  };
}

function voteInput(body: Record<string, unknown>): UpdateMemberVoteInput {
  if (typeof body.voted !== "boolean") {
    throw new AppError("validation_error", "voted must be a boolean");
  }
  return { voted: body.voted };
}

function mustItemInput(body: Record<string, unknown>) {
  return {
    kind: stringField(body, "kind") as MustItemKind,
    label: stringField(body, "label"),
  };
}

function updateMustItemInput(body: Record<string, unknown>) {
  return {
    ...mustItemInput(body),
    expectedVersion: numberField(body, "expectedVersion"),
  };
}

function mergeInput(body: Record<string, unknown>): MergeTripPlacesInput {
  return {
    targetTripPlaceId: stringField(body, "targetTripPlaceId"),
    expectedSourceVersion: numberField(body, "expectedSourceVersion"),
    expectedTargetVersion: numberField(body, "expectedTargetVersion"),
  };
}

function uuidParam(context: Context, name: string) {
  const value = context.req.param(name);
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new AppError("validation_error", `${name} must be a UUID`);
  }
  // Postgres compares UUIDs case-insensitively; idempotency/operation keys must use the same canonical form.
  return value.toLowerCase();
}

function clientIp(context: Context) {
  const forwarded = context.req.header("X-Forwarded-For");
  return forwarded?.split(",").at(-1)?.trim() || "unknown";
}

function idempotencyKey(context: Context) {
  const value = context.req.header("Idempotency-Key")?.trim();
  if (!value || value.length > 200) {
    throw new AppError(
      "validation_error",
      "A valid Idempotency-Key is required",
    );
  }
  return value;
}

async function jsonBody(context: Context) {
  try {
    return objectBody(await context.req.json());
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("validation_error", "Request body must be valid JSON");
  }
}

function planningRequest<T>(parse: (value: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch {
    throw new AppError("validation_error", "行程設定格式不正確");
  }
}

export function createApp({
  appVersion = "unknown",
  collaboration,
  dayPlans,
  discovery,
  feedback,
  googleUsage,
  identityAccess,
  mapsConfig = { browserKey: null, mapId: null },
  placeDetails,
  placeGuides,
  planningSettings,
  wholeTripPlans,
  rateLimiter,
  readiness,
  siteAddress,
  tripPlaces,
  tripSkeleton,
  tripWorkspace,
}: AppDependencies) {
  const app = new Hono();
  const exposedMapsConfig: MapsConfigResponse = {
    browserKey: mapsConfig.browserKey?.trim() || null,
    mapId: mapsConfig.mapId?.trim() || null,
  };
  const site = new URL(siteAddress);
  if (site.protocol !== "https:" &&
    !(site.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(site.hostname))) {
    throw new Error("SITE_ADDRESS must use HTTPS, except HTTP on localhost, 127.0.0.1 or ::1.");
  }
  const secureCookie = site.protocol === "https:";
  const SESSION_COOKIE = secureCookie ? "__Host-along_the_way_session" : "along_the_way_session";
  const LOGIN_NONCE_COOKIE = secureCookie ? "__Host-along_the_way_login_nonce" : "along_the_way_login_nonce";
  const expectedOrigin = site.origin;
  const activeEventStreams = new Map<string, number>();
  const maxEventStreamsPerAccount = 6;
  const withPaidProviderIdentity = <T>(
    context: Context,
    userId: string,
    work: () => Promise<T>,
  ) => rateLimiter.withPaidProviderIdentity(clientIp(context), userId, work);

  function acquireEventStream(userId: string) {
    const active = activeEventStreams.get(userId) ?? 0;
    if (active >= maxEventStreamsPerAccount) {
      throw new AppError("rate_limited", "Too many open event streams", 429, 5);
    }
    activeEventStreams.set(userId, active + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (activeEventStreams.get(userId) ?? 1) - 1;
      if (remaining > 0) activeEventStreams.set(userId, remaining);
      else activeEventStreams.delete(userId);
    };
  }


  function refreshCookie(context: Context, token: string) {
    setCookie(context, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
  }

  function loginNonce(context: Context) {
    const nonce = randomBytes(32).toString("base64url");
    setCookie(context, LOGIN_NONCE_COOKIE, nonce, {
      httpOnly: true, secure: secureCookie, sameSite: "Lax", path: "/", maxAge: 15 * 60,
    });
    return nonce;
  }

  function loginContext(context: Context, body: Record<string, unknown>) {
    return {
      nonce: getCookie(context, LOGIN_NONCE_COOKIE) ?? "",
      sessionToken: getCookie(context, SESSION_COOKIE) ?? "",
      confirm: body.confirm === true,
    };
  }

  function loginResponse(context: Context, result: LoginResult) {
    if ("confirmationRequired" in result) {
      return context.json({
        error: { code: "confirmation_required", message: "Confirm signing in on this device." },
        targetEmail: result.targetEmail,
        currentEmail: result.currentEmail,
      }, 409);
    }
    refreshCookie(context, result.sessionToken);
    deleteCookie(context, LOGIN_NONCE_COOKIE, { path: "/", secure: secureCookie, sameSite: "Lax" });
    return context.json({
      user: result.user,
      ...(result.acceptedTripId ? { acceptedTripId: result.acceptedTripId } : {}),
      ...(result.inviteOutcome ? { inviteOutcome: result.inviteOutcome } : {}),
    });
  }

  async function authenticated(
    context: Context,
  ): Promise<{ user: AuthenticatedUser; token: string }> {
    const token = getCookie(context, SESSION_COOKIE) ?? "";
    const user = await identityAccess.authenticate(token);
    if (!user) {
      throw new AppError("unauthenticated", "Sign in to continue", 401);
    }
    refreshCookie(context, token);
    return { user, token };
  }

  async function authenticatedAdmin(context: Context) {
    const authenticatedSession = await authenticated(context);
    if (!authenticatedSession.user.isAdmin) {
      throw new AppError("forbidden", "Administrator access required", 403);
    }
    return authenticatedSession;
  }

  // Reject oversized bodies before parsing, authentication or rate limiting. Auth bodies hold only
  // an email or token. The largest legitimate API body is a whole-trip plan apply at the domain
  // bounds (366 days × 100 place ids ≈ 1.5 MB), so the general limit is 2 MiB.
  const payloadTooLarge = (context: Context) =>
    context.json({ error: { code: "payload_too_large", message: "Request body is too large" } }, 413);
  app.use("/api/auth/*", bodyLimit({ maxSize: 8 * 1024, onError: payloadTooLarge }));
  app.use("/api/*", bodyLimit({ maxSize: 2 * 1024 * 1024, onError: payloadTooLarge }));

  app.use("/api/*", async (context, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(context.req.method)) {
      const baseVersion = context.req.header("Conflict-Base-Version");
      if (baseVersion !== undefined && (!/^[1-9][0-9]*$/.test(baseVersion) || !Number.isSafeInteger(Number(baseVersion)) || Number(baseVersion) > 2_147_483_647)) {
        throw new AppError("validation_error", "Conflict-Base-Version must be a positive integer");
      }
      const origin = context.req.header("Origin");
      if (origin !== expectedOrigin) {
        throw new AppError("forbidden", "Same-origin mutation required", 403);
      }
    }
    await conflictResolutionContext.run(context.req.header("Conflict-Base-Version"), next);
  });

  app.get("/health", (context) => context.json({ status: "ok" }));

  app.get("/ready", async (context) => {
    try {
      if (await readiness.isReady()) {
        return context.json({
          status: "ready",
          dependencies: {
            database: "available",
            emailWorker: "available",
          },
        });
      }
    } catch {
      // Readiness intentionally turns dependency errors into a stable 503 contract.
    }
    return context.json(
      {
        status: "not_ready",
        dependencies: {
          database: "unavailable",
          emailWorker: "unavailable",
        },
      },
      503,
    );
  });

  app.post("/api/auth/magic-links", async (context) => {
    const body = await jsonBody(context);
    const email = normalizeEmail(stringField(body, "email"));
    const nonce = loginNonce(context);
    await rateLimiter.consume("magic_link", clientIp(context), email);
    await identityAccess.requestMagicLink(email, nonce);
    return context.json(
      {
        message:
          "If that email can sign in, a one-time link has been sent.",
      },
      202,
    );
  });

  app.post("/api/auth/invite-magic-links", async (context) => {
    const body = await jsonBody(context);
    const inviteToken = stringField(body, "inviteToken");
    const nonce = loginNonce(context);
    const rateLimitKey = createHash("sha256").update(inviteToken).digest("hex");
    await rateLimiter.consume("magic_link", clientIp(context), rateLimitKey);
    await identityAccess.requestInviteMagicLink(inviteToken, nonce);
    return context.json(
      {
        message:
          "If that invitation is still valid, a one-time link has been sent.",
      },
      202,
    );
  });

  app.post("/api/auth/magic-links/consume", async (context) => {
    const body = await jsonBody(context);
    await rateLimiter.consume("magic_link_consume", clientIp(context));
    return loginResponse(context, await identityAccess.consumeMagicLink(
      stringField(body, "token"), loginContext(context, body),
    ));
  });

  app.post("/api/auth/magic-links/verify-code", async (context) => {
    const body = await jsonBody(context);
    const email = normalizeEmail(stringField(body, "email"));
    await rateLimiter.consume("magic_link_code", clientIp(context), email);
    return loginResponse(context, await identityAccess.verifyMagicLinkCode(
      email, stringField(body, "code"), loginContext(context, body),
    ));
  });

  app.get("/api/session", async (context) => {
    const { user } = await authenticated(context);
    return context.json({ user });
  });

  app.post("/api/feedback", async (context) => {
    const { user } = await authenticated(context);
    if (!feedback) throw new AppError("service_unavailable", "Feedback is unavailable", 503);
    await rateLimiter.consume("feedback", clientIp(context), user.id);
    const body = await jsonBody(context);
    const feedbackBody = stringField(body, "body");
    const page = nullableStringField(body, "page");
    const tripId = nullableStringField(body, "tripId");
    const viewport = nullableStringField(body, "viewport");
    const feedbackBodyLength = characterLength(feedbackBody);
    if (feedbackBodyLength < 10 || feedbackBodyLength > 2_000) {
      throw new AppError("validation_error", "body must be between 10 and 2000 characters");
    }
    if (page !== null && characterLength(page) > 200) {
      throw new AppError("validation_error", "page must be at most 200 characters");
    }
    if (tripId !== null
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tripId)) {
      throw new AppError("validation_error", "tripId must be a UUID or null");
    }
    if (viewport !== null && characterLength(viewport) > 20) {
      throw new AppError("validation_error", "viewport must be at most 20 characters");
    }
    const type = feedbackTypeValue(body.type);
    if (type === "photo") {
      throw new AppError("validation_error", "Photo feedback must use the photo-feedback endpoint");
    }
    const input: CreateFeedbackInput = {
      type,
      body: feedbackBody,
      page,
      tripId: tripId?.toLowerCase() ?? null,
      contactAllowed: booleanField(body, "contactAllowed"),
      viewport,
    };
    return context.json(await feedback.submit(user.id, input, {
      appVersion: appVersion.slice(0, 500),
      userAgent: context.req.header("User-Agent")?.slice(0, 500) || null,
    }), 201);
  });

  app.get("/api/admin/feedback", async (context) => {
    await authenticatedAdmin(context);
    if (!feedback) throw new AppError("service_unavailable", "Feedback is unavailable", 503);
    const rawStatus = context.req.query("status");
    const rawType = context.req.query("type");
    const status = rawStatus === undefined ? undefined : feedbackStatusValue(rawStatus);
    const type = rawType === undefined ? undefined : feedbackTypeValue(rawType);
    return context.json({ feedback: await feedback.list({ status, type }) });
  });

  app.patch("/api/admin/feedback/:id", async (context) => {
    await authenticatedAdmin(context);
    if (!feedback) throw new AppError("service_unavailable", "Feedback is unavailable", 503);
    const body = await jsonBody(context);
    const input: UpdateFeedbackAdminInput = {};
    if (Object.hasOwn(body, "status")) input.status = feedbackStatusValue(body.status);
    if (Object.hasOwn(body, "adminNote")) {
      const adminNote = nullableStringField(body, "adminNote");
      if (adminNote !== null && adminNote !== undefined && characterLength(adminNote) > 2_000) {
        throw new AppError("validation_error", "adminNote must be at most 2000 characters");
      }
      input.adminNote = adminNote;
    }
    if (input.status === undefined && input.adminNote === undefined) {
      throw new AppError("validation_error", "status or adminNote is required");
    }
    return context.json(await feedback.update(uuidParam(context, "id"), input));
  });

  app.post("/api/admin/feedback/:id/remove-photo", async (context) => {
    const { user } = await authenticatedAdmin(context);
    if (!feedback) throw new AppError("service_unavailable", "Feedback is unavailable", 503);
    return context.json(await feedback.removePhoto(uuidParam(context, "id"), user.id));
  });

  app.get("/api/admin/google-usage", async (context) => {
    await authenticatedAdmin(context);
    if (!googleUsage) throw new AppError("service_unavailable", "Google usage is unavailable", 503);
    return context.json(await googleUsage.get());
  });

  app.post("/api/admin/places/:placeId/guide/regenerate", async (context) => {
    const { user } = await authenticatedAdmin(context);
    if (!placeGuides) throw new AppError("service_unavailable", "Place guides are unavailable", 503);
    const guide = await placeGuides.regenerate(
      uuidParam(context, "placeId"),
      () => rateLimiter.consume("place_guide_generation", clientIp(context), user.id),
    );
    context.header("Cache-Control", "private, no-store");
    return context.json({ guide });
  });

  app.get("/api/maps/config", async (context) => {
    await authenticated(context);
    return context.json(exposedMapsConfig);
  });

  app.post("/api/maps/load", async (context) => {
    const { user } = await authenticated(context);
    const reserved = await withPaidProviderIdentity(
      context,
      user.id,
      () => rateLimiter.tryConsumePaidProvider("google_maps_js"),
    );
    if (!reserved) {
      throw new AppError(
        "maps_daily_limit",
        "The daily Google Maps load limit is reached",
        429,
      );
    }
    return context.body(null, 204);
  });
  // A member edits only their own nickname: the target is always the session's user.
  app.put("/api/session/profile", async (context) => {
    const { user } = await authenticated(context);
    const body = await jsonBody(context);
    if (body.displayName !== null && typeof body.displayName !== "string") {
      throw new AppError("validation_error", "displayName must be a string or null");
    }
    return context.json({ user: await identityAccess.updateDisplayName(user.id, body.displayName) });
  });


  app.post("/api/logout", async (context) => {
    const token = getCookie(context, SESSION_COOKIE) ?? "";
    let targetUserId: string | undefined;
    if (await context.req.text()) {
      const body = await jsonBody(context);
      if (body.userId !== undefined) {
        targetUserId = stringField(body, "userId");
        if (!targetUserId) throw new AppError("validation_error", "userId must not be empty");
      }
    }
    await identityAccess.logout(token, targetUserId);
    deleteCookie(context, SESSION_COOKIE, {
      path: "/",
      secure: secureCookie,
      sameSite: "Lax",
    });
    return context.body(null, 204);
  });

  app.post("/api/logout-everywhere", async (context) => {
    const { user } = await authenticated(context);
    await identityAccess.logoutEverywhere(user.id);
    deleteCookie(context, SESSION_COOKIE, { path: "/", secure: secureCookie, sameSite: "Lax" });
    return context.body(null, 204);
  });

  app.get("/api/trips", async (context) => {
    const { user } = await authenticated(context);
    return context.json({ trips: await tripWorkspace.listTrips(user.id) });
  });

  app.post("/api/trips", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_create", clientIp(context), user.id);
    const body = await jsonBody(context);
    const countryCodes = body.countryCodes;
    if (
      !Array.isArray(countryCodes) ||
      countryCodes.some((value) => typeof value !== "string")
    ) {
      throw new AppError(
        "validation_error",
        "countryCodes must be an array of strings",
      );
    }
    const input: CreateTripInput = {
      name: stringField(body, "name"),
      startDate: stringField(body, "startDate"),
      endDate: stringField(body, "endDate"),
      countryCodes,
      // The workspace validates this after replaying historical create_trip responses.
      flights: body.flights as CreateTripInput["flights"],
    };
    const trip = await tripWorkspace.createTrip(
      user.id,
      idempotencyKey(context),
      input,
    );
    return context.json({ trip }, 201);
  });

  app.get("/api/trips/:tripId", async (context) => {
    const { user } = await authenticated(context);
    const trip = await tripWorkspace.getTrip(user.id, uuidParam(context, "tripId"));
    return context.json({ trip });
  });

  app.get("/api/trips/:tripId/version", async (context) => {
    const { user } = await authenticated(context);
    context.header("Cache-Control", "no-store");
    return context.json(await collaboration.version(user.id, uuidParam(context, "tripId")));
  });

  app.get("/api/trips/:tripId/history", async (context) => {
    const { user } = await authenticated(context);
    context.header("Cache-Control", "no-store");
    return context.json(await collaboration.history(
      user.id, uuidParam(context, "tripId"), context.req.query("before") ?? null,
      Number(context.req.query("limit") ?? 30),
    ));
  });

  app.get("/api/trips/:tripId/events", async (context) => {
    const { user, token } = await authenticated(context);
    const releaseStream = acquireEventStream(user.id);
    context.req.raw.signal.addEventListener("abort", releaseStream, { once: true });
    try {
      const tripId = uuidParam(context, "tripId");
      const cursor = context.req.header("Last-Event-ID") ?? context.req.query("after") ?? null;
      let order = await collaboration.cursor(user.id, tripId, cursor);
      context.header("Cache-Control", "no-store");
      context.header("X-Accel-Buffering", "no");
      return streamSSE(context, async (stream) => {
        async function authorized() {
          if (!await identityAccess.authenticate(token)) throw new AppError("unauthenticated", "Sign in to continue", 401);
          await collaboration.authorize(user.id, tripId);
        }
        try {
          await stream.write(": connected\n\n");
          let heartbeatAt = Date.now();
          while (!stream.aborted && !context.req.raw.signal.aborted) {
            // `after` authorizes current membership. Avoid refreshing the session row
            // every second while idle; token validity is rechecked on each payload and heartbeat.
            const events = await collaboration.after(user.id, tripId, order);
            for (const event of events) {
              await authorized();
              await stream.writeSSE({ id: event.notification.id, event: "change", data: JSON.stringify(event.notification) });
              order = event.order;
            }
            if (Date.now() - heartbeatAt >= 15_000) {
              await authorized();
              await stream.write(": heartbeat\n\n");
              heartbeatAt = Date.now();
            }
            if (events.length < 100) await stream.sleep(1_000);
          }
        } catch (error) {
          if (!(error instanceof AppError) && !stream.aborted) {
            console.error(JSON.stringify({ event: "trip_stream_failed", tripId, actorId: user.id, correlationId: randomUUID() }));
          }
        } finally {
          releaseStream();
        }
      });
    } catch (error) {
      releaseStream();
      throw error;
    }
  });

  app.get("/api/trips/:tripId/skeleton", async (context) => {
    const { user } = await authenticated(context);
    const skeleton = await tripSkeleton.getSkeleton(
      user.id,
      uuidParam(context, "tripId"),
    );
    return context.json({ skeleton });
  });
  app.get("/api/trips/:tripId/trip-places", async (context) => {
    const { user } = await authenticated(context);
    return context.json({
      tripPlaces: await tripPlaces.list(user.id, uuidParam(context, "tripId")),
    });
  });

  app.post("/api/trips/:tripId/trip-places/:tripPlaceId/photo-feedback", async (context) => {
    const { user } = await authenticated(context);
    if (!feedback) throw new AppError("service_unavailable", "Feedback is unavailable", 503);
    await rateLimiter.consume("feedback", clientIp(context), user.id);
    const body = await jsonBody(context);
    const note = nullableStringField(body, "note");
    if (note !== null && characterLength(note) > 500) {
      throw new AppError("validation_error", "note must be at most 500 characters");
    }
    const input: CreatePhotoFeedbackInput = {
      reason: photoFeedbackReasonValue(body.reason),
      note,
    };
    return context.json(await feedback.submitPhoto(
      user.id,
      uuidParam(context, "tripId"),
      uuidParam(context, "tripPlaceId"),
      input,
      {
        appVersion: appVersion.slice(0, 500),
        userAgent: context.req.header("User-Agent")?.slice(0, 500) || null,
      },
    ), 201);
  });

  app.get("/api/trips/:tripId/place-guide", async (context) => {
    const { user } = await authenticated(context);
    if (!placeGuides) throw new AppError("service_unavailable", "Place guides are unavailable", 503);
    let reference;
    try {
      reference = parsePlaceDetailReference({
        kind: context.req.query("kind"),
        id: context.req.query("id"),
      });
    } catch {
      throw new AppError("validation_error", "Invalid place guide reference");
    }
    const guide = await placeGuides.getGuide(
      user.id,
      uuidParam(context, "tripId"),
      reference,
      () => rateLimiter.consume("place_guide_generation", clientIp(context), user.id),
    );
    context.header("Cache-Control", "private, no-store");
    return context.json({ guide });
  });

  app.get("/api/trips/:tripId/trip-places/:tripPlaceId/guide", async (context) => {
    const { user } = await authenticated(context);
    if (!placeGuides) throw new AppError("service_unavailable", "Place guides are unavailable", 503);
    const guide = await placeGuides.getGuide(
      user.id,
      uuidParam(context, "tripId"),
      { kind: "trip-place", id: uuidParam(context, "tripPlaceId") },
      () => rateLimiter.consume("place_guide_generation", clientIp(context), user.id),
    );
    context.header("Cache-Control", "private, no-store");
    return context.json({ guide });
  });

  app.get("/api/trips/:tripId/place-details", async (context) => {
    const { user } = await authenticated(context);
    let reference;
    let date;
    try {
      reference = parsePlaceDetailReference({ kind: context.req.query("kind"), id: context.req.query("id") });
      const requestedDate = context.req.query("date");
      date = requestedDate === undefined ? null : parsePlaceDetailDate(requestedDate);
    } catch {
      throw new AppError("validation_error", "Invalid place detail reference or date");
    }
    let includeGooglePhoto = true;
    try {
      await rateLimiter.consume("place_photo_metadata", clientIp(context), user.id);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "rate_limited") throw error;
      includeGooglePhoto = false;
    }
    const result = await withPaidProviderIdentity(context, user.id, () => placeDetails.getDetail(
      user.id,
      uuidParam(context, "tripId"),
      reference,
      date,
      includeGooglePhoto,
    ));
    context.header("Cache-Control", result.googleFallbackFailed ? "private, no-store" : "private, max-age=3600");
    // Google photo URLs are signed for this user; another member in the same browser must not reuse them.
    context.header("Vary", "Cookie");
    return context.json({ detail: result.detail });
  });

  app.get("/api/trips/:tripId/place-previews", async (context) => {
    const { user } = await authenticated(context);
    let ids;
    let kind;
    try {
      ids = parsePlacePreviewIds(context.req.query("ids"));
      kind = parsePlaceDetailReference({ kind: context.req.query("kind"), id: ids[0] }).kind;
    } catch {
      throw new AppError("validation_error", "Invalid place preview references");
    }
    const result = await placeDetails.getPreviews(
      user.id,
      uuidParam(context, "tripId"),
      kind,
      ids,
    );
    // Previews change when a Commons photo is found in the background (e.g. seconds after an AI
    // run), so the browser must not reuse an older "no photo" answer. The query is cheap.
    context.header("Cache-Control", "private, no-cache");
    return context.json({ previews: result.previews });
  });

  app.get("/api/trips/:tripId/place-photo-assets/:filename", async (context) => {
    const { user } = await authenticated(context);
    let reference;
    try {
      reference = parsePlaceDetailReference({ kind: context.req.query("kind"), id: context.req.query("id") });
    } catch {
      throw new AppError("validation_error", "Invalid photo reference");
    }
    context.header("Cache-Control", "private, no-store");
    context.header("X-Content-Type-Options", "nosniff");
    const asset = await placeDetails.getPhotoAsset(user.id, uuidParam(context, "tripId"), reference, context.req.param("filename"));
    return new Response(asset.bytes, { headers: {
      "Content-Type": asset.mediaType,
      "Content-Length": String(asset.bytes.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  });

  app.get("/api/trips/:tripId/google-place-photos/:providerPlaceId", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("place_photo", clientIp(context), user.id);
    const requestedWidth = context.req.query("maxWidth");
    const maxWidth = requestedWidth === "192" ? 192 : requestedWidth === "1024" ? 1024 : null;
    if (maxWidth === null) throw new AppError("validation_error", "maxWidth must be 192 or 1024");
    const requestedIndex = context.req.query("index");
    if (requestedIndex === undefined) {
      throw new AppError("place_photo_not_found", "Place photo not found", 404);
    }
    const index = requestedIndex === "0" ? 0 : requestedIndex === "1" ? 1 : requestedIndex === "2" ? 2 : null;
    if (index === null) throw new AppError("validation_error", "index must be 0, 1, or 2");
    const photo = await withPaidProviderIdentity(context, user.id, () => placeDetails.getGooglePhoto(
      user.id,
      uuidParam(context, "tripId"),
      context.req.param("providerPlaceId"),
      index,
      context.req.query("photo") ?? "",
      context.req.query("resource") ?? "",
      maxWidth,
      context.req.query("exp") ?? null,
      context.req.query("sig") ?? null,
    ));
    return new Response(photo.bytes, { headers: {
      "Content-Type": photo.mediaType,
      "Content-Length": String(photo.bytes.byteLength),
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    } });
  });

  app.get("/api/trips/:tripId/discovery", async (context) => {
    const { user } = await authenticated(context);
    return context.json({
      discovery: await discovery.getWorkspace(user.id, uuidParam(context, "tripId")),
    });
  });

  app.put("/api/trips/:tripId/discovery/brief", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    return context.json({
      discovery: await discovery.saveBrief(
        user.id,
        uuidParam(context, "tripId"),
        idempotencyKey(context),
        {
          originalText: stringField(body, "originalText"),
          expectedVersion: optionalNumberField(body, "expectedVersion"),
        },
      ),
    });
  });
  // 調查 step 1: the AI drafts the checklist (no web search; trip_content limited per account).
  app.post("/api/trips/:tripId/discovery/clarification", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    return context.json({
      discovery: await discovery.startClarification(user.id, uuidParam(context, "tripId"), {
        expectedBriefVersion: numberField(body, "expectedBriefVersion"),
      }),
    });
  });

  // 調查 step 2: answers are saved and reviewed by the AI reviewer.
  app.put("/api/trips/:tripId/discovery/clarification/answers", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    return context.json({
      discovery: await discovery.answerClarification(user.id, uuidParam(context, "tripId"), {
        expectedVersion: numberField(body, "expectedVersion"),
        answers: discoveryClarifyAnswersField(body),
      }),
    });
  });

  // 調查 step 3: queues background research; the worker reports stages on the job.
  app.post("/api/trips/:tripId/discovery/research", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    return context.json({
      discovery: await discovery.startResearch(
        user.id,
        uuidParam(context, "tripId"),
        clientIp(context),
        idempotencyKey(context),
        { expectedBriefVersion: numberField(body, "expectedBriefVersion") },
      ),
    }, 202);
  });

  app.get("/api/trips/:tripId/discovery/jobs/latest", async (context) => {
    const { user } = await authenticated(context);
    context.header("Cache-Control", "private, no-store");
    return context.json({ job: await discovery.latestJob(user.id, uuidParam(context, "tripId")) });
  });

  app.post("/api/trips/:tripId/discovery/jobs/:jobId/ack", async (context) => {
    const { user } = await authenticated(context);
    return context.json({
      job: await discovery.acknowledgeJob(user.id, uuidParam(context, "tripId"), uuidParam(context, "jobId")),
    });
  });

  app.put("/api/trips/:tripId/discovery/proposals/:proposalId/vote", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    return context.json({
      proposal: await discovery.setProposalVote(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "proposalId"),
        idempotencyKey(context),
        voteInput(body),
      ),
    });
  });

  app.post("/api/trips/:tripId/discovery/proposals/schedule", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    return context.json({
      discovery: await discovery.scheduleProposals(
        user.id,
        uuidParam(context, "tripId"),
        idempotencyKey(context),
        {
          tripDayId: stringField(body, "tripDayId"),
          proposals: arrayField(body, "proposals").map((value) => {
            const proposal = objectBody(value);
            return {
              proposalId: stringField(proposal, "proposalId"),
              expectedVersion: numberField(proposal, "expectedVersion"),
            };
          }),
        },
      ),
    });
  });

  app.post("/api/trips/:tripId/discovery/proposals/:proposalId/reject", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    return context.json({
      discovery: await discovery.rejectProposal(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "proposalId"),
        idempotencyKey(context),
        { expectedVersion: numberField(body, "expectedVersion") },
      ),
    });
  });

  app.post("/api/trips/:tripId/discovery/proposals/:proposalId/restore", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    return context.json({
      discovery: await discovery.restoreProposal(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "proposalId"),
        idempotencyKey(context),
        { expectedVersion: numberField(body, "expectedVersion") },
      ),
    });
  });


  app.post("/api/trips/:tripId/trip-places/search", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    return context.json(
      await withPaidProviderIdentity(context, user.id, () => tripPlaces.search(
        user.id,
        uuidParam(context, "tripId"),
        stringField(body, "query"),
      )),
    );
  });

  app.post("/api/trips/:tripId/trip-places/resolve-url", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    return context.json(
      await withPaidProviderIdentity(context, user.id, () => tripPlaces.resolveUrl(
        user.id,
        uuidParam(context, "tripId"),
        stringField(body, "url"),
      )),
    );
  });

  app.post("/api/trips/:tripId/trip-places", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    const tripPlace = await withPaidProviderIdentity(context, user.id, () => tripPlaces.add(
      user.id,
      uuidParam(context, "tripId"),
      idempotencyKey(context),
      tripPlaceInput(body),
    ));
    return context.json({ tripPlace }, 201);
  });

  app.get(
    "/api/trips/:tripId/trip-places/:tripPlaceId/must-items",
    async (context) => {
      const { user } = await authenticated(context);
      const items = await tripPlaces.listMustItems(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "tripPlaceId"),
      );
      return context.json({ items });
    },
  );

  app.post(
    "/api/trips/:tripId/trip-places/:tripPlaceId/must-items",
    async (context) => {
      const { user } = await authenticated(context);
      await rateLimiter.consume("trip_content", clientIp(context), user.id);
      const body = await jsonBody(context);
      const item = await tripPlaces.createMustItem(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "tripPlaceId"),
        idempotencyKey(context),
        mustItemInput(body),
      );
      return context.json({ item }, 201);
    },
  );

  app.patch(
    "/api/trips/:tripId/trip-places/:tripPlaceId/must-items/:itemId",
    async (context) => {
      const { user } = await authenticated(context);
      await rateLimiter.consume("trip_content", clientIp(context), user.id);
      const body = await jsonBody(context);
      const item = await tripPlaces.updateMustItem(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "tripPlaceId"),
        uuidParam(context, "itemId"),
        idempotencyKey(context),
        updateMustItemInput(body),
      );
      return context.json({ item });
    },
  );

  app.delete(
    "/api/trips/:tripId/trip-places/:tripPlaceId/must-items/:itemId",
    async (context) => {
      const { user } = await authenticated(context);
      await rateLimiter.consume("trip_content", clientIp(context), user.id);
      const body = await jsonBody(context);
      await tripPlaces.removeMustItem(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "tripPlaceId"),
        uuidParam(context, "itemId"),
        idempotencyKey(context),
        numberField(body, "expectedVersion"),
      );
      return context.json({ removed: true });
    },
  );

  app.patch(
    "/api/trips/:tripId/trip-places/:tripPlaceId/planning",
    async (context) => {
      const { user } = await authenticated(context);
      await rateLimiter.consume("trip_content", clientIp(context), user.id);
      const body = await jsonBody(context);
      const tripPlace = await tripPlaces.updatePlanning(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "tripPlaceId"),
        idempotencyKey(context),
        planningInput(body),
      );
      return context.json({ tripPlace });
    },
  );

  app.put(
    "/api/trips/:tripId/trip-place-day-assignments",
    async (context) => {
      const { user } = await authenticated(context);
      await rateLimiter.consume("trip_content", clientIp(context), user.id);
      const body = await jsonBody(context);
      const assigned = await tripPlaces.updateDayAssignments(
        user.id,
        uuidParam(context, "tripId"),
        idempotencyKey(context),
        dayAssignmentsInput(body),
      );
      return context.json({ tripPlaces: assigned });
    },
  );

  app.get("/api/trips/:tripId/planning-settings", async (context) => {
    const { user } = await authenticated(context);
    if (!planningSettings) throw new AppError("service_unavailable", "Planning settings are unavailable", 503);
    context.header("Cache-Control", "private, no-store");
    return context.json(await planningSettings.getSettings(user.id, uuidParam(context, "tripId")));
  });

  app.put("/api/trips/:tripId/planning-settings", async (context) => {
    const { user } = await authenticated(context);
    if (!planningSettings) throw new AppError("service_unavailable", "Planning settings are unavailable", 503);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const input = planningRequest(parsePutPlanningSettingsInput, await jsonBody(context));
    return context.json(await planningSettings.putSettings(user.id, uuidParam(context, "tripId"), idempotencyKey(context), input));
  });

  app.get("/api/trips/:tripId/days/:dayId/planning-override", async (context) => {
    const { user } = await authenticated(context);
    if (!planningSettings) throw new AppError("service_unavailable", "Planning settings are unavailable", 503);
    context.header("Cache-Control", "private, no-store");
    return context.json(await planningSettings.getOverride(user.id, uuidParam(context, "tripId"), uuidParam(context, "dayId")));
  });

  app.put("/api/trips/:tripId/days/:dayId/planning-override", async (context) => {
    const { user } = await authenticated(context);
    if (!planningSettings) throw new AppError("service_unavailable", "Planning settings are unavailable", 503);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const input = planningRequest(parsePutPlanningOverrideInput, await jsonBody(context));
    return context.json(await planningSettings.putOverride(
      user.id, uuidParam(context, "tripId"), uuidParam(context, "dayId"), idempotencyKey(context), input,
    ));
  });

  app.delete("/api/trips/:tripId/days/:dayId/planning-override", async (context) => {
    const { user } = await authenticated(context);
    if (!planningSettings) throw new AppError("service_unavailable", "Planning settings are unavailable", 503);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const input = planningRequest(parseDeletePlanningOverrideInput, await jsonBody(context));
    return context.json(await planningSettings.deleteOverride(
      user.id, uuidParam(context, "tripId"), uuidParam(context, "dayId"), idempotencyKey(context), input,
    ));
  });

  app.get("/api/trips/:tripId/planning-load", async (context) => {
    const { user } = await authenticated(context);
    if (!planningSettings) throw new AppError("service_unavailable", "Planning settings are unavailable", 503);
    context.header("Cache-Control", "private, no-store");
    return context.json(await planningSettings.getLoad(user.id, uuidParam(context, "tripId")));
  });

  app.post("/api/trips/:tripId/planning-load", async (context) => {
    const { user } = await authenticated(context);
    if (!planningSettings) throw new AppError("service_unavailable", "Planning settings are unavailable", 503);
    const input = planningRequest(parsePlanningDrafts, await jsonBody(context));
    context.header("Cache-Control", "private, no-store");
    return context.json(await planningSettings.previewLoad(user.id, uuidParam(context, "tripId"), input));
  });

  app.post("/api/trips/:tripId/whole-trip-plan/preview", async (context) => {
    const { user } = await authenticated(context);
    if (!wholeTripPlans) throw new AppError("service_unavailable", "Whole-trip planning is unavailable", 503);
    const proposal = await wholeTripPlans.preview(
      user.id, uuidParam(context, "tripId"), await jsonBody(context),
      () => rateLimiter.consume("whole_trip_plan_preview", clientIp(context), user.id),
    );
    context.header("Cache-Control", "private, no-store");
    return context.json({ proposal }, 201);
  });

  app.get("/api/trips/:tripId/whole-trip-plan/proposals/:proposalId", async (context) => {
    const { user } = await authenticated(context);
    if (!wholeTripPlans) throw new AppError("service_unavailable", "Whole-trip planning is unavailable", 503);
    const proposal = await wholeTripPlans.getProposal(user.id, uuidParam(context, "tripId"), uuidParam(context, "proposalId"));
    context.header("Cache-Control", "private, no-store");
    return context.json({ proposal });
  });

  app.post("/api/trips/:tripId/whole-trip-plan/proposals/:proposalId/apply", async (context) => {
    const { user } = await authenticated(context);
    if (!wholeTripPlans) throw new AppError("service_unavailable", "Whole-trip planning is unavailable", 503);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    return context.json(await wholeTripPlans.apply(
      user.id, uuidParam(context, "tripId"), uuidParam(context, "proposalId"), idempotencyKey(context),
    ));
  });

  app.post(
    "/api/trips/:tripId/days/:dayId/route",
    async (context) => {
      const { user } = await authenticated(context);
      const body = await jsonBody(context);
      const route = await dayPlans.route(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "dayId"),
        {
          order: stringField(body, "order") as CreateDayRouteInput["order"],
          ...(body.orderedTripPlaceIds === undefined
            ? {}
            : { orderedTripPlaceIds: stringArrayField(body, "orderedTripPlaceIds") }),
        },
      );
      return context.json({ route });
    },
  );

  app.put("/api/trips/:tripId/days/:dayId/arrangement", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    return context.json({
      tripPlaces: await tripPlaces.arrangeDay(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "dayId"),
        idempotencyKey(context),
        {
          expectedVersion: numberField(body, "expectedVersion"),
          orderedTripPlaceIds: stringArrayField(body, "orderedTripPlaceIds"),
        },
      ),
    });
  });

  app.put("/api/trips/:tripId/days/:dayId/details", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    const day = await tripSkeleton.updateDayDetails(
      user.id,
      uuidParam(context, "tripId"),
      uuidParam(context, "dayId"),
      idempotencyKey(context),
      {
        expectedVersion: numberField(body, "expectedVersion"),
        title: nullableStringField(body, "title"),
        note: nullableStringField(body, "note"),
      },
    );
    return context.json({ day });
  });

  app.put("/api/trips/:tripId/days/:dayId/alternatives", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    const day = await tripSkeleton.updateDayAlternatives(
      user.id,
      uuidParam(context, "tripId"),
      uuidParam(context, "dayId"),
      idempotencyKey(context),
      {
        expectedVersion: numberField(body, "expectedVersion"),
        tripPlaceIds: stringArrayField(body, "tripPlaceIds"),
      },
    );
    return context.json({ day });
  });


  app.put(
    "/api/trips/:tripId/days/:dayId/place-order",
    async (context) => {
      const { user } = await authenticated(context);
      await rateLimiter.consume("trip_content", clientIp(context), user.id);
      const body = await jsonBody(context);
      const ordered = await dayPlans.applyOrder(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "dayId"),
        idempotencyKey(context),
        {
          expectedVersion: numberField(body, "expectedVersion"),
          orderedTripPlaceIds: arrayField(body, "orderedTripPlaceIds").map((value) =>
            typeof value === "string" ? value : "",
          ),
        },
      );
      return context.json(ordered);
    },
  );

  app.put(
    "/api/trips/:tripId/trip-places/:tripPlaceId/vote",
    async (context) => {
      const { user } = await authenticated(context);
      await rateLimiter.consume("trip_content", clientIp(context), user.id);
      const body = await jsonBody(context);
      const tripPlace = await tripPlaces.setOwnVote(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "tripPlaceId"),
        idempotencyKey(context),
        voteInput(body),
      );
      return context.json({ tripPlace });
    },
  );

  app.post(
    "/api/trips/:tripId/trip-places/:tripPlaceId/merge",
    async (context) => {
      const { user } = await authenticated(context);
      await rateLimiter.consume("trip_content", clientIp(context), user.id);
      const body = await jsonBody(context);
      const tripPlace = await tripPlaces.merge(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "tripPlaceId"),
        idempotencyKey(context),
        mergeInput(body),
      );
      return context.json({ tripPlace });
    },
  );

  app.post(
    "/api/trips/:tripId/trip-places/duplicates/:suggestionId/keep-separate",
    async (context) => {
      const { user } = await authenticated(context);
      await rateLimiter.consume("trip_content", clientIp(context), user.id);
      await tripPlaces.keepSeparate(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "suggestionId"),
        idempotencyKey(context),
      );
      return context.body(null, 204);
    },
  );

  app.post(
    "/api/trips/:tripId/trip-places/:tripPlaceId/remove",
    async (context) => {
      const { user } = await authenticated(context);
      await rateLimiter.consume("trip_content", clientIp(context), user.id);
      const body = await jsonBody(context);
      await tripPlaces.remove(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "tripPlaceId"),
        idempotencyKey(context),
        { expectedVersion: numberField(body, "expectedVersion") },
      );
      return context.body(null, 204);
    },
  );

  app.patch("/api/trips/:tripId/places/:placeId", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    const place = await tripSkeleton.updatePlace(
      user.id,
      uuidParam(context, "tripId"),
      uuidParam(context, "placeId"),
      idempotencyKey(context),
      {
        ...placeInput(body),
        expectedVersion: numberField(body, "expectedVersion"),
      } satisfies UpdatePlaceInput,
    );
    return context.json({ place });
  });

  app.delete("/api/trips/:tripId/places/:placeId", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    await tripSkeleton.deletePlace(
      user.id,
      uuidParam(context, "tripId"),
      uuidParam(context, "placeId"),
      idempotencyKey(context),
      numberField(body, "expectedVersion"),
    );
    return context.body(null, 204);
  });

  app.post("/api/trips/:tripId/flights", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    const item = await tripSkeleton.createFlight(user.id, uuidParam(context, "tripId"), idempotencyKey(context),
      numberField(body, "expectedTripVersion"), body as unknown as TripFlightInput);
    return context.json({ item }, 201);
  });

  app.patch("/api/trips/:tripId/flights/:itemId", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    const item = await tripSkeleton.updateFlight(user.id, uuidParam(context, "tripId"), uuidParam(context, "itemId"),
      idempotencyKey(context), numberField(body, "expectedVersion"), body as unknown as TripFlightInput);
    return context.json({ item });
  });

  app.post("/api/trips/:tripId/lodgings", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    const item = await tripSkeleton.createLodging(user.id, uuidParam(context, "tripId"), idempotencyKey(context),
      numberField(body, "expectedTripVersion"), body as unknown as TripLodgingInput);
    return context.json({ item }, 201);
  });

  app.patch("/api/trips/:tripId/lodgings/:itemId", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    const item = await tripSkeleton.updateLodging(user.id, uuidParam(context, "tripId"), uuidParam(context, "itemId"),
      idempotencyKey(context), numberField(body, "expectedVersion"), body as unknown as TripLodgingInput);
    return context.json({ item });
  });

  app.patch("/api/trips/:tripId/items/:itemId", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    const { constraints: _constraints, ...input } = itineraryItemInput(body);
    const item = await tripSkeleton.updateItem(
      user.id,
      uuidParam(context, "tripId"),
      uuidParam(context, "itemId"),
      idempotencyKey(context),
      {
        ...input,
        expectedVersion: numberField(body, "expectedVersion"),
      } satisfies UpdateItineraryItemInput,
    );
    return context.json({ item });
  });

  app.delete("/api/trips/:tripId/items/:itemId", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    await tripSkeleton.deleteItem(
      user.id,
      uuidParam(context, "tripId"),
      uuidParam(context, "itemId"),
      idempotencyKey(context),
      numberField(body, "expectedVersion"),
    );
    return context.body(null, 204);
  });

  app.post("/api/trips/:tripId/items/:itemId/lock", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    const item = await tripSkeleton.lockItem(
      user.id,
      uuidParam(context, "tripId"),
      uuidParam(context, "itemId"),
      idempotencyKey(context),
      numberField(body, "expectedVersion"),
    );
    return context.json({ item });
  });

  app.post("/api/trips/:tripId/items/:itemId/unlock", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    const item = await tripSkeleton.unlockItem(
      user.id,
      uuidParam(context, "tripId"),
      uuidParam(context, "itemId"),
      idempotencyKey(context),
      numberField(body, "expectedVersion"),
    );
    return context.json({ item });
  });

  app.post("/api/trips/:tripId/items/:itemId/constraints", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    const item = await tripSkeleton.createConstraint(
      user.id,
      uuidParam(context, "tripId"),
      uuidParam(context, "itemId"),
      idempotencyKey(context),
      numberField(body, "expectedItemVersion"),
      constraintInput(body),
    );
    return context.json({ item }, 201);
  });

  app.patch(
    "/api/trips/:tripId/items/:itemId/constraints/:constraintId",
    async (context) => {
      const { user } = await authenticated(context);
      await rateLimiter.consume("trip_content", clientIp(context), user.id);
      const body = await jsonBody(context);
      const item = await tripSkeleton.updateConstraint(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "itemId"),
        uuidParam(context, "constraintId"),
        idempotencyKey(context),
        numberField(body, "expectedItemVersion"),
        numberField(body, "expectedVersion"),
        constraintInput(body),
      );
      return context.json({ item });
    },
  );

  app.delete(
    "/api/trips/:tripId/items/:itemId/constraints/:constraintId",
    async (context) => {
      const { user } = await authenticated(context);
      await rateLimiter.consume("trip_content", clientIp(context), user.id);
      const body = await jsonBody(context);
      const item = await tripSkeleton.deleteConstraint(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "itemId"),
        uuidParam(context, "constraintId"),
        idempotencyKey(context),
        numberField(body, "expectedItemVersion"),
        numberField(body, "expectedVersion"),
      );
      return context.json({ item });
    },
  );

  app.post("/api/trips/:tripId/invites", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_invite", clientIp(context), user.id);
    const body = await jsonBody(context);
    const invite = await identityAccess.inviteMember(
      user.id,
      uuidParam(context, "tripId"),
      idempotencyKey(context),
      stringField(body, "email"),
    );
    return context.json({ invite }, 201);
  });

  app.post("/api/invites/accept", async (context) => {
    const { user } = await authenticated(context);
    const body = await jsonBody(context);
    const accepted = await identityAccess.acceptInvite(
      user.id,
      idempotencyKey(context),
      stringField(body, "token"),
    );
    const trip = await tripWorkspace.getTrip(user.id, accepted.tripId);
    return context.json({ trip });
  });

  app.delete("/api/trips/:tripId/invites/:inviteId", async (context) => {
    const { user } = await authenticated(context);
    await identityAccess.revokeInvite(
      user.id,
      uuidParam(context, "tripId"),
      uuidParam(context, "inviteId"),
      idempotencyKey(context),
    );
    return context.body(null, 204);
  });

  app.delete("/api/trips/:tripId/members/:memberUserId", async (context) => {
    const { user } = await authenticated(context);
    await identityAccess.removeMember(
      user.id,
      uuidParam(context, "tripId"),
      uuidParam(context, "memberUserId"),
      idempotencyKey(context),
    );
    return context.body(null, 204);
  });

  app.put("/api/trips/:tripId/editors-can-schedule", async (context) => {
    const { user } = await authenticated(context);
    const body = await jsonBody(context);
    if (typeof body.enabled !== "boolean") throw new AppError("validation_error", "enabled must be true or false");
    await identityAccess.setEditorsCanSchedule(user.id, uuidParam(context, "tripId"), idempotencyKey(context), body.enabled);
    return context.body(null, 204);
  });

  app.onError(async (error, context) => {
    if (error instanceof AppError) {
      if (error.retryAfterSeconds) {
        context.header("Retry-After", String(error.retryAfterSeconds));
      }
      let latestChange;
      if (error.code === "conflict" && error.currentVersion !== undefined && context.req.param("tripId")) {
        const user = await identityAccess.authenticate(getCookie(context, SESSION_COOKIE) ?? "");
        if (!user) return context.json({ error: { code: "unauthenticated", message: "Sign in to continue" } }, 401);
        const targetIds = ["constraintId", "itemId", "placeId", "tripPlaceId", "proposalId", "dayId"]
          .map((name) => context.req.param(name)).filter((id): id is string => Boolean(id));
        try {
          latestChange = await collaboration.latestChange(user.id, context.req.param("tripId")!, error.conflictTargetId ? [error.conflictTargetId] : targetIds.length ? targetIds : [context.req.param("tripId")!]);
        } catch (reason) {
          if (reason instanceof AppError) return context.json({ error: { code: reason.code, message: reason.message } }, reason.status);
          throw reason;
        }
      }
      return context.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.currentVersion === undefined
              ? {}
              : { currentVersion: error.currentVersion }),
            ...(latestChange === undefined ? {} : { latestChange }),
            ...(error.changedEntityIds === undefined ? {} : { changedEntityIds: error.changedEntityIds }),
          },
        },
        error.status,
      );
    }
    const correlationId = randomUUID();
    console.error(
      JSON.stringify({
        event: "request_failed",
        correlationId,
        errorClass: error instanceof Error ? error.constructor.name : "NonErrorThrow",
        result: "failed",
      }),
    );
    return context.json(
      {
        error: {
          code: "internal",
          message: "Something went wrong",
          correlationId,
        },
      },
      500,
    );
  });

  return app;
}
