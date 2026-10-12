import { describe, expect, it } from "vitest";

import {
  GooglePlacesProvider,
  googlePlacePhotoDto,
  PlacePhotoNotFoundError,
  ProviderUnavailableError,
} from "../src/trip-places/google-places-provider";

describe("Google Places provider adapter", () => {
  it("classifies temples and shrines as sights instead of other", async () => {
    const place = (id: string, primaryType: string) => ({
      id, displayName: { text: id }, formattedAddress: "Kyoto",
      location: { latitude: 34.97, longitude: 135.77 }, primaryType,
    });
    const provider = new GooglePlacesProvider({
      apiKey: "server-only-key",
      now: () => new Date("2026-10-12T12:00:00.000Z"),
      fetch: async () => Response.json({ places: [
        place("ChIJ-temple-000001", "buddhist_temple"),
        place("ChIJ-shrine-000001", "shinto_shrine"),
        place("ChIJ-station-00001", "train_station"),
      ] }),
    });

    const candidates = await provider.search("東福寺");

    expect(candidates.map((candidate) => candidate.type)).toEqual(["activity", "activity", "station"]);
  });

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
              primaryTypeDisplayName: { text: "觀光景點" },
              googleMapsUri: "https://www.google.com/maps/place/?query_place_id=ChIJ-provider-place-1234",
              photos: [{
                name: "places/ChIJ-provider-place-1234/photos/photo-token",
                widthPx: 1600,
                heightPx: 1200,
                authorAttributions: [{ displayName: "Photo Author", uri: "https://example.test/author" }],
                googleMapsUri: "https://maps.google.com/?cid=photo",
              }],
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
    expect(fields).toContain("places.primaryTypeDisplayName");
    expect(fields).toContain("places.photos");
    expect(candidates).toEqual([
      expect.objectContaining({
        providerPlaceId: "ChIJ-provider-place-1234",
        name: "Kiyomizu-dera",
        type: "activity",
        typeLabel: "觀光景點",
        attribution: "Google Maps",
        observedAt: "2026-09-28T12:00:00.000Z",
        expiresAt: "2026-10-28T12:00:00.000Z",
        photo: null,
        providerPhoto: {
          name: "places/ChIJ-provider-place-1234/photos/photo-token",
          width: 1600,
          height: 1200,
          authors: [{ displayName: "Photo Author", uri: "https://example.test/author" }],
          googleMapsUri: "https://maps.google.com/?cid=photo",
        },
      }),
    ]);
  });

  it("sends the requested locale, region, and page size without the deprecated result count", async () => {
    const bodies: unknown[] = [];
    const provider = new GooglePlacesProvider({
      apiKey: "server-only-key",
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ places: [] });
      },
    });

    await provider.search("東福寺", { languageCode: "zh-TW", regionCode: "JP", pageSize: 3 });
    await provider.search("Tofuku-ji");

    expect(bodies).toEqual([
      { textQuery: "東福寺", languageCode: "zh-TW", regionCode: "JP", pageSize: 3 },
      { textQuery: "Tofuku-ji" },
    ]);
  });

  it("ignores a malformed first photo without dropping its place", async () => {
    const provider = new GooglePlacesProvider({
      apiKey: "server-only-key",
      fetch: async () => Response.json({ places: [{
        id: "ChIJ-provider-place-1234", displayName: { text: "東福寺" },
        primaryTypeDisplayName: { text: 42 },
        photos: [{ name: "", widthPx: "wide", heightPx: 600 }],
      }] }),
    });
    await expect(provider.search("東福寺")).resolves.toEqual([
      expect.objectContaining({ providerPlaceId: "ChIJ-provider-place-1234", typeLabel: null, providerPhoto: null }),
    ]);
  });

  it("adds locale and region to Place Details confirmation", async () => {
    let capturedUrl = "";
    let capturedFields = "";
    const provider = new GooglePlacesProvider({
      apiKey: "server-only-key",
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedFields = new Headers(init?.headers).get("X-Goog-FieldMask") ?? "";
        return Response.json({
          id: "ChIJ-provider-place-1234",
          displayName: { text: "東福寺" },
          primaryTypeDisplayName: { text: "佛寺" },
          photos: [{
            name: "places/ChIJ-provider-place-1234/photos/details-token",
            widthPx: 1200,
            heightPx: 800,
          }],
        });
      },
    });
    const candidate = await provider.getPlace(
      "ChIJ-provider-place-1234",
      { languageCode: "zh-TW", regionCode: "JP" },
    );
    expect(capturedUrl).toBe("https://places.googleapis.com/v1/places/ChIJ-provider-place-1234?languageCode=zh-TW&regionCode=JP");
    expect(capturedFields.split(",")).toEqual(expect.arrayContaining(["primaryTypeDisplayName", "photos"]));
    expect(candidate).toMatchObject({
      typeLabel: "佛寺",
      providerPhoto: { name: "places/ChIJ-provider-place-1234/photos/details-token" },
    });
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
  it("reads only the first Place Details photo and fetches bounded image media", async () => {
    const calls: Array<{ url: string; fields: string | null; apiKey: string | null; redirect: RequestRedirect | undefined }> = [];
    const provider = new GooglePlacesProvider({
      apiKey: "server-only-key",
      fetch: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({
          url,
          fields: headers.get("X-Goog-FieldMask"),
          apiKey: headers.get("X-Goog-Api-Key"),
          redirect: init?.redirect,
        });
        if (url.endsWith("/places/ChIJ-photo-place-1234")) {
          return Response.json({ photos: [{
            name: "places/ChIJ-photo-place-1234/photos/first-token", widthPx: 2048, heightPx: 1365,
            authorAttributions: [{ displayName: "甲", uri: "https://example.test/author" }],
            googleMapsUri: "https://maps.google.com/?cid=photo",
          }, {
            name: "places/ChIJ-photo-place-1234/photos/second-token", widthPx: 800, heightPx: 600,
          }] });
        }
        if (url.includes("/media?")) return Response.json({ photoUri: "https://lh3.googleusercontent.com/photo-token" });
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/jpeg", "Content-Length": "3" } });
      },
    });

    expect(await provider.getFirstPhoto("ChIJ-photo-place-1234")).toEqual({
      name: "places/ChIJ-photo-place-1234/photos/first-token",
      width: 2048,
      height: 1365,
      authors: [{ displayName: "甲", uri: "https://example.test/author" }],
      googleMapsUri: "https://maps.google.com/?cid=photo",
    });
    expect(calls[0]).toEqual({
      url: "https://places.googleapis.com/v1/places/ChIJ-photo-place-1234",
      fields: "photos",
      apiKey: "server-only-key",
      redirect: undefined,
    });
    const media = await provider.fetchPhotoMedia("places/ChIJ-photo-place-1234/photos/first-token", 1024);
    expect(media.contentType).toBe("image/jpeg");
    expect([...media.bytes]).toEqual([1, 2, 3]);
    expect(calls[1]?.url).toBe("https://places.googleapis.com/v1/places/ChIJ-photo-place-1234/photos/first-token/media?maxWidthPx=1024&skipHttpRedirect=true");
    expect(calls[2]?.url).toBe("https://lh3.googleusercontent.com/photo-token");
    expect(calls[2]?.apiKey).toBeNull();
    expect(calls[2]?.redirect).toBe("manual");
  });

  it.each([
    ["non-image media", { status: 200, contentType: "text/html", body: "not an image" }],
    ["SVG media", { status: 200, contentType: "image/svg+xml", body: "<svg/>" }],
    ["failed media", { status: 503, contentType: "image/jpeg", body: "unavailable" }],
  ])("rejects %s", async (_label, media) => {
    const provider = new GooglePlacesProvider({
      apiKey: "server-only-key",
      fetch: async (input) => String(input).includes("/media?")
        ? Response.json({ photoUri: "https://lh3.googleusercontent.com/photo-token" })
        : new Response(media.body, {
            status: media.status,
            headers: { "Content-Type": media.contentType, "Content-Length": String(media.body.length) },
          }),
    });
    await expect(provider.fetchPhotoMedia("places/ChIJ-photo-place-1234/photos/first-token", 192))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("rejects a declared oversized body before reading its real body", async () => {
    const oversizedLength = 5 * 1024 * 1024 + 1;
    let bodyRead = false;
    const response = new Response(new Uint8Array(oversizedLength), {
      headers: { "Content-Type": "image/jpeg", "Content-Length": String(oversizedLength) },
    });
    const body = response.body!;
    const getReader = body.getReader.bind(body);
    Object.defineProperty(body, "getReader", {
      value: () => {
        bodyRead = true;
        return getReader();
      },
    });
    const provider = new GooglePlacesProvider({
      apiKey: "server-only-key",
      fetch: async (input) => String(input).includes("/media?")
        ? Response.json({ photoUri: "https://lh3.googleusercontent.com/photo-token" })
        : response,
    });
    await expect(provider.fetchPhotoMedia("places/ChIJ-photo-place-1234/photos/first-token", 192))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(bodyRead).toBe(false);
  });

  it("rejects a streamed oversized body without Content-Length", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let emitted = 0;
    const provider = new GooglePlacesProvider({
      apiKey: "server-only-key",
      fetch: async (input) => {
        if (String(input).includes("/media?")) {
          return Response.json({ photoUri: "https://lh3.googleusercontent.com/photo-token" });
        }
        return new Response(new ReadableStream({
          pull(controller) {
            if (emitted++ < 6) controller.enqueue(chunk);
            else controller.close();
          },
        }), { headers: { "Content-Type": "image/jpeg" } });
      },
    });
    await expect(provider.fetchPhotoMedia("places/ChIJ-photo-place-1234/photos/first-token", 192))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(emitted).toBeGreaterThan(5);
  });

  it("rejects oversized metadata and maps an expired photo resource to not-found", async () => {
    const oversized = new GooglePlacesProvider({
      apiKey: "server-only-key",
      fetch: async () => Response.json({ padding: "x".repeat(300 * 1024) }),
    });
    await expect(oversized.fetchPhotoMedia("places/ChIJ-photo-place-1234/photos/first-token", 192))
      .rejects.toBeInstanceOf(ProviderUnavailableError);

    const expired = new GooglePlacesProvider({
      apiKey: "server-only-key",
      fetch: async () => new Response("gone", { status: 404 }),
    });
    await expect(expired.fetchPhotoMedia("places/ChIJ-photo-place-1234/photos/first-token", 192))
      .rejects.toBeInstanceOf(PlacePhotoNotFoundError);
  });

  it("allows only bounded googleusercontent redirects", async () => {
    const fetched: string[] = [];
    const unsafeHost = new GooglePlacesProvider({
      apiKey: "server-only-key",
      fetch: async (input) => {
        fetched.push(String(input));
        return Response.json({ photoUri: "https://attacker.example/photo" });
      },
    });
    await expect(unsafeHost.fetchPhotoMedia("places/ChIJ-photo-place-1234/photos/first-token", 192))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(fetched).toHaveLength(1);

    const redirected: string[] = [];
    const tooManyRedirects = new GooglePlacesProvider({
      apiKey: "server-only-key",
      fetch: async (input, init) => {
        const url = String(input);
        redirected.push(url);
        if (url.includes("/media?")) {
          return Response.json({ photoUri: "https://lh3.googleusercontent.com/start" });
        }
        expect(init?.redirect).toBe("manual");
        const next = url.endsWith("/start") ? "/one" : url.endsWith("/one") ? "/two" : "/three";
        return new Response(null, { status: 302, headers: { Location: next } });
      },
    });
    await expect(tooManyRedirects.fetchPhotoMedia("places/ChIJ-photo-place-1234/photos/first-token", 192))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(redirected.at(-1)).toBe("https://lh3.googleusercontent.com/two");

    const unsafeRedirect = new GooglePlacesProvider({
      apiKey: "server-only-key",
      fetch: async (input) => String(input).includes("/media?")
        ? Response.json({ photoUri: "https://lh3.googleusercontent.com/start" })
        : new Response(null, { status: 302, headers: { Location: "https://attacker.example/photo" } }),
    });
    await expect(unsafeRedirect.fetchPhotoMedia("places/ChIJ-photo-place-1234/photos/first-token", 192))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("builds stable same-origin URLs from photo attribution without provider credentials", () => {
    const photo = {
      name: "places/ChIJ-photo-place-1234/photos/first-token",
      width: 1200,
      height: 800,
      authors: [{ displayName: "甲", uri: null }],
      googleMapsUri: null,
    };
    const dto = googlePlacePhotoDto("11111111-1111-4111-8111-111111111111", "ChIJ-photo-place-1234", photo);
    expect(dto).toMatchObject({
      source: "google",
      id: "google:ChIJ-photo-place-1234:84df05a7b9f74968",
      thumbnailUrl: "/api/trips/11111111-1111-4111-8111-111111111111/google-place-photos/ChIJ-photo-place-1234?photo=84df05a7b9f74968&maxWidth=192",
      imageUrl: "/api/trips/11111111-1111-4111-8111-111111111111/google-place-photos/ChIJ-photo-place-1234?photo=84df05a7b9f74968&maxWidth=1024",
    });
    const renamed = googlePlacePhotoDto(
      "11111111-1111-4111-8111-111111111111",
      "ChIJ-photo-place-1234",
      { ...photo, name: "places/ChIJ-photo-place-1234/photos/rotated-provider-token" },
    );
    expect({ id: renamed.id, thumbnailUrl: renamed.thumbnailUrl, imageUrl: renamed.imageUrl })
      .toEqual({ id: dto.id, thumbnailUrl: dto.thumbnailUrl, imageUrl: dto.imageUrl });
    const differentPhoto = googlePlacePhotoDto(
      "11111111-1111-4111-8111-111111111111",
      "ChIJ-photo-place-1234",
      { ...photo, googleMapsUri: "https://maps.google.com/?cid=a-different-photo" },
    );
    expect(differentPhoto.id).not.toBe(dto.id);
    expect(JSON.stringify(dto)).not.toMatch(/key=|server-only-key|first-token/);
  });

});
