import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type {
  TripSummary,
  TripSummaryStore,
} from "../src/trips/trip-summary-store";

const sampleTrip: TripSummary = {
  slug: "hong-kong-together",
  title: "一起走的香港四日",
  destination: "香港",
  startDate: "2026-08-28",
  endDate: "2026-08-31",
  travelerCount: 2,
  dayCount: 4,
  nextDecision: "一起選定第二天晚餐",
  updatedAt: "2026-08-17T12:00:00.000Z",
};

function storeWith(
  overrides: Partial<TripSummaryStore> = {},
): TripSummaryStore {
  return {
    isReady: async () => true,
    findBySlug: async () => sampleTrip,
    ...overrides,
  };
}

describe("public API", () => {
  it("reports that the API process is alive without touching the database", async () => {
    const app = createApp({
      tripSummaries: storeWith({
        isReady: async () => {
          throw new Error("health must not depend on the database");
        },
      }),
    });

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("reports ready only when the database can answer", async () => {
    const readyApp = createApp({ tripSummaries: storeWith() });
    const unavailableApp = createApp({
      tripSummaries: storeWith({ isReady: async () => false }),
    });

    const ready = await readyApp.request("/ready");
    const unavailable = await unavailableApp.request("/ready");

    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({
      status: "ready",
      dependencies: { database: "available" },
    });
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({
      status: "not_ready",
      dependencies: { database: "unavailable" },
    });
  });

  it("treats a database error as not ready", async () => {
    const app = createApp({
      tripSummaries: storeWith({
        isReady: async () => {
          throw new Error("connection refused");
        },
      }),
    });

    const response = await app.request("/ready");

    expect(response.status).toBe(503);
  });

  it("returns a trip summary supplied by the persistence boundary", async () => {
    const app = createApp({ tripSummaries: storeWith() });

    const response = await app.request(
      "/api/trips/hong-kong-together/summary",
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ trip: sampleTrip });
  });

  it("returns not found for an unknown trip", async () => {
    const app = createApp({
      tripSummaries: storeWith({ findBySlug: async () => undefined }),
    });

    const response = await app.request("/api/trips/unknown/summary");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "trip_not_found", message: "Trip not found" },
    });
  });
});
