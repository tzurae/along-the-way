import { describe, expect, it } from "vitest";

import { parseTripSkeletonResponse } from "../src/trip-skeleton";

describe("trip skeleton contract", () => {
  it("parses a trip-scoped place whose location metadata is incomplete", () => {
    const response = parseTripSkeletonResponse({
      skeleton: {
        tripVersion: 1,
        places: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            tripId: "22222222-2222-4222-8222-222222222222",
            name: "Manual meeting point",
            type: "other",
            address: "Near the station",
            latitude: null,
            longitude: null,
            timeZone: null,
            sourceUrl: null,
            notes: "Confirm the exact entrance",
            locationStatus: "coordinates_missing",
            version: 1,
          },
        ],
        items: [],
        days: [],
        tripInformationItemIds: [],
        events: [],
      },
    });

    expect(response.skeleton.places[0]).toMatchObject({
      name: "Manual meeting point",
      locationStatus: "coordinates_missing",
      timeZone: null,
      version: 1,
    });
  });

  it("parses every itinerary type with zoned endpoints and constraints", () => {
    const endpoint = {
      role: "start",
      countryStopId: "33333333-3333-4333-8333-333333333333",
      placeId: "11111111-1111-4111-8111-111111111111",
      localDateTime: "2026-10-21T10:00",
      timeZone: "Asia/Tokyo",
      utcOffset: "+09:00",
      instant: "2026-10-21T01:00:00.000Z",
    };
    const common = {
      tripId: "22222222-2222-4222-8222-222222222222",
      title: "Commitment",
      notes: null,
      sourceUrl: null,
      money: { amountMinor: 12500, currency: "JPY" },
      lockedAt: null,
      lockedBy: null,
      version: 1,
      endpoints: [endpoint],
      constraints: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          itemId: "55555555-5555-4555-8555-555555555555",
          type: "fixed_time",
          status: "confirmed",
          minimumBufferMinutes: null,
          version: 1,
        },
      ],
    };
    const typedItems = [
      {
        type: "flight",
        details: {
          carrier: "Japan Airlines",
          serviceNumber: "JL802",
          confirmationNotes: "Confirmed",
        },
      },
      {
        type: "lodging",
        details: { bookedBy: "Owner", confirmationCode: "HOTEL-1" },
      },
      {
        type: "transport",
        details: { mode: "train", ticketInfo: "Reserved seats" },
      },
      {
        type: "reservation",
        details: {
          durationMinutes: 90,
          bookedBy: "Owner",
          confirmationStatus: "confirmed",
        },
      },
      {
        type: "meal",
        details: {
          durationMinutes: 60,
          bookedBy: "Owner",
          confirmationStatus: "confirmed",
        },
      },
      {
        type: "activity",
        details: {
          durationMinutes: 120,
          bookedBy: null,
          confirmationStatus: "unknown",
        },
      },
      {
        type: "free-time",
        details: { durationMinutes: 45 },
      },
    ].map((item, index) => ({
      ...common,
      ...item,
      id: `55555555-5555-4555-8555-55555555555${index}`,
    }));

    const response = parseTripSkeletonResponse({
      skeleton: {
        tripVersion: 1,
        places: [],
        items: typedItems,
        days: [
          {
            id: "66666666-6666-4666-8666-666666666666",
            date: "2026-10-21",
            entries: [
              {
                itemId: typedItems[0]!.id,
                projection: "full",
                sortInstant: "2026-10-21T01:00:00.000Z",
              },
            ],
          },
        ],
        tripInformationItemIds: [typedItems[0]!.id, typedItems[1]!.id],
        events: [
          {
            id: "77777777-7777-4777-8777-777777777777",
            actorId: "88888888-8888-4888-8888-888888888888",
            eventType: "itinerary_item.locked",
            targetType: "itinerary_item",
            targetId: typedItems[0]!.id,
            summary: "Locked an itinerary item",
            createdAt: "2026-10-20T00:00:00.000Z",
          },
        ],
      },
    });

    expect(response.skeleton.items.map((item) => item.type)).toEqual([
      "flight",
      "lodging",
      "transport",
      "reservation",
      "meal",
      "activity",
      "free-time",
    ]);
    expect(response.skeleton.items[0]?.endpoints[0]).toEqual(endpoint);
    expect(response.skeleton.items[0]?.constraints[0]?.status).toBe("confirmed");
    expect(response.skeleton.days[0]?.entries[0]?.projection).toBe("full");
    expect(response.skeleton.events[0]?.eventType).toBe(
      "itinerary_item.locked",
    );
  });

  it("rejects malformed type-specific item data", () => {
    expect(() =>
      parseTripSkeletonResponse({
        skeleton: {
          tripVersion: 1,
          places: [],
          items: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              tripId: "22222222-2222-4222-8222-222222222222",
              type: "flight",
              title: "Flight",
              notes: null,
              sourceUrl: null,
              money: null,
              lockedAt: null,
              lockedBy: null,
              version: 1,
              endpoints: [],
              constraints: [],
              details: {
                carrier: "Japan Airlines",
                confirmationNotes: null,
              },
            },
          ],
          days: [],
          tripInformationItemIds: [],
          events: [],
        },
      }),
    ).toThrow("Invalid trip skeleton response");
  });
});
