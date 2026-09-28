import { describe, expect, it } from "vitest";

import { parseTripResponse } from "../src/private-trips";

const tripResponse = {
  trip: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "大阪京都家庭旅行",
    startDate: "2026-10-21",
    endDate: "2026-10-27",
    timeZone: "Asia/Tokyo",
    currency: "JPY",
    destinations: ["大阪", "京都"],
    days: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        date: "2026-10-21",
        title: null,
      },
    ],
    members: [
      {
        userId: "33333333-3333-4333-8333-333333333333",
        email: "owner@example.test",
        displayName: null,
        role: "owner",
      },
    ],
    invites: [],
    memberCount: 1,
    dayCount: 1,
    role: "owner",
    version: 1,
  },
};

describe("private trip wire contract", () => {
  it("accepts the complete relational trip response", () => {
    expect(parseTripResponse(tripResponse)).toEqual(tripResponse);
  });

  it("rejects drift in authorization and derived-count fields", () => {
    expect(() =>
      parseTripResponse({
        trip: {
          ...tripResponse.trip,
          role: "admin",
          memberCount: "one",
        },
      }),
    ).toThrow("Invalid API response");
  });
});
