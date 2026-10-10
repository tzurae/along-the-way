import { randomUUID } from "node:crypto";

import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type { PostgresCollaborationModule } from "./private-trips/postgres-collaboration-module";
import { conflictResolutionContext } from "./private-trips/postgres-private-trip-store";
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
  UpdateMemberVoteInput,
  UpdateTripPlaceDayAssignmentsInput,
  UpdateTripPlacePlanningInput,
} from "@along-the-way/contracts/trip-places";
import type { CreateDayTimetableInput } from "@along-the-way/contracts/day-plans";
import type { DiscoveryModule } from "./discovery/discovery-module";
import type { DayPlanModule } from "./planning/postgres-day-plan-module";

import {
  AppError,
  type AuthenticatedUser,
  type CreateTripInput,
  type IdentityAccessModule,
  type ReadinessProbe,
  type TripWorkspaceModule,
} from "./private-trips/private-trip-module";
import type { RateLimiter } from "./private-trips/postgres-rate-limiter";
import type { TripSkeletonModule } from "./trip-skeleton/trip-skeleton-module";
import type { TripPlaceModule } from "./trip-places/trip-place-module";
import {
  parsePlaceDetailDate,
  parsePlaceDetailReference,
  parsePlacePreviewIds,
} from "@along-the-way/contracts/place-details";
import type { PlaceDetailModule } from "./place-details/place-detail-module";

const SESSION_COOKIE = "along_the_way_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

interface AppDependencies {
  collaboration: PostgresCollaborationModule;
  dayPlans: DayPlanModule;
  discovery: DiscoveryModule;
  identityAccess: IdentityAccessModule;
  placeDetails: PlaceDetailModule;
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
  return {
    type: stringField(body, "type") as ItineraryItemType,
    title: stringField(body, "title"),
    participantMemberIds: body.participantMemberIds === null
      ? null
      : stringArrayField(body, "participantMemberIds"),
    notes: optionalStringField(body, "notes"),
    sourceUrl: optionalStringField(body, "sourceUrl"),
    money,
    endpoints: arrayField(body, "endpoints").map(endpointInput),
    details: details as unknown as ItineraryItemDetails,
    constraints:
      body.constraints === undefined
        ? undefined
        : arrayField(body, "constraints").map(constraintInput),
  };
}
function stringArrayField(body: Record<string, unknown>, name: string) {
  const values = arrayField(body, name);
  if (values.some((value) => typeof value !== "string")) {
    throw new AppError("validation_error", `${name} must be an array of strings`);
  }
  return values as string[];
}
function feedbackInterpretationField(body: Record<string, unknown>) {
  if (body.interpretation === undefined) return undefined;
  const interpretation = objectBody(body.interpretation);
  return {
    interests: stringArrayField(interpretation, "interests"),
    exclusions: stringArrayField(interpretation, "exclusions"),
    pace: nullableStringField(interpretation, "pace"),
    budget: nullableStringField(interpretation, "budget"),
    summary: stringField(interpretation, "summary"),
  };
}

function discoveryQuestionAnswersField(body: Record<string, unknown>) {
  return arrayField(body, "answers").map((value) => {
    const answer = objectBody(value);
    return {
      question: stringField(answer, "question"),
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
  return {
    expectedVersion: numberField(body, "expectedVersion"),
    durationMinutes: optionalNumberField(body, "durationMinutes"),
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
  return value;
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

export function createApp({
  collaboration,
  dayPlans,
  discovery,
  identityAccess,
  placeDetails,
  rateLimiter,
  readiness,
  siteAddress,
  tripPlaces,
  tripSkeleton,
  tripWorkspace,
}: AppDependencies) {
  const app = new Hono();
  const secureCookie = siteAddress.startsWith("https://");
  const expectedOrigin = new URL(siteAddress).origin;

  function refreshCookie(context: Context, token: string) {
    setCookie(context, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
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
    const inviteToken = body.inviteToken;
    if (inviteToken !== undefined && typeof inviteToken !== "string") {
      throw new AppError("validation_error", "inviteToken must be a string");
    }
    const email = stringField(body, "email");
    await rateLimiter.consume("magic_link", clientIp(context), email);
    await identityAccess.requestMagicLink(email, inviteToken);
    return context.json(
      {
        message:
          "If that email can sign in, a one-time link has been sent.",
      },
      202,
    );
  });

  app.post("/api/auth/magic-links/consume", async (context) => {
    const body = await jsonBody(context);
    const result = await identityAccess.consumeMagicLink(stringField(body, "token"));
    refreshCookie(context, result.sessionToken);
    return context.json({ user: result.user });
  });

  app.get("/api/session", async (context) => {
    const { user } = await authenticated(context);
    return context.json({ user });
  });

  app.post("/api/logout", async (context) => {
    const token = getCookie(context, SESSION_COOKIE) ?? "";
    await identityAccess.logout(token);
    deleteCookie(context, SESSION_COOKIE, {
      path: "/",
      secure: secureCookie,
      sameSite: "Lax",
    });
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
        await authorized();
        await stream.write(": connected\n\n");
        let heartbeatAt = Date.now();
        while (!stream.aborted && !context.req.raw.signal.aborted) {
          await authorized();
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
      }
    });
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
    context.header("Cache-Control", "private, no-store");
    return context.json({ detail: await placeDetails.getDetail(user.id, uuidParam(context, "tripId"), reference, date) });
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
    context.header("Cache-Control", "private, no-store");
    return context.json({ previews: await placeDetails.getPreviews(user.id, uuidParam(context, "tripId"), kind, ids) });
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
  app.put("/api/trips/:tripId/discovery/brief/questions", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    return context.json({
      discovery: await discovery.saveQuestionAnswers(
        user.id,
        uuidParam(context, "tripId"),
        idempotencyKey(context),
        {
          expectedVersion: numberField(body, "expectedVersion"),
          answers: discoveryQuestionAnswersField(body),
        },
      ),
    });
  });


  app.post("/api/trips/:tripId/discovery/generate", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    return context.json({
      discovery: await discovery.generate(
        user.id,
        uuidParam(context, "tripId"),
        idempotencyKey(context),
        { expectedBriefVersion: numberField(body, "expectedBriefVersion") },
      ),
    });
  });

  app.put("/api/trips/:tripId/discovery/proposals/:proposalId/vote", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    return context.json({
      discovery: await discovery.setProposalVote(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "proposalId"),
        idempotencyKey(context),
        voteInput(body),
      ),
    });
  });

  app.post("/api/trips/:tripId/discovery/proposals/:proposalId/accept", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    return context.json({
      discovery: await discovery.acceptProposal(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "proposalId"),
        idempotencyKey(context),
        { expectedVersion: numberField(body, "expectedVersion") },
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

  app.post("/api/trips/:tripId/discovery/feedback", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    if ("proposalId" in body) {
      throw new AppError("validation_error", "Feedback must apply to the whole trip");
    }
    return context.json({
      discovery: await discovery.createFeedback(
        user.id,
        uuidParam(context, "tripId"),
        idempotencyKey(context),
        {
          originalText: stringField(body, "originalText"),
        },
      ),
    });
  });

  app.post("/api/trips/:tripId/discovery/feedback/:feedbackId/decision", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    const decision = stringField(body, "decision");
    if (decision !== "confirm" && decision !== "reject") {
      throw new AppError("validation_error", "decision must be confirm or reject");
    }
    return context.json({
      discovery: await discovery.decideFeedback(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "feedbackId"),
        idempotencyKey(context),
        {
          expectedVersion: numberField(body, "expectedVersion"),
          decision,
          interpretation: feedbackInterpretationField(body),
        },
      ),
    });
  });

  app.post("/api/trips/:tripId/trip-places/search", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    return context.json(
      await tripPlaces.search(
        user.id,
        uuidParam(context, "tripId"),
        stringField(body, "query"),
      ),
    );
  });

  app.post("/api/trips/:tripId/trip-places/resolve-url", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    return context.json(
      await tripPlaces.resolveUrl(
        user.id,
        uuidParam(context, "tripId"),
        stringField(body, "url"),
      ),
    );
  });

  app.post("/api/trips/:tripId/trip-places", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    const tripPlace = await tripPlaces.add(
      user.id,
      uuidParam(context, "tripId"),
      idempotencyKey(context),
      tripPlaceInput(body),
    );
    return context.json({ tripPlace }, 201);
  });

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

  app.post(
    "/api/trips/:tripId/trip-plan",
    async (context) => {
      const { user } = await authenticated(context);
      await rateLimiter.consume("trip_content", clientIp(context), user.id);
      const plan = await dayPlans.tripPlan(user.id, uuidParam(context, "tripId"));
      return context.json({ plan });
    },
  );

  app.post(
    "/api/trips/:tripId/trip-plan/apply",
    async (context) => {
      const { user } = await authenticated(context);
      await rateLimiter.consume("trip_content", clientIp(context), user.id);
      const body = await jsonBody(context);
      const assigned = await tripPlaces.addPlacesToDays(
        user.id,
        uuidParam(context, "tripId"),
        idempotencyKey(context),
        {
          basis: stringField(body, "basis"),
          days: arrayField(body, "days").map((value) => {
            const day = objectBody(value);
            return {
              tripDayId: stringField(day, "tripDayId"),
              orderedTripPlaceIds: stringArrayField(day, "orderedTripPlaceIds"),
              expectedVersion: numberField(day, "expectedVersion"),
            };
          }),
        },
      );
      return context.json({ tripPlaces: assigned });
    },
  );

  app.post(
    "/api/trips/:tripId/days/:dayId/timetable",
    async (context) => {
      const { user } = await authenticated(context);
      await rateLimiter.consume("trip_content", clientIp(context), user.id);
      const body = await jsonBody(context);
      const timetable = await dayPlans.timetable(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "dayId"),
        { order: stringField(body, "order") as CreateDayTimetableInput["order"] },
      );
      return context.json({ timetable });
    },
  );

  app.get("/api/trips/:tripId/days/:dayId/window", async (context) => {
    const { user } = await authenticated(context);
    context.header("Cache-Control", "no-store");
    return context.json({ window: await dayPlans.getWindow(user.id, uuidParam(context, "tripId"), uuidParam(context, "dayId")) });
  });

  app.put(
    "/api/trips/:tripId/days/:dayId/window",
    async (context) => {
      const { user } = await authenticated(context);
      await rateLimiter.consume("trip_content", clientIp(context), user.id);
      const body = await jsonBody(context);
      const window = await dayPlans.updateWindow(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "dayId"),
        idempotencyKey(context),
        { startMinute: numberField(body, "startMinute"), endMinute: numberField(body, "endMinute"), expectedVersion: numberField(body, "expectedVersion") },
      );
      return context.json({ window });
    },
  );

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

  app.post("/api/trips/:tripId/places", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    const place = await tripSkeleton.createPlace(
      user.id,
      uuidParam(context, "tripId"),
      idempotencyKey(context),
      numberField(body, "expectedTripVersion"),
      placeInput(body),
    );
    return context.json({ place }, 201);
  });

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

  app.post("/api/trips/:tripId/items", async (context) => {
    const { user } = await authenticated(context);
    await rateLimiter.consume("trip_content", clientIp(context), user.id);
    const body = await jsonBody(context);
    const item = await tripSkeleton.createItem(
      user.id,
      uuidParam(context, "tripId"),
      idempotencyKey(context),
      numberField(body, "expectedTripVersion"),
      itineraryItemInput(body),
    );
    return context.json({ item }, 201);
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

  app.onError(async (error, context) => {
    if (error instanceof AppError) {
      if (error.retryAfterSeconds) {
        context.header("Retry-After", String(error.retryAfterSeconds));
      }
      let latestChange;
      if (error.code === "conflict" && error.currentVersion !== undefined && context.req.param("tripId")) {
        const user = await identityAccess.authenticate(getCookie(context, SESSION_COOKIE) ?? "");
        if (!user) return context.json({ error: { code: "unauthenticated", message: "Sign in to continue" } }, 401);
        const targetIds = ["constraintId", "itemId", "placeId", "tripPlaceId", "proposalId", "feedbackId", "dayId"]
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
