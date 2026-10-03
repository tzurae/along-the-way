import { describe, expect, it, vi } from "vitest";

import {
  DiscoveryModelResponseError,
  DiscoveryModelUnavailableError,
} from "../src/discovery/discovery-model";
import { OpenAiResponsesDiscoveryModel } from "../src/discovery/openai-responses-discovery-model";

function completed(value: unknown, extraOutput: unknown[] = []) {
  return new Response(JSON.stringify({
    status: "completed",
    model: "gpt-test-2026-01-01",
    output: [
      ...extraOutput,
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }],
      },
    ],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

const dateRange = { start: "2026-10-01", end: "2026-10-07" };
const facts = {
  name: "Kyoto week",
  startDate: dateRange.start,
  endDate: dateRange.end,
  timeZone: "Asia/Tokyo",
  currency: "JPY",
  countries: [{ code: "JP", position: 0 }],
};

const candidate = {
  provider: "google" as const,
  providerPlaceId: "place-1",
  name: "Nishiki Market",
  type: "activity" as const,
  address: "Nakagyo Ward, Kyoto",
  latitude: 35.005,
  longitude: 135.765,
  timeZone: "Asia/Tokyo",
  sourceUrl: "https://maps.google.com/?cid=1",
  attribution: "Google Maps",
  observedAt: "2026-09-28T12:00:00.000Z",
  expiresAt: "2026-10-28T12:00:00.000Z",
};

function model(fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return new OpenAiResponsesDiscoveryModel({
    apiKey: "test-key",
    model: "gpt-test",
    fetch,
    baseUrl: "https://openai.example.test/v1",
  });
}

describe("OpenAI Responses discovery model", () => {
  it("requests strict structured planning without web search", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => completed({
      structuredBrief: {
        interests: ["food markets", "gardens"],
        pace: "unhurried",
        budget: null,
        exclusions: ["long walking days"],
        areas: ["Kyoto"],
      },
      unresolvedQuestions: ["Which neighborhood is your base?"],
      searchPlan: {
        queries: ["Kyoto food markets"],
        areas: ["Kyoto"],
        categories: ["market"],
        exclusions: ["long walks"],
        dateRange,
      },
      outputLanguage: "zh-tw",
    }));

    const result = await model(fetch).plan({ trip: facts, brief: "Food and gardens", confirmedFeedback: [] });

    expect(result.modelId).toBe("gpt-test-2026-01-01");
    expect(result.searchPlan.queries).toEqual(["Kyoto food markets"]);
    expect(result.outputLanguage).toBe("zh-TW");
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://openai.example.test/v1/responses");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
    const body = JSON.parse(String(init?.body));
    expect(body.store).toBe(false);
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "trip_discovery_plan", strict: true });
    expect(body.tools).toBeUndefined();
  });

  it("rejects a plan whose output language is not a language tag", async () => {
    const plan = (outputLanguage: unknown) => model(vi.fn(async () => completed({
      structuredBrief: { interests: [], pace: null, budget: null, exclusions: [], areas: [] },
      unresolvedQuestions: [],
      searchPlan: { queries: ["Kyoto temples"], areas: [], categories: [], exclusions: [], dateRange },
      outputLanguage,
    }))).plan({ trip: facts, brief: "Temples", confirmedFeedback: [] });

    for (const invalid of ["Traditional Chinese", "", null]) {
      const failure = plan(invalid);
      await expect(failure).rejects.toBeInstanceOf(DiscoveryModelResponseError);
      await expect(failure).rejects.toThrow(/output language/);
    }
  });

  it("accepts only candidates and citations returned by the grounded search", async () => {
    const source = { url: "https://kyoto.example.test/nishiki", title: "Official Nishiki Market" };
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => completed({
      candidates: [{
        providerPlaceId: candidate.providerPlaceId,
        recommendation: "A compact food-market stop that matches the requested focus.",
        matchedNeeds: ["food markets"],
        tradeoffs: ["crowded at midday"],
        unknowns: ["holiday opening hours"],
        confidence: "medium",
        sourceUrls: [source.url],
      }],
    }, [{ type: "web_search_call", action: { sources: [source] } }]));

    const result = await model(fetch).synthesize({
      trip: facts,
      brief: { interests: ["food"], pace: null, budget: null, exclusions: [], areas: ["Kyoto"] },
      searchPlan: { queries: ["Kyoto food markets"], areas: ["Kyoto"], categories: ["market"], exclusions: [], dateRange },
      candidates: [candidate],
      rejectedProviderPlaceIds: [],
      confirmedFeedback: [],
      outputLanguage: "en",
    });

    expect(result.candidates[0]?.sourceUrls).toEqual([source.url]);
    expect(result.sources).toEqual([source]);
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.tools).toEqual([{ type: "web_search", search_context_size: "low" }]);
    expect(body.include).toEqual(["web_search_call.action.sources"]);
  });

  it("drops citations web search did not return but keeps the recommendation", async () => {
    const source = { url: "https://eikando.or.jp/lp/2026/index.html", title: "Eikando autumn" };
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => completed({
      candidates: [{
        providerPlaceId: candidate.providerPlaceId,
        recommendation: "Autumn temple visit",
        matchedNeeds: [],
        tradeoffs: [],
        unknowns: [],
        confidence: "high",
        sourceUrls: [
          "https://www.eikando.or.jp/lp/2026/index.html",
          "https://invented.example.test/fact",
          candidate.sourceUrl,
          source.url,
        ],
      }],
    }, [{ type: "web_search_call", action: { sources: [source] } }]));

    const result = await model(fetch).synthesize({
      trip: facts,
      brief: { interests: [], pace: null, budget: null, exclusions: [], areas: [] },
      searchPlan: { queries: ["Kyoto temples"], areas: [], categories: [], exclusions: [], dateRange },
      candidates: [candidate],
      rejectedProviderPlaceIds: [],
      confirmedFeedback: [],
      outputLanguage: "zh-TW",
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.recommendation).toBe("Autumn temple visit");
    expect(result.candidates[0]?.sourceUrls).toEqual([source.url]);
  });

  it("fails closed before making a request when no server credential is configured", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => completed({}));
    const unavailable = new OpenAiResponsesDiscoveryModel({ model: "gpt-test", fetch });
    await expect(unavailable.plan({ trip: facts, brief: "Food", confirmedFeedback: [] }))
      .rejects.toBeInstanceOf(DiscoveryModelUnavailableError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
