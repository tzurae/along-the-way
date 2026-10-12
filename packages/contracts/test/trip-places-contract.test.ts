import { describe, expect, it } from "vitest";

import { parseProviderCandidatesResponse, parseTripPlaceListResponse } from "../src/trip-places";

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
      selectedForItinerary: assignedDayId !== null,
      unplacedFromDate: null,
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

describe("provider candidate contract", () => {
  it("requires nullable photo and wishlist state on search results", () => {
    const candidate = {
      provider: "google",
      providerPlaceId: "ChIJ-provider-place-1234",
      name: "東福寺",
      type: "activity",
      typeLabel: "佛寺",
      address: "京都市東山区",
      latitude: 34.976,
      longitude: 135.774,
      timeZone: "Asia/Tokyo",
      sourceUrl: "https://maps.google.com/?cid=123",
      attribution: "Google Maps",
      observedAt: "2026-10-12T00:00:00.000Z",
      expiresAt: "2026-11-11T00:00:00.000Z",
      photo: null,
      alreadyInWishlist: true,
    };
    expect(parseProviderCandidatesResponse({ candidates: [candidate], attribution: "Google Maps" }).candidates[0])
      .toMatchObject({ providerPlaceId: candidate.providerPlaceId, typeLabel: "佛寺", photo: null, alreadyInWishlist: true });
    expect(parseProviderCandidatesResponse({
      candidates: [{ ...candidate, typeLabel: null }],
      attribution: "Google Maps",
    }).candidates[0]?.typeLabel).toBeNull();
    expect(() => parseProviderCandidatesResponse({
      candidates: [{ ...candidate, alreadyInWishlist: undefined }],
      attribution: "Google Maps",
    })).toThrow("Invalid trip place response");
    expect(() => parseProviderCandidatesResponse({
      candidates: [{ ...candidate, photo: undefined }],
      attribution: "Google Maps",
    })).toThrow();
  });
});

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
