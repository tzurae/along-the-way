import { randomUUID } from "node:crypto";

import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import {
  AppError,
  type AuthenticatedUser,
  type CreateTripInput,
  type IdentityAccessModule,
  type ReadinessProbe,
  type TripWorkspaceModule,
} from "./private-trips/private-trip-module";
import type { RateLimiter } from "./private-trips/postgres-rate-limiter";

const SESSION_COOKIE = "along_the_way_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

interface AppDependencies {
  identityAccess: IdentityAccessModule;
  rateLimiter: RateLimiter;
  readiness: ReadinessProbe;
  siteAddress: string;
  tripWorkspace: TripWorkspaceModule;
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
  identityAccess,
  rateLimiter,
  readiness,
  siteAddress,
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
    const body = await jsonBody(context);
    const destinations = body.destinations;
    if (
      !Array.isArray(destinations) ||
      destinations.some((value) => typeof value !== "string")
    ) {
      throw new AppError(
        "validation_error",
        "destinations must be an array of strings",
      );
    }
    const input: CreateTripInput = {
      name: stringField(body, "name"),
      startDate: stringField(body, "startDate"),
      endDate: stringField(body, "endDate"),
      timeZone: stringField(body, "timeZone"),
      currency: stringField(body, "currency"),
      destinations,
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
    );
    return context.body(null, 204);
  });

  app.delete("/api/trips/:tripId/members/:memberUserId", async (context) => {
    const { user } = await authenticated(context);
    await identityAccess.removeMember(
      user.id,
      uuidParam(context, "tripId"),
      uuidParam(context, "memberUserId"),
    );
    return context.body(null, 204);
  });

  app.onError((error, context) => {
    if (error instanceof AppError) {
      if (error.retryAfterSeconds) {
        context.header("Retry-After", String(error.retryAfterSeconds));
      }
      return context.json(
        { error: { code: error.code, message: error.message } },
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
