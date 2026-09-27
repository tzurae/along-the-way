import { Hono } from "hono";

import type { TripSummaryStore } from "./trips/trip-summary-store";

interface AppDependencies {
  tripSummaries: TripSummaryStore;
}

export function createApp({ tripSummaries }: AppDependencies) {
  const app = new Hono();

  app.get("/health", (context) => context.json({ status: "ok" }));

  app.get("/ready", async (context) => {
    try {
      if (await tripSummaries.isReady()) {
        return context.json({
          status: "ready",
          dependencies: { database: "available" },
        });
      }
    } catch {
      // Readiness intentionally turns dependency errors into a stable 503 contract.
    }

    return context.json(
      {
        status: "not_ready",
        dependencies: { database: "unavailable" },
      },
      503,
    );
  });

  app.get("/api/trips/:slug/summary", async (context) => {
    const trip = await tripSummaries.findBySlug(context.req.param("slug"));

    if (!trip) {
      return context.json(
        {
          error: {
            code: "trip_not_found",
            message: "Trip not found",
          },
        },
        404,
      );
    }

    return context.json({ trip });
  });

  return app;
}
