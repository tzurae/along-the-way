import { describe, expect, it } from "vitest";

import { parseTripPlaceListResponse } from "../src/trip-places";

function response(assignedDayId: string | null) {
  return {
    tripPlaces: [{
      id: "place-1",
      tripId: "trip-1",
      placeId: "identity-1",
      provider: "manual",
      aiProposalId: null,
      providerPlaceId: null,
      providerObservedAt: null,
      providerExpiresAt: null,
      providerAttribution: null,
      factsSource: "member",
      providerFactsExpired: false,
      name: "East Gate",
      type: "activity",
      address: null,
      latitude: null,
      longitude: null,
      timeZone: null,
      status: "needs-location",
      scheduled: false,
      durationMinutes: 60,
      assignedDayId,
      dayPosition: assignedDayId === null ? null : 0,
      budgetAmountMinor: 1200,
      budgetCurrency: "JPY",
      notes: null,
      preferenceConflict: false,
      contributions: [],
      preferences: [],
      duplicateSuggestions: [],
      version: 2,
    }],
  };
}

describe("trip place day assignment contract", () => {
  it("preserves one explicit planned day", () => {
    expect(parseTripPlaceListResponse(response("day-2")).tripPlaces[0]?.assignedDayId)
      .toBe("day-2");
  });

  it("rejects the removed preferred and excluded day shape", () => {
    const legacy = response(null);
    delete (legacy.tripPlaces[0] as Record<string, unknown>).assignedDayId;
    Object.assign(legacy.tripPlaces[0]!, {
      desiredDayIds: ["day-2"],
      excludedDayIds: [],
    });
    expect(() => parseTripPlaceListResponse(legacy)).toThrow("Invalid trip place response");
  });
});
