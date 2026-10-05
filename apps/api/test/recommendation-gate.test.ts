import { describe, expect, it } from "vitest";

import { gateRecommendations, type GateCandidate } from "../src/discovery/recommendation-gate";

function candidate(overrides: Partial<GateCandidate> & { id: string }): GateCandidate {
  return {
    displayName: overrides.id,
    category: "Temples",
    namedPlace: null,
    resolution: { status: "resolved", providerPlaceId: overrides.id, rating: 4.6, userRatingCount: 5_000 },
    wikivoyage: true,
    officialTourism: false,
    ...overrides,
  };
}

const base = {
  namedPlaces: [],
  categories: [],
  rejectedProviderPlaceIds: new Set<string>(),
  wishlistProviderPlaceIds: new Set<string>(),
};

describe("recommendation quality gate", () => {
  it("shows a place only when two independent kinds of source vouch for it", () => {
    const result = gateRecommendations({
      ...base,
      candidates: [
        candidate({ id: "two-sources" }),
        candidate({ id: "google-only", wikivoyage: false }),
        candidate({ id: "official-only", wikivoyage: false, officialTourism: true, resolution: { status: "resolved", providerPlaceId: "official-only", rating: null, userRatingCount: null } }),
      ],
    });
    expect(result.shown).toEqual([{ index: 0, members: [0], endorsements: ["google_reviews", "wikivoyage"] }]);
    expect(result.shortfalls).toEqual([
      { code: "single_source", subject: "google-only", named: false, endorsements: ["google_reviews"], count: null },
      { code: "single_source", subject: "official-only", named: false, endorsements: ["official_tourism"], count: null },
    ]);
  });

  it("counts Google reviews only with at least 200 reviews and a 4.0 rating", () => {
    const withGoogle = (id: string, rating: number, userRatingCount: number) =>
      candidate({ id, officialTourism: false, wikivoyage: true, resolution: { status: "resolved", providerPlaceId: id, rating, userRatingCount } });
    const result = gateRecommendations({
      ...base,
      candidates: [
        withGoogle("few-perfect-reviews", 4.9, 199),
        withGoogle("threshold", 4.0, 200),
        withGoogle("many-mediocre-reviews", 3.9, 9_000),
      ],
    });
    expect(result.shown.map(({ index }) => index)).toEqual([1]);
    expect(result.shortfalls.map((entry) => [entry.subject, entry.endorsements])).toEqual([
      ["few-perfect-reviews", ["wikivoyage"]],
      ["many-mediocre-reviews", ["wikivoyage"]],
    ]);
  });

  it("explains every traveler-named place that is not shown", () => {
    const result = gateRecommendations({
      ...base,
      namedPlaces: ["Saihoji", "Eianddo", "Ine"],
      candidates: [
        candidate({ id: "Ine Funaya", namedPlace: "Ine", wikivoyage: false }),
        candidate({ id: "Saihoji", namedPlace: "Saihoji", resolution: { status: "not_found" } }),
      ],
    });
    expect(result.shown).toEqual([]);
    expect(result.shortfalls).toEqual([
      { code: "not_researched", subject: "Eianddo", named: true, endorsements: [], count: null },
      { code: "single_source", subject: "Ine Funaya", named: true, endorsements: ["google_reviews"], count: null },
      { code: "not_found", subject: "Saihoji", named: true, endorsements: [], count: null },
    ]);
  });

  it("drops a place Google resolved to a different name", () => {
    const result = gateRecommendations({
      ...base,
      candidates: [candidate({ id: "Takao", resolution: { status: "name_mismatch" } })],
    });
    expect(result.shown).toEqual([]);
    expect(result.shortfalls).toEqual([
      { code: "name_mismatch", subject: "Takao", named: false, endorsements: [], count: null },
    ]);
  });

  it("lists named places first and shows a Google place once", () => {
    const result = gateRecommendations({
      ...base,
      namedPlaces: ["Tofukuji"],
      candidates: [
        candidate({ id: "Kinkakuji" }),
        candidate({ id: "Tofukuji", namedPlace: "Tofukuji" }),
        candidate({ id: "Kinkakuji again", resolution: { status: "resolved", providerPlaceId: "Kinkakuji", rating: 4.6, userRatingCount: 5_000 } }),
      ],
    });
    expect(result.shown.map(({ index }) => index)).toEqual([1, 0]);
    expect(result.shortfalls).toEqual([]);
  });

  it("never proposes a place already on the wishlist or rejected, and says why once per place", () => {
    const result = gateRecommendations({
      ...base,
      namedPlaces: ["Fushimi Inari"],
      rejectedProviderPlaceIds: new Set(["Ginkakuji", "Fushimi"]),
      wishlistProviderPlaceIds: new Set(["Fushimi"]),
      candidates: [
        candidate({ id: "Ginkakuji" }),
        candidate({ id: "Kinkakuji" }),
        // Named by the traveler and on the wishlist, also rejected once: the wishlist is the reason.
        candidate({ id: "Fushimi", displayName: "Fushimi Inari", namedPlace: "Fushimi Inari" }),
        candidate({ id: "Ginkakuji again", resolution: { status: "resolved", providerPlaceId: "Ginkakuji", rating: 4.6, userRatingCount: 5_000 } }),
      ],
    });
    expect(result.shown.map(({ index }) => index)).toEqual([1]);
    expect(result.shortfalls).toEqual([
      { code: "in_wishlist", subject: "Fushimi Inari", named: true, endorsements: [], count: null },
      { code: "rejected", subject: "Ginkakuji", named: false, endorsements: [], count: null },
    ]);
  });

  it("counts an already-decided place that passes the checks toward its kind, not as a failure", () => {
    const result = gateRecommendations({
      ...base,
      categories: ["Temples", "Gardens"],
      wishlistProviderPlaceIds: new Set(["Ginkakuji", "Weak garden"]),
      candidates: [
        candidate({ id: "Kinkakuji" }),
        candidate({ id: "Ginkakuji" }),
        // Only one source vouches for it: on the wishlist, but it does not cover Gardens.
        candidate({ id: "Weak garden", category: "Gardens", wikivoyage: false }),
      ],
    });
    expect(result.shown.map(({ index }) => index)).toEqual([0]);
    expect(result.shortfalls).toEqual([
      { code: "in_wishlist", subject: "Ginkakuji", named: false, endorsements: [], count: null },
      { code: "in_wishlist", subject: "Weak garden", named: false, endorsements: [], count: null },
      { code: "category_short", subject: "Gardens", named: false, endorsements: [], count: 0 },
    ]);
  });

  it("reports a kind of place with fewer than two shown places", () => {
    const result = gateRecommendations({
      ...base,
      categories: ["Temples", "Local food", "Seasonal"],
      candidates: [
        candidate({ id: "a" }),
        candidate({ id: "b" }),
        candidate({ id: "c", category: "Local food" }),
        candidate({ id: "d", category: "Local food", wikivoyage: false }),
      ],
    });
    expect(result.shortfalls.filter((entry) => entry.code === "category_short")).toEqual([
      { code: "category_short", subject: "Local food", named: false, endorsements: [], count: 1 },
      { code: "category_short", subject: "Seasonal", named: false, endorsements: [], count: 0 },
    ]);
  });

  it("adds up the sources of entries that turn out to be the same Google place", () => {
    const saihoji = { status: "resolved" as const, providerPlaceId: "ChIJ-saihoji", rating: 4.5, userRatingCount: 2_133 };
    const result = gateRecommendations({
      ...base,
      namedPlaces: ["Saihoji"],
      candidates: [
        candidate({ id: "Kokedera", resolution: saihoji, wikivoyage: true, officialTourism: true }),
        candidate({ id: "Saihoji", namedPlace: "Saihoji", resolution: saihoji, wikivoyage: false }),
      ],
    });
    // The traveler-named entry represents the place, with every source either entry verified.
    expect(result.shown).toEqual([{ index: 1, members: [1, 0], endorsements: ["google_reviews", "wikivoyage", "official_tourism"] }]);
    expect(result.shortfalls).toEqual([]);
  });

  it("does not count a traveler-named place of none of the requested kinds toward a kind", () => {
    const result = gateRecommendations({
      ...base,
      namedPlaces: ["Saihoji"],
      categories: ["Local food"],
      candidates: [
        candidate({ id: "Saihoji", namedPlace: "Saihoji", category: null }),
        candidate({ id: "Nishiki", category: "Local food" }),
      ],
    });
    expect(result.shown.map(({ index }) => index)).toEqual([0, 1]);
    expect(result.shortfalls).toEqual([
      { code: "category_short", subject: "Local food", named: false, endorsements: [], count: 1 },
    ]);
  });

  it("counts a merged place under the kind any of its entries was researched for", () => {
    const saihoji = { status: "resolved" as const, providerPlaceId: "ChIJ-saihoji", rating: 4.5, userRatingCount: 2_133 };
    const result = gateRecommendations({
      ...base,
      namedPlaces: ["Saihoji"],
      categories: ["Seasonal"],
      candidates: [
        candidate({ id: "Saihoji", namedPlace: "Saihoji", category: null, resolution: saihoji }),
        candidate({ id: "Kokedera", category: "Seasonal", resolution: saihoji }),
        candidate({ id: "Eikando", category: "Seasonal" }),
      ],
    });
    expect(result.shown.map(({ index }) => index)).toEqual([0, 2]);
    expect(result.shortfalls).toEqual([]);
  });
});
