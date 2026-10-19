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
    provider: "google", providerPlaceId, name, type: "activity", typeLabel: null, address: null, latitude: 35, longitude: 135,
    timeZone: null, sourceUrl: null, attribution: "Google Maps",
    observedAt: "2026-10-04T00:00:00.000Z", expiresAt: "2026-11-03T00:00:00.000Z", photo: null,
  };
  return { candidate, rating: 4.5, userRatingCount: 5_000, websiteUri: null, businessStatus: "operational", countryCode: "JP" };
}

function researched(overrides: Partial<ResearchedCandidate>): ResearchedCandidate {
  return {
    providerPlaceId: "ChIJ-boathouses", name: "伊根舟屋", localName: null, englishName: null, area: "伊根町", category: "Scenery", namedPlace: null,
    recommendationSentences: [{ text: "Boathouses over the bay.", sourceUrls: [] }],
    matchedNeeds: [], tradeoffSentences: [], unknowns: [], sources: [], ...overrides,
  };
}

const request: DiscoveryRequest = {
  namedPlaces: [], categories: ["Scenery"], defaultCategories: false, alreadyArranged: [], areas: [], exclusions: [],
  localLanguage: "ko", searchQueries: [],
};

const noSources: RecommendationSourceChecks = {
  wikivoyage: () => ({ verify: async () => ({ url: "https://en.wikivoyage.org/wiki/Ine", title: "Ine" }) }),
  pageText: async () => null,
};

/** Google details per Place ID and language; records every call as "language:id". */
function lookup(answers: (providerPlaceId: string, language: string | undefined) => RatedPlaceCandidate | null): RatedPlaceLookup & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    attribution: "Google Maps",
    async details(providerPlaceId, options) {
      calls.push(`${options?.languageCode}:${providerPlaceId}`);
      const answer = answers(providerPlaceId, options?.languageCode);
      if (!answer) throw new ProviderUnavailableError();
      return answer;
    },
  };
}

async function verify(candidates: ResearchedCandidate[], placeLookup: RatedPlaceLookup) {
  return verifyResearchedCandidates({
    candidates, request, outputLanguage: "zh-TW", placeLookup, sourceChecks: noSources,
    rejectedProviderPlaceIds: new Set(), wishlistProviderPlaceIds: new Set(), suggestedProviderPlaceIds: new Set(),
    tripCountryCodes: new Set(["JP"]),
  });
}

describe("picked place verification", () => {
  it("looks the picked Place ID up once in the traveler's language when the names agree", async () => {
    const placeLookup = lookup((id) => place("伊根舟屋", id));
    const result = await verify([researched({})], placeLookup);
    expect(placeLookup.calls).toEqual(["zh-TW:ChIJ-boathouses"]);
    expect(result.candidates[0]?.place).toMatchObject({ providerPlaceId: "ChIJ-boathouses", name: "伊根舟屋" });
  });

  it("accepts a place whose local-language name matches and keeps the traveler-language name Google gave", async () => {
    const placeLookup = lookup((id, language) => language === "ko" ? place("광장시장", id) : place("廣藏市場", id));
    const result = await verify([researched({ providerPlaceId: "ChIJ-gwangjang", name: "光藏市場", localName: "광장시장", area: "서울" })], placeLookup);
    expect(placeLookup.calls).toEqual(["zh-TW:ChIJ-gwangjang", "ko:ChIJ-gwangjang"]);
    expect(result.candidates[0]?.place).toMatchObject({ providerPlaceId: "ChIJ-gwangjang", name: "廣藏市場" });
  });

  it("reports a Place ID that is a different place than the model wrote about as a name mismatch", async () => {
    // The model wrote about 高雄 but picked the ID of a neighbouring result.
    const result = await verify([researched({ providerPlaceId: "ChIJ-hotel", name: "高雄", englishName: "Takao", area: "京都市" })],
      lookup((id) => place("Takao Kanko Hotel", id)));
    expect(result.candidates[0]?.place).toBeNull();
    expect(result.gate.shown).toEqual([]);
    expect(result.gate.shortfalls).toContainEqual(expect.objectContaining({ code: "name_mismatch", subject: "高雄" }));
  });

  it("identifies a closed place and lets the gate say why it is not shown", async () => {
    const result = await verify([researched({})], lookup((id) => ({ ...place("伊根舟屋", id), businessStatus: "closed_permanently" })));
    expect(result.candidates[0]?.place?.providerPlaceId).toBe("ChIJ-boathouses");
    expect(result.gate.shortfalls.map((entry) => entry.code)).toContain("permanently_closed");
  });

  it("treats a place Google cannot answer for as not found, and fails as unavailable only when every lookup failed", async () => {
    const partial = await verify(
      [researched({}), researched({ providerPlaceId: "ChIJ-gone", name: "Gone" })],
      lookup((id) => id === "ChIJ-gone" ? null : place("伊根舟屋", id)),
    );
    expect(partial.gate.shortfalls).toContainEqual(expect.objectContaining({ code: "not_found", subject: "Gone" }));
    await expect(verify([researched({})], lookup(() => null))).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("never spends more than the lookup budget", async () => {
    // Every name disagrees in both languages, so every place would want two lookups.
    const placeLookup = lookup((id) => place(`Other ${id}`, id));
    const candidates = Array.from({ length: 25 }, (_, index) => researched({ providerPlaceId: `ChIJ-place-${index}`, name: `Place ${index}` }));
    await verify(candidates, placeLookup);
    expect(placeLookup.calls.length).toBe(MAX_GOOGLE_LOOKUPS);
  });
});
