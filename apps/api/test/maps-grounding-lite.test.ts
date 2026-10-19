import { describe, expect, it } from "vitest";

import { discoverPlaces, MapsGroundingLite, type PlaceDiscovery } from "../src/discovery/maps-grounding-lite";
import { ProviderQuotaError, ProviderUnavailableError } from "../src/trip-places/google-places-provider";

const toolResult = {
  summary: "**Chitose** [0] okonomiyaki. **Mizuno** [1] okonomiyaki.",
  places: [
    { place: "places/ChIJ-chitose", id: "ChIJ-chitose", location: { latitude: 34.65, longitude: 135.5 } },
    { place: "places/ChIJ-mizuno", id: "ChIJ-mizuno", location: { latitude: 99, longitude: 135.5 } },
    { id: "bad id!" },
  ],
};

function rpc(body: unknown) {
  return { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(body) }] } };
}

describe("Maps Grounding Lite client", () => {
  it("calls search_places with the key and keeps only valid IDs and coordinates", async () => {
    let sent: { headers: Headers; body: unknown } | null = null;
    const client = new MapsGroundingLite({
      apiKey: "server-key",
      fetch: async (_input, init) => {
        sent = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
        return Response.json(rpc(toolResult));
      },
    });

    const result = await client.searchPlaces(" 大阪 お好み焼き ", { languageCode: "zh-TW" });

    expect(sent!.headers.get("X-Goog-Api-Key")).toBe("server-key");
    expect(sent!.body).toMatchObject({
      method: "tools/call",
      params: { name: "search_places", arguments: { textQuery: "大阪 お好み焼き", languageCode: "zh-TW" } },
    });
    expect(result.places).toEqual([
      { providerPlaceId: "ChIJ-chitose", latitude: 34.65, longitude: 135.5 },
      { providerPlaceId: "ChIJ-mizuno", latitude: null, longitude: 135.5 },
    ]);
    expect(result.summary).toContain("Chitose");
  });

  it("reads a server-sent event answer and structured content", async () => {
    const client = new MapsGroundingLite({
      apiKey: "server-key",
      fetch: async () => new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: toolResult } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    });
    const result = await client.searchPlaces("大阪 お好み焼き", {});
    expect(result.places.map((place) => place.providerPlaceId)).toEqual(["ChIJ-chitose", "ChIJ-mizuno"]);
  });

  it("treats a tool error, a non-OK answer and a missing key as unavailable, and 429 as quota", async () => {
    const answer = (response: Response) => new MapsGroundingLite({ apiKey: "k", fetch: async () => response });
    await expect(answer(Response.json({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [] } })).searchPlaces("q", {}))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(answer(new Response("nope", { status: 403 })).searchPlaces("q", {})).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(answer(new Response("slow down", { status: 429 })).searchPlaces("q", {})).rejects.toBeInstanceOf(ProviderQuotaError);
    let called = false;
    const keyless = new MapsGroundingLite({ fetch: async () => { called = true; return Response.json({}); } });
    expect(keyless.available).toBe(false);
    await expect(keyless.searchPlaces("q", {})).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(called).toBe(false);
  });

  it("charges the paid-provider budget before each call and stops when it is spent", async () => {
    let calls = 0;
    const client = new MapsGroundingLite({
      apiKey: "k",
      consumeBudget: async () => false,
      fetch: async () => { calls += 1; return Response.json(rpc(toolResult)); },
    });
    await expect(client.searchPlaces("q", {})).rejects.toBeInstanceOf(ProviderQuotaError);
    expect(calls).toBe(0);
  });
});

describe("place discovery across the planned searches", () => {
  const query = (text: string) => ({ query: text, area: "大阪", category: "美食", namedPlace: null });

  it("keeps citation positions, nulls places the trip already has, and skips a failed search", async () => {
    const discovery: PlaceDiscovery = {
      available: true,
      async searchPlaces(text) {
        if (text === "broken") throw new ProviderUnavailableError();
        return { summary: `${text} [0] [1]`, places: [{ providerPlaceId: "ChIJ-a", latitude: null, longitude: null }, { providerPlaceId: "ChIJ-known", latitude: null, longitude: null }] };
      },
    };
    const result = await discoverPlaces({
      queries: [query("大阪 お好み焼き"), query("broken")],
      discovery,
      languageCode: "zh-TW",
      known: new Set(["ChIJ-known"]),
    });
    expect(result.groups).toEqual([{ ...query("大阪 お好み焼き"), summary: "大阪 お好み焼き [0] [1]", placeIds: ["ChIJ-a", null] }]);
    expect(result.found).toBe(1);
  });

  it("fails as unavailable when every search failed, and stops searching once the quota is spent", async () => {
    const down: PlaceDiscovery = { available: true, searchPlaces: async () => { throw new ProviderUnavailableError(); } };
    await expect(discoverPlaces({ queries: [query("a"), query("b")], discovery: down, languageCode: "ja", known: new Set() }))
      .rejects.toBeInstanceOf(ProviderUnavailableError);

    let calls = 0;
    const spent: PlaceDiscovery = { available: true, searchPlaces: async () => { calls += 1; throw new ProviderQuotaError(); } };
    await expect(discoverPlaces({
      queries: Array.from({ length: 12 }, (_, index) => query(`q${index}`)), discovery: spent, languageCode: "ja", known: new Set(),
    })).rejects.toBeInstanceOf(ProviderQuotaError);
    // The four workers each stop after their first spent answer.
    expect(calls).toBeLessThanOrEqual(4);
  });
});
