import { randomUUID } from "node:crypto";

import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
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
} from "@along-the-way/contracts/trip-skeleton";
import type {
  CreateTripPlaceInput,
  MergeTripPlacesInput,
  PreferenceLevel,
  UpdateMemberPreferenceInput,
  UpdateTripPlaceDayAssignmentsInput,
  UpdateTripPlacePlanningInput,
} from "@along-the-way/contracts/trip-places";
import type { DiscoveryModule } from "./discovery/discovery-module";

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

const SESSION_COOKIE = "along_the_way_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

interface AppDependencies {
  discovery: DiscoveryModule;
  identityAccess: IdentityAccessModule;
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
    countryStopId: stringField(endpoint, "countryStopId"),
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

function preferenceInput(
  body: Record<string, unknown>,
): UpdateMemberPreferenceInput {
  return {
    level: stringField(body, "level") as PreferenceLevel,
    expectedVersion: optionalNumberField(body, "expectedVersion"),
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
  discovery,
  identityAccess,
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
      const origin = context.req.header("Origin");
      if (origin !== expectedOrigin) {
        throw new AppError("forbidden", "Same-origin mutation required", 403);
      }
    }
    await next();
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
    return context.json({
      discovery: await discovery.createFeedback(
        user.id,
        uuidParam(context, "tripId"),
        idempotencyKey(context),
        {
          originalText: stringField(body, "originalText"),
          proposalId: optionalStringField(body, "proposalId"),
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

  app.put(
    "/api/trips/:tripId/trip-places/:tripPlaceId/preference",
    async (context) => {
      const { user } = await authenticated(context);
      await rateLimiter.consume("trip_content", clientIp(context), user.id);
      const body = await jsonBody(context);
      const tripPlace = await tripPlaces.setOwnPreference(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "tripPlaceId"),
        idempotencyKey(context),
        preferenceInput(body),
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
    "/api/trips/:tripId/trip-places/:tripPlaceId/contributions/:contributionId/withdraw",
    async (context) => {
      const { user } = await authenticated(context);
      await rateLimiter.consume("trip_content", clientIp(context), user.id);
      const tripPlace = await tripPlaces.withdrawContribution(
        user.id,
        uuidParam(context, "tripId"),
        uuidParam(context, "tripPlaceId"),
        uuidParam(context, "contributionId"),
        idempotencyKey(context),
      );
      return context.json({ tripPlace });
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

  app.onError((error, context) => {
    if (error instanceof AppError) {
      if (error.retryAfterSeconds) {
        context.header("Retry-After", String(error.retryAfterSeconds));
      }
      return context.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.currentVersion === undefined
              ? {}
              : { currentVersion: error.currentVersion }),
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
        method: context.req.method,
        path: new URL(context.req.url).pathname,
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
