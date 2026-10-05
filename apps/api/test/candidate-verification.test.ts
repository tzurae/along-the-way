import { describe, expect, it } from "vitest";
import type { ProviderPlaceCandidateDto } from "@along-the-way/contracts/trip-places";
import { MAX_GOOGLE_LOOKUPS, verifyResearchedCandidates, type RecommendationSourceChecks } from "../src/discovery/candidate-verification";
import type { DiscoveryRequest, ResearchedCandidate } from "../src/discovery/discovery-model";
import {
  ProviderUnavailableError,
  type RatedPlaceCandidate,
  type RatedPlaceLookup,
} from "../src/trip-places/google-places-provider";

function place(name: string, providerPlaceId: string): RatedPlaceCandidate {
  const candidate: ProviderPlaceCandidateDto = {
    provider: "google", providerPlaceId, name, type: "activity", address: null, latitude: 35, longitude: 135,
    timeZone: null, sourceUrl: null, attribution: "Google Maps",
    observedAt: "2026-10-04T00:00:00.000Z", expiresAt: "2026-11-03T00:00:00.000Z",
  };
  return { candidate, rating: 4.5, userRatingCount: 5_000, websiteUri: null, businessStatus: "operational", countryCode: "JP" };
}

function researched(overrides: Partial<ResearchedCandidate>): ResearchedCandidate {
  return {
    name: "伊根舟屋", localName: null, englishName: null, area: "伊根町", category: "Scenery", namedPlace: null,
    recommendation: "Boathouses over the bay.", matchedNeeds: [], tradeoffs: [], unknowns: [], confidence: "high",
    sources: [], ...overrides,
  };
}

const request: DiscoveryRequest = {
  namedPlaces: [], categories: ["Scenery"], defaultCategories: false, alreadyArranged: [], areas: [], exclusions: [],
  localLanguage: "ko",
};

const noSources: RecommendationSourceChecks = {
  wikivoyage: () => ({ verify: async () => ({ url: "https://en.wikivoyage.org/wiki/Ine", title: "Ine" }) }),
  pageText: async () => null,
};

function lookup(answers: (query: string, language: string | undefined) => RatedPlaceCandidate[]): RatedPlaceLookup & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    attribution: "Google Maps",
    async lookup(query, options) {
      queries.push(`${options?.languageCode}:${query}`);
      return answers(query, options?.languageCode);
    },
  };
}

async function verify(candidates: ResearchedCandidate[], placeLookup: RatedPlaceLookup) {
  return verifyResearchedCandidates({
    candidates, request, outputLanguage: "zh-TW", placeLookup, sourceChecks: noSources,
    rejectedProviderPlaceIds: new Set(), wishlistProviderPlaceIds: new Set(), tripCountryCodes: new Set(["JP"]),
  });
}

describe("researched candidate verification", () => {
  it("prefers an exact Google name anywhere in the answer over a close one listed first", async () => {
    const result = await verify([researched({})], lookup(() => [
      place("伊根舟屋群", "ChIJ-boathouse-cluster"),
      place("伊根舟屋", "ChIJ-boathouses"),
    ]));
    expect(result.candidates[0]?.place?.providerPlaceId).toBe("ChIJ-boathouses");
  });

  it("among equal name matches, takes a listing that could be visited over a closed or foreign one", async () => {
    // The old listing of a business that moved, listed first.
    const moved = await verify([researched({})], lookup(() => [
      { ...place("伊根舟屋", "ChIJ-old-boathouses"), businessStatus: "closed_permanently" },
      place("伊根舟屋", "ChIJ-boathouses"),
    ]));
    expect(moved.candidates[0]?.place?.providerPlaceId).toBe("ChIJ-boathouses");
    expect(moved.gate.shortfalls.filter((entry) => entry.code === "permanently_closed")).toEqual([]);
    // A same-name place abroad, listed first.
    const abroad = await verify([researched({})], lookup(() => [
      { ...place("伊根舟屋", "ChIJ-abroad"), countryCode: "KR" },
      place("伊根舟屋", "ChIJ-boathouses"),
    ]));
    expect(abroad.candidates[0]?.place?.providerPlaceId).toBe("ChIJ-boathouses");
    // With only the closed listing, it is still identified, and the gate says why it is not shown.
    const closedOnly = await verify([researched({})], lookup(() => [
      { ...place("伊根舟屋", "ChIJ-old-boathouses"), businessStatus: "closed_permanently" },
    ]));
    expect(closedOnly.gate.shortfalls.map((entry) => entry.code)).toContain("permanently_closed");
  });

  it("finds a place by its local name and keeps the traveler-language name Google first gave", async () => {
    const placeLookup = lookup((_query, language) => language === "ko"
      ? [place("광장시장", "ChIJ-gwangjang")]
      : [place("廣藏市場", "ChIJ-gwangjang")]);
    const result = await verify([researched({ name: "光藏市場", localName: "광장시장", area: "서울" })], placeLookup);
    expect(placeLookup.queries).toEqual(["zh-TW:서울 光藏市場", "ko:서울 광장시장"]);
    expect(result.candidates[0]?.place).toMatchObject({ providerPlaceId: "ChIJ-gwangjang", name: "廣藏市場" });
  });

  it("reports a different place Google returns as a name mismatch, not as the researched place", async () => {
    const result = await verify([researched({ name: "高雄", englishName: "Takao", area: "京都市" })], lookup(() => [
      place("Takao Kanko Hotel", "ChIJ-hotel"),
    ]));
    expect(result.candidates[0]?.place).toBeNull();
    expect(result.gate.shortfalls).toContainEqual(expect.objectContaining({ code: "name_mismatch", subject: "高雄" }));
  });

  it("still asks in the local language when the model wrote the local name as the name", async () => {
    const placeLookup = lookup((_query, language) => language === "ko"
      ? [place("경복궁", "ChIJ-gyeongbokgung")]
      : [place("景福宮", "ChIJ-gyeongbokgung")]);
    const result = await verify([researched({ name: "경복궁", localName: "경복궁", area: "서울" })], placeLookup);
    expect(placeLookup.queries).toEqual(["zh-TW:서울 경복궁", "ko:서울 경복궁"]);
    expect(result.candidates[0]?.place).toMatchObject({ providerPlaceId: "ChIJ-gyeongbokgung", name: "景福宮" });
  });

  it("fails as unavailable only when every Google lookup failed", async () => {
    const down: RatedPlaceLookup = { attribution: "Google Maps", lookup: async () => { throw new ProviderUnavailableError(); } };
    await expect(verify([researched({})], down)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("never spends more than the lookup budget, and spends retries on traveler-named places first", async () => {
    // Every first lookup misses, so every place would want two more lookups.
    const placeLookup = lookup((query, language) => language === "ko" && query.endsWith("西芳寺 local")
      ? [place("西芳寺 local", "ChIJ-saihoji")]
      : []);
    const candidates = Array.from({ length: 15 }, (_, index) => researched({
      name: `Place ${index}`, localName: `Place ${index} local`, englishName: `Place ${index} en`,
    }));
    candidates.push(researched({ name: "西芳寺", localName: "西芳寺 local", englishName: "Saihoji", namedPlace: "Saihoji" }));

    const result = await verifyResearchedCandidates({
      candidates, request: { ...request, namedPlaces: [{ name: "Saihoji", area: "京都市" }] }, outputLanguage: "zh-TW",
      placeLookup, sourceChecks: noSources, rejectedProviderPlaceIds: new Set(), wishlistProviderPlaceIds: new Set(),
      tripCountryCodes: new Set(["JP"]),
    });

    expect(placeLookup.queries.length).toBe(MAX_GOOGLE_LOOKUPS);
    expect(result.candidates.at(-1)?.place?.providerPlaceId).toBe("ChIJ-saihoji");
  });
});
