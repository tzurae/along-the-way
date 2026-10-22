import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NearbyActivityModelError,
  OpenAiNearbyActivityModel,
} from "../src/nearby-activities/openai-nearby-activity-model";
import type { NearbyActivityQuery } from "../src/nearby-activities/nearby-activity-module";

const API_KEY = "sk-test-nearby-secret";
const query: NearbyActivityQuery = {
  stopName: "清水寺",
  address: "京都府京都市東山区清水1丁目294",
  latitude: 34.9949,
  longitude: 135.785,
  date: "2026-10-23",
  timeZone: "Asia/Tokyo",
  countryCode: "JP",
};

/** Pages this request's web search returned: the only pages an activity may cite. */
const lightUp = "https://www.kiyomizudera.or.jp/event/lightup.html";
const kimono = "https://kimono.example.jp/kyoto";

function activity(overrides: Record<string, unknown>) {
  return {
    title: "秋季夜間特別拝観",
    description: "清水寺在秋季晚上點燈開放參拜。",
    kind: "event",
    timeText: null,
    startsAt: "2026-10-23T18:00",
    endsAt: "2026-10-23T21:30",
    venueName: "清水寺",
    latitude: 34.9949,
    longitude: 135.785,
    sourceUrl: lightUp,
    ...overrides,
  };
}

function completed(activities: unknown[]) {
  return new Response(JSON.stringify({
    status: "completed",
    output: [
      { type: "web_search_call", action: { type: "search", sources: [{ type: "url", url: lightUp }, { type: "url", url: kimono }] } },
      {
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({ activities }),
          annotations: [{ type: "url_citation", url: lightUp, title: "清水寺 夜間特別拝観" }],
        }],
      },
    ],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenAiNearbyActivityModel", () => {
  it("asks web search near the stop's country and time zone with a bounded number of searches", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fetch = vi.fn(async () => completed([]));
    const model = new OpenAiNearbyActivityModel({ apiKey: API_KEY, model: "gpt-test", fetch });

    await expect(model.find(query)).resolves.toEqual([]);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: "gpt-test",
      store: false,
      tools: [{
        type: "web_search",
        search_context_size: "low",
        user_location: { type: "approximate", country: "JP", timezone: "Asia/Tokyo" },
      }],
      include: ["web_search_call.action.sources"],
      max_tool_calls: 4,
      text: { format: { type: "json_schema", strict: true } },
    });
    expect(body.text.format.schema.properties.activities.maxItems).toBe(6);
    expect(JSON.parse(body.input[1].content)).toMatchObject({
      place: "清水寺",
      latitude: 34.9949,
      longitude: 135.785,
      localDate: "2026-10-23",
    });
  });

  it("drops items whose source the web search did not return and keeps only stated times", async () => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    const model = new OpenAiNearbyActivityModel({
      apiKey: API_KEY,
      model: "gpt-test",
      fetch: async () => completed([
        activity({}),
        activity({ title: "記憶中的市集", sourceUrl: "https://invented.example.com/market" }),
        activity({
          title: "和服租借",
          description: "在清水寺附近租和服散步。",
          kind: "experience",
          startsAt: null,
          endsAt: "2026-10-23T20:00",
          latitude: null,
          longitude: 135.78,
          sourceUrl: kimono,
        }),
        activity({ title: "秋季夜間特別拝観", description: "重複的項目。" }),
        activity({ title: "清水寺舞台音樂會", startsAt: "18:00", endsAt: "20:00", timeText: "傍晚" }),
      ]),
    });

    const found = await model.find(query);

    expect(found).toEqual([
      {
        title: "秋季夜間特別拝観",
        description: "清水寺在秋季晚上點燈開放參拜。",
        kind: "event",
        timeText: null,
        startsAt: "2026-10-23T18:00",
        endsAt: "2026-10-23T21:30",
        venueName: "清水寺",
        latitude: 34.9949,
        longitude: 135.785,
        sourceUrl: lightUp,
        sourceTitle: "清水寺 夜間特別拝観",
      },
      // 和服租借 states no time (no start, no timeText): it is not actionable and is dropped.
      expect.objectContaining({ title: "清水寺舞台音樂會", startsAt: null, endsAt: null, timeText: "傍晚" }),
    ]);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(API_KEY);
    expect(JSON.stringify(logs.mock.calls)).not.toContain("清水寺在秋季");
  });

  it("is unavailable without a key or model and fails closed on a provider error", async () => {
    const fetch = vi.fn(async () => completed([]));
    const unconfigured = new OpenAiNearbyActivityModel({ apiKey: " ", model: "gpt-test", fetch });
    expect(unconfigured.available).toBe(false);
    await expect(unconfigured.find(query)).rejects.toBeInstanceOf(NearbyActivityModelError);
    expect(fetch).not.toHaveBeenCalled();

    const failing = new OpenAiNearbyActivityModel({
      apiKey: API_KEY,
      model: "gpt-test",
      fetch: async () => new Response(JSON.stringify({ error: { message: `bad key ${API_KEY}` } }), { status: 401 }),
    });
    const error = await failing.find(query).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NearbyActivityModelError);
    expect(String((error as Error).message)).not.toContain(API_KEY);
  });
});
