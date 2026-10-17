import { describe, expect, it } from "vitest";

import {
  countryOptions,
  filterCountryOptions,
  inferCountryRoute,
} from "../src/countries";

import { parseTripHistoryResponse, parseTripResponse } from "../src/private-trips";

const tripResponse = {
  trip: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "大阪京都家庭旅行",
    startDate: "2026-10-21",
    endDate: "2026-10-27",
    defaultCurrency: null,
    countryStops: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        countryCode: "JP",
        position: 0,
        timeZone: "Asia/Tokyo",
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        countryCode: "KR",
        position: 1,
        timeZone: "Asia/Seoul",
      },
      {
        id: "66666666-6666-4666-8666-666666666666",
        countryCode: "JP",
        position: 2,
        timeZone: "Asia/Tokyo",
      },
    ],
    days: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        date: "2026-10-21",
        title: null,
      },
    ],
    members: [
      {
        id: "77777777-7777-4777-8777-777777777777",
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
    editorsCanSchedule: false,
  },
};

describe("private trip wire contract", () => {
  it("accepts the complete relational trip response", () => {
    expect(parseTripResponse(tripResponse)).toEqual(tripResponse);
  });

  it("accepts a hidden member email", () => {
    const response = {
      trip: {
        ...tripResponse.trip,
        members: [{ ...tripResponse.trip.members[0], email: null }],
      },
    };
    expect(parseTripResponse(response)).toEqual(response);
  });

  it("accepts a hidden former-member history actor", () => {
    expect(parseTripHistoryResponse({
      events: [{
        id: "88888888-8888-4888-8888-888888888888",
        actorId: "33333333-3333-4333-8333-333333333333",
        actorDisplayName: null,
        actorEmail: null,
        actorIsActiveMember: false,
        createdAt: "2026-10-17T00:00:00.000Z",
        eventType: "trip.updated",
        targetType: "trip",
        targetId: tripResponse.trip.id,
        targetName: null,
        summary: "Updated trip",
        reappliedFromVersion: null,
      }],
      nextCursor: null,
    }).events[0]).toMatchObject({
      actorEmail: null,
      actorIsActiveMember: false,
    });
  });

  it("rejects an account identity without a membership identity", () => {
    expect(() => parseTripResponse({
      trip: {
        ...tripResponse.trip,
        members: [{ ...tripResponse.trip.members[0], id: undefined }],
      },
    })).toThrow();
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

describe("country route metadata", () => {
  const options = countryOptions("zh-Hant");

  it.each(["日本", "Japan", "jp"])(
    "finds Japan using the %s label",
    (query) => {
      expect(filterCountryOptions(options, query).map((country) => country.code))
        .toContain("JP");
    },
  );

  it.each(["India", "IN", "in"])(
    "finds India using locale-independent %s folding",
    (query) => {
      expect(filterCountryOptions(options, query).map((country) => country.code))
        .toContain("IN");
    },
  );

  it("infers only unambiguous route metadata", () => {
    const japan = inferCountryRoute(["JP"]);
    expect(japan).not.toBeNull();
    expect(japan?.countries[0]?.timeZones).toEqual(["Asia/Tokyo"]);
    expect(japan?.defaultCurrency).toBe("JPY");
    expect(inferCountryRoute(["JP", "KR"])?.defaultCurrency).toBeNull();
  });
});
