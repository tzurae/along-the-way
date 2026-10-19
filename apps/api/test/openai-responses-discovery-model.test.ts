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

const request = {
  namedPlaces: [{ name: "Saihoji", area: "Kyoto" }],
  categories: ["Temples", "Local food"],
  defaultCategories: false,
  alreadyArranged: ["Staying at an airport hotel"],
  areas: ["Kyoto"],
  exclusions: [],
  localLanguage: "ja",
  searchQueries: [],
};

const brief = { interests: ["temples"], pace: null, budget: null, exclusions: [], areas: ["Kyoto"] };

const discovered = [{
  query: "京都 寺", area: "Kyoto", category: "Temples", namedPlace: null,
  summary: "Tofuku-ji [0], Saiho-ji [1], Nishiki Market [2], Kinkaku-ji [3], Ginkaku-ji [4], Arashiyama [5]",
  placeIds: ["ChIJ-tofukuji", "ChIJ-saihoji", "ChIJ-nishiki", "ChIJ-kinkakuji", "ChIJ-ginkakuji", "ChIJ-arashiyama"],
}];

function researched(overrides: Record<string, unknown>) {
  return {
    placeId: "ChIJ-tofukuji",
    name: "Tofuku-ji",
    localName: "東福寺",
    englishName: "Tofuku-ji",
    area: "京都市",
    category: "Temples",
    namedPlace: null,
    recommendation: [{ text: "Autumn leaves from Tsutenkyo bridge.", sourceUrls: [] }],
    matchedNeeds: ["temples"],
    tradeoffs: [],
    unknowns: [],
    sources: [],
    ...overrides,
  };
}

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
        interests: ["temples", "local food"],
        pace: null,
        budget: null,
        exclusions: [],
        areas: ["Kyoto"],
      },
      unresolvedQuestions: [],
      request: { ...request, namedPlaces: [...request.namedPlaces, { name: "Saihoji", area: "Kyoto" }], localLanguage: "JA" },
      outputLanguage: "zh-tw",
    }));

    const questionAnswers = [
      { question: "Indoor or outdoor markets?", answer: "Indoor" },
      { question: "How much walking?", answer: null },
    ];
    const result = await model(fetch).plan({
      trip: facts,
      brief: "Temples and food; we stay at an airport hotel",
      questionAnswers,
    });

    expect(result.modelId).toBe("gpt-test-2026-01-01");
    expect(result.outputLanguage).toBe("zh-TW");
    expect(result.request).toEqual({
      ...request,
      localLanguage: "ja",
      // The model listed no searches: every named place and area × kind still gets one.
      searchQueries: [
        { query: "Kyoto Saihoji", area: "Kyoto", category: null, namedPlace: "Saihoji" },
        { query: "Kyoto Temples", area: "Kyoto", category: "Temples", namedPlace: null },
        { query: "Kyoto Local food", area: "Kyoto", category: "Local food", namedPlace: null },
      ],
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://openai.example.test/v1/responses");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
    const body = JSON.parse(String(init?.body));
    expect(body.store).toBe(false);
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "trip_discovery_plan", strict: true });
    expect(body.tools).toBeUndefined();
    expect(JSON.parse(body.input[1].content)).toMatchObject({ questionAnswers });
  });

  it("uses default kinds of place when the model returns none", async () => {
    const result = await model(vi.fn(async () => completed({
      structuredBrief: { interests: [], pace: null, budget: null, exclusions: [], areas: [] },
      unresolvedQuestions: [],
      request: { ...request, namedPlaces: [], categories: [], defaultCategories: false },
      outputLanguage: "en",
    }))).plan({ trip: facts, brief: "Just recommend", questionAnswers: [] });

    expect(result.request.categories).toHaveLength(3);
    expect(result.request.defaultCategories).toBe(true);
  });

  it("rejects a plan whose output language is not a language tag", async () => {
    const plan = (outputLanguage: unknown) => model(vi.fn(async () => completed({
      structuredBrief: { interests: [], pace: null, budget: null, exclusions: [], areas: [] },
      unresolvedQuestions: [],
      request,
      outputLanguage,
    }))).plan({ trip: facts, brief: "Temples", questionAnswers: [] });

    for (const invalid of ["Traditional Chinese", "", null]) {
      const failure = plan(invalid);
      await expect(failure).rejects.toBeInstanceOf(DiscoveryModelResponseError);
      await expect(failure).rejects.toThrow(/output language/);
    }
  });

  it("keeps only this search's citations, strips markdown, and leaves uncited sentences as inference", async () => {
    const official = { url: "https://kyoto.travel/en/tofukuji.html", title: "Tofuku-ji | Kyoto City Official Travel Guide" };
    const invented = "https://invented.example.test/tofukuji";
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => completed({
      candidates: [researched({
        recommendation: [
          {
            text: `Autumn leaves are visible from Tsutenkyo bridge ([kyoto.travel](${official.url}?utm_source=openai)). [1] citeturn0search0`,
            sourceUrls: [official.url, invented],
          },
          { text: "The pacing should feel calm.", sourceUrls: [] },
          { text: "citeturn0search0", sourceUrls: [official.url] },
        ],
        tradeoffs: [
          {
            text: `[Crowds](${invented}) can build around noon. 【2†source】`,
            sourceUrls: [invented, official.url],
          },
          { text: "", sourceUrls: [] },
          { text: "【3†source】", sourceUrls: [official.url] },
        ],
        sources: [
          { url: official.url, type: "tourism_board" },
          { url: invented, type: "government" },
          { url: official.url, type: "other" },
        ],
      })],
    }, [{ type: "web_search_call", action: { sources: [official] } }]));

    const questionAnswers = [
      { question: "Indoor or outdoor markets?", answer: "Indoor" },
      { question: "How much walking?", answer: null },
    ];
    const result = await model(fetch).research({
      trip: facts, brief, request, questionAnswers, discovered, outputLanguage: "en",
    });

    expect(result.candidates).toEqual([expect.objectContaining({
      name: "Tofuku-ji",
      localName: "東福寺",
      recommendationSentences: [
        { text: "Autumn leaves are visible from Tsutenkyo bridge.", sourceUrls: [official.url] },
        { text: "The pacing should feel calm.", sourceUrls: [] },
      ],
      tradeoffSentences: [{ text: "Crowds can build around noon.", sourceUrls: [official.url] }],
      sources: [{ url: official.url, type: "tourism_board" }],
    })]);
    expect(result.candidates[0]).not.toHaveProperty("confidence");
    expect(result.sources).toEqual([official]);
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.tools).toEqual([{ type: "web_search", search_context_size: "low" }]);
    expect(body.include).toEqual(["web_search_call.action.sources"]);
    expect(body.max_tool_calls).toBe(20);
    expect(JSON.parse(body.input[1].content)).toMatchObject({ questionAnswers });
    expect(body.input[0].content).toContain("A null answer was explicitly skipped");
    const item = body.text.format.schema.properties.candidates.items.properties;
    expect(item.category.anyOf[0].enum).toEqual(["Temples", "Local food"]);
    expect(item.namedPlace.anyOf[0].enum).toEqual(["Saihoji"]);
    expect(item.placeId.enum).toEqual(discovered[0]!.placeIds);
    expect(item).not.toHaveProperty("confidence");
  });

  it("drops a candidate when stripping citations leaves no recommendation sentence", async () => {
    const result = await model(vi.fn(async () => completed({
      candidates: [
        researched({
          placeId: "ChIJ-kinkakuji",
          name: "Citation-only place",
          recommendation: [{ text: "【3†source】", sourceUrls: [] }],
        }),
        researched({ placeId: "ChIJ-ginkakuji", name: "Empty recommendation place", recommendation: [] }),
        researched({ placeId: "ChIJ-nishiki", name: "Nishiki Market", category: "Local food" }),
      ],
    }))).research({ trip: facts, brief, request, questionAnswers: [], discovered, outputLanguage: "en" });

    expect(result.candidates.map((entry) => entry.name)).toEqual(["Nishiki Market"]);
  });

  it("drops repeated places, places not discovered, and places filed under kinds or named places the request lacks", async () => {
    const result = await model(vi.fn(async () => completed({
      candidates: [
        researched({ placeId: "ChIJ-saihoji", name: "Saiho-ji", namedPlace: "Saihoji" }),
        // The same place picked twice under another spelling.
        researched({ placeId: "ChIJ-saihoji", name: "saiho ji" }),
        researched({ placeId: "ChIJ-kinkakuji", name: "Kinkaku-ji", category: "Gardens" }),
        researched({ placeId: "ChIJ-ginkakuji", name: "Ginkaku-ji", namedPlace: "Eikando" }),
        // A Place ID this run did not discover: the model cannot add a place of its own.
        researched({ placeId: "ChIJ-invented", name: "Invented Temple" }),
        researched({ placeId: "ChIJ-nishiki", name: "Nishiki Market", category: "Local food" }),
      ],
    }))).research({ trip: facts, brief, request, questionAnswers: [], discovered, outputLanguage: "en" });

    expect(result.candidates.map((entry) => [entry.name, entry.namedPlace])).toEqual([
      ["Saiho-ji", "Saihoji"],
      ["Nishiki Market", null],
    ]);
  });

  it("keeps a named place of none of the requested kinds without a kind, and drops any other place without one", async () => {
    const result = await model(vi.fn(async () => completed({
      candidates: [
        researched({ placeId: "ChIJ-saihoji", name: "Saiho-ji", namedPlace: "Saihoji", category: null }),
        researched({ placeId: "ChIJ-arashiyama", name: "Arashiyama", category: null }),
      ],
    }))).research({ trip: facts, brief, request, questionAnswers: [], discovered, outputLanguage: "en" });

    expect(result.candidates.map((entry) => [entry.name, entry.category])).toEqual([["Saiho-ji", null]]);
  });

  it("cuts kinds of place to the 80 characters a proposal can store", async () => {
    const long = "Quiet traditional gardens and temples at their best for autumn leaves in late October";
    const result = await model(vi.fn(async () => completed({
      structuredBrief: { interests: [], pace: null, budget: null, exclusions: [], areas: [] },
      unresolvedQuestions: [],
      request: { ...request, categories: [long, "Local food"] },
      outputLanguage: "en",
    }))).plan({ trip: facts, brief: "Gardens", questionAnswers: [] });

    expect(result.request.categories).toEqual([long.slice(0, 80).trim(), "Local food"]);
  });

  it("validates the plan's searches, fills missing coverage, and shares the search cap round-robin", async () => {
    const searches = [
      // Valid, for Kyoto temples: three of them.
      { query: "京都 紅葉 寺", area: "Kyoto", category: "Temples", namedPlace: null },
      { query: "京都 庭園 寺", area: "Kyoto", category: "Temples", namedPlace: null },
      { query: "京都 禅寺", area: "Kyoto", category: "Temples", namedPlace: null },
      // Dropped: a kind the request lacks, both kind and named place, and an empty query.
      { query: "京都 カフェ", area: "Kyoto", category: "Cafes", namedPlace: null },
      { query: "京都 西芳寺", area: "Kyoto", category: "Temples", namedPlace: "Saihoji" },
      { query: "   ", area: "Kyoto", category: "Temples", namedPlace: null },
      { query: "西芳寺 苔寺", area: "Kyoto", category: null, namedPlace: "Saihoji" },
    ];
    const result = await model(vi.fn(async () => completed({
      structuredBrief: brief,
      unresolvedQuestions: [],
      request: { ...request, searchQueries: searches },
      outputLanguage: "en",
    }))).plan({ trip: facts, brief: "Temples and food", questionAnswers: [] });

    expect(result.request.searchQueries.map((entry) => entry.query)).toEqual([
      // Round 1: the named place, each kind once (food had no search: the fallback).
      "西芳寺 苔寺", "京都 紅葉 寺", "Kyoto Local food",
      // Later rounds: the remaining temple searches.
      "京都 庭園 寺", "京都 禅寺",
    ]);
  });

  it("never calls the model when discovery found no place to pick from", async () => {
    const fetch = vi.fn(async () => completed({ candidates: [] }));
    const result = await model(fetch).research({
      trip: facts, brief, request, questionAnswers: [], outputLanguage: "en",
      discovered: [{ ...discovered[0]!, placeIds: [null, null] }],
    });
    expect(result.candidates).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed before making a request when no server credential is configured", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => completed({}));
    const unavailable = new OpenAiResponsesDiscoveryModel({ model: "gpt-test", fetch });
    await expect(unavailable.plan({ trip: facts, brief: "Food", questionAnswers: [] }))
      .rejects.toBeInstanceOf(DiscoveryModelUnavailableError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
