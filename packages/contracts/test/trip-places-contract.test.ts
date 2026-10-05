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
      sourceUrl: null,
      voters: [{ memberUserId: "member-1", memberEmail: "one@example.test", memberDisplayName: null }],
      voteCount: 1,
      ownVote: true,
      votingAvailable: true,
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

  it("preserves active voters and rejects non-boolean own votes", () => {
    const input = response(null);
    const place = parseTripPlaceListResponse(input).tripPlaces[0]!;
    expect(place.voters).toEqual([{ memberUserId: "member-1", memberEmail: "one@example.test", memberDisplayName: null }]);
    expect(place.voteCount).toBe(1);
    expect(place.ownVote).toBe(true);
    expect(() => parseTripPlaceListResponse({
      tripPlaces: [{ ...input.tripPlaces[0], ownVote: "true" }],
    })).toThrow("Invalid trip place response");
  });

  it("reads old wishlist replies without exposing internal contributions", () => {
    const legacy = response(null);
    const place = legacy.tripPlaces[0] as Record<string, unknown>;
    delete place.sourceUrl;
    place.contributions = [
      { sourceUrl: "https://example.test/first", createdAt: "2026-01-01T00:00:00Z" },
      { sourceUrl: "https://example.test/second", createdAt: "2026-01-02T00:00:00Z" },
    ];
    const parsed = parseTripPlaceListResponse(legacy).tripPlaces[0]!;
    expect(parsed.sourceUrl).toBe("https://example.test/first");
    expect(parsed).not.toHaveProperty("contributions");
    delete place.contributions;
    expect(parseTripPlaceListResponse(legacy).tripPlaces[0]?.sourceUrl).toBeNull();
    place.sourceUrl = "https://example.test/current";
    expect(parseTripPlaceListResponse(legacy).tripPlaces[0]?.sourceUrl).toBe("https://example.test/current");
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
