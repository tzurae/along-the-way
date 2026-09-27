import { describe, expect, it } from "vitest";

import { parseTripSummaryResponse } from "../src/trip-summary";

describe("trip summary wire contract", () => {
  it("accepts the complete API response", () => {
    const response = {
      trip: {
        slug: "hong-kong-together",
        title: "一起走的香港四日",
        destination: "香港",
        startDate: "2026-08-28",
        endDate: "2026-08-31",
        travelerCount: 2,
        dayCount: 4,
        nextDecision: "一起選定第二天晚餐",
        updatedAt: "2026-08-17T12:00:00.000Z",
      },
    };

    expect(parseTripSummaryResponse(response)).toEqual(response);
  });

  it("rejects a response whose field types drift", () => {
    expect(() =>
      parseTripSummaryResponse({
        trip: {
          slug: "hong-kong-together",
          travelerCount: "two",
        },
      }),
    ).toThrow("Invalid trip summary response");
  });

  it("rejects timestamps where the wire contract requires a date-only value", () => {
    expect(() =>
      parseTripSummaryResponse({
        trip: {
          slug: "hong-kong-together",
          title: "一起走的香港四日",
          destination: "香港",
          startDate: "2026-08-28T00:00:00.000Z",
          endDate: "2026-08-31",
          travelerCount: 2,
          dayCount: 4,
          nextDecision: null,
          updatedAt: "2026-08-17T12:00:00.000Z",
        },
      }),
    ).toThrow("Invalid trip summary response");
  });
});
