import { describe, expect, it } from "vitest";

import {
  GooglePlacesProvider,
  ProviderUnavailableError,
} from "../src/trip-places/google-places-provider";

describe("Google Places provider adapter", () => {
  it("requests only confirmation fields and returns attributed timestamped candidates", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const provider = new GooglePlacesProvider({
      apiKey: "server-only-key",
      now: () => new Date("2026-09-28T12:00:00.000Z"),
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return Response.json({
          places: [
            {
              id: "ChIJ-provider-place-1234",
              displayName: { text: "Kiyomizu-dera" },
              formattedAddress: "Kyoto",
              location: { latitude: 34.9948, longitude: 135.785 },
              primaryType: "tourist_attraction",
              googleMapsUri: "https://www.google.com/maps/place/?query_place_id=ChIJ-provider-place-1234",
            },
          ],
        });
      },
    });

    const candidates = await provider.search("Kiyomizu-dera");

    expect(capturedUrl).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(capturedInit?.method).toBe("POST");
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("X-Goog-Api-Key")).toBe("server-only-key");
    const fields = headers.get("X-Goog-FieldMask") ?? "";
    expect(fields).toContain("places.id");
    expect(fields).toContain("places.displayName");
    expect(fields).not.toMatch(/rating|review|photo/i);
    expect(candidates).toEqual([
      expect.objectContaining({
        providerPlaceId: "ChIJ-provider-place-1234",
        name: "Kiyomizu-dera",
        type: "activity",
        attribution: "Google Maps",
        observedAt: "2026-09-28T12:00:00.000Z",
        expiresAt: "2026-10-28T12:00:00.000Z",
      }),
    ]);
  });

  it("asks Google for names and addresses in the requested language only when given", async () => {
    const bodies: unknown[] = [];
    const provider = new GooglePlacesProvider({
      apiKey: "server-only-key",
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ places: [] });
      },
    });

    await provider.search("東福寺", { languageCode: "zh-TW" });
    await provider.search("Tofuku-ji");

    expect(bodies).toEqual([
      { textQuery: "東福寺", maxResultCount: 8, languageCode: "zh-TW" },
      { textQuery: "Tofuku-ji", maxResultCount: 8 },
    ]);
  });

  it("does not call the network without a server credential", async () => {
    let called = false;
    const provider = new GooglePlacesProvider({
      fetch: async () => {
        called = true;
        return Response.json({});
      },
    });
    await expect(provider.search("Kyoto")).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(called).toBe(false);
  });

  it("maps network failures to provider-unavailable behavior", async () => {
    const provider = new GooglePlacesProvider({
      apiKey: "server-only-key",
      fetch: async () => {
        throw new TypeError("connection reset");
      },
    });
    await expect(provider.search("Kyoto")).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it("looks places up with rating, review count, website, business status and country, keeping only plausible values", async () => {
    let fields = "";
    let body: unknown;
    const provider = new GooglePlacesProvider({
      apiKey: "server-only-key",
      fetch: async (_input, init) => {
        fields = new Headers(init?.headers).get("X-Goog-FieldMask") ?? "";
        body = JSON.parse(String(init?.body));
        return Response.json({
          places: [
            {
              id: "ChIJ-tofukuji", displayName: { text: "東福寺" }, rating: 4.5, userRatingCount: 11_353, websiteUri: "https://tofukuji.jp/",
              businessStatus: "OPERATIONAL",
              addressComponents: [
                { longText: "京都市", shortText: "京都市", types: ["locality", "political"] },
                { longText: "日本", shortText: "jp", types: ["country", "political"] },
              ],
            },
            { id: "ChIJ-broken", displayName: { text: "Broken" }, rating: 9, userRatingCount: -3, businessStatus: "SOMETHING_NEW", addressComponents: [{ shortText: "Japan", types: ["country"] }] },
          ],
        });
      },
    });

    const results = await provider.lookup("京都 東福寺", { languageCode: "zh-TW" });

    expect(fields.split(",")).toEqual(expect.arrayContaining([
      "places.id", "places.rating", "places.userRatingCount", "places.websiteUri", "places.businessStatus", "places.addressComponents",
    ]));
    expect(fields).not.toMatch(/review(s|Summary)|photo/i);
    expect(body).toEqual({ textQuery: "京都 東福寺", maxResultCount: 3, languageCode: "zh-TW" });
    expect(results).toEqual([
      {
        candidate: expect.objectContaining({ providerPlaceId: "ChIJ-tofukuji", name: "東福寺" }),
        rating: 4.5, userRatingCount: 11_353, websiteUri: "https://tofukuji.jp/", businessStatus: "operational", countryCode: "JP",
      },
      {
        candidate: expect.objectContaining({ providerPlaceId: "ChIJ-broken" }),
        rating: null, userRatingCount: null, websiteUri: null, businessStatus: null, countryCode: null,
      },
    ]);
  });

  it("asks Place Details for opening hours only and keeps dated periods and missing hours apart", async () => {
    let url = "";
    let fields = "";
    const provider = new GooglePlacesProvider({
      apiKey: "server-only-key",
      fetch: async (input, init) => {
        url = String(input);
        fields = new Headers(init?.headers).get("X-Goog-FieldMask") ?? "";
        return Response.json({
          businessStatus: "OPERATIONAL",
          regularOpeningHours: {
            periods: [
              { open: { day: 4, hour: 9, minute: 0 }, close: { day: 4, hour: 16, minute: 30 } },
              { open: { day: 0, hour: 0, minute: 0 } },
            ],
          },
          currentOpeningHours: {
            periods: [{
              open: { day: 4, hour: 9, minute: 0, date: { year: 2026, month: 10, day: 22 } },
              close: { day: 4, hour: 16, minute: 30, date: { year: 2026, month: 10, day: 22 } },
            }],
          },
        });
      },
    });

    const hours = await provider.openingHours("ChIJ-tofukuji-1234");

    expect(url).toBe("https://places.googleapis.com/v1/places/ChIJ-tofukuji-1234");
    expect(fields.split(",").sort()).toEqual(["businessStatus", "currentOpeningHours", "regularOpeningHours"]);
    expect(hours).toEqual({
      businessStatus: "operational",
      regular: [
        { open: { day: 4, hour: 9, minute: 0, date: null }, close: { day: 4, hour: 16, minute: 30, date: null } },
        { open: { day: 0, hour: 0, minute: 0, date: null }, close: null },
      ],
      current: [{
        open: { day: 4, hour: 9, minute: 0, date: "2026-10-22" },
        close: { day: 4, hour: 16, minute: 30, date: "2026-10-22" },
      }],
    });
  });

  it("reports no hours when Place Details has none", async () => {
    const provider = new GooglePlacesProvider({
      apiKey: "server-only-key",
      fetch: async () => Response.json({}),
    });

    expect(await provider.openingHours("ChIJ-no-hours-1234")).toEqual({ businessStatus: null, regular: null, current: null });
  });
});
