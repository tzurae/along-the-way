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
});
