import { describe, expect, it } from "vitest";
import { googleMapsCoordinatesUrl, googleMapsDirectionsUrl } from "../src/google-maps";

describe("formal place navigation", () => {
  it("opens the reliable destination, including zero coordinates, without inventing another endpoint", () => {
    const place = new URL(googleMapsCoordinatesUrl({ latitude: 0, longitude: 0 })!);
    expect(place.origin).toBe("https://www.google.com");
    expect(place.pathname).toBe("/maps/search/");
    expect(place.searchParams.get("query")).toBe("0,0");
    expect(place.searchParams.has("origin")).toBe(false);
    const directions = new URL(googleMapsCoordinatesUrl({ latitude: 34.68, longitude: 135.5 }, { latitude: 34.4, longitude: 135.3 })!);
    expect(directions.pathname).toBe("/maps/dir/");
    expect(directions.searchParams.get("origin")).toBe("34.4,135.3");
    expect(directions.searchParams.get("destination")).toBe("34.68,135.5");
  });
  it("does not guess navigation when either formal endpoint lacks reliable coordinates", () => {
    expect(googleMapsCoordinatesUrl({ latitude: null, longitude: 135.5 })).toBeNull();
    expect(googleMapsCoordinatesUrl({ latitude: 34.68, longitude: 135.5 }, { latitude: 34.4, longitude: null })).toBeNull();
    expect(googleMapsCoordinatesUrl({ latitude: Infinity, longitude: 135.5 })).toBeNull();
    expect(googleMapsCoordinatesUrl({ latitude: 91, longitude: 135.5 })).toBeNull();
  });
});

describe("route-leg directions", () => {
  it("sends both coordinate endpoints and their provider place IDs without choosing a travel mode", () => {
    const result = googleMapsDirectionsUrl(
      { latitude: 0, longitude: 0, providerPlaceId: "origin-google-id" },
      { latitude: 34.9949, longitude: 135.785, providerPlaceId: "destination-google-id" },
    );

    const url = new URL(result!);
    expect(url.pathname).toBe("/maps/dir/");
    expect(url.searchParams.get("origin")).toBe("0,0");
    expect(url.searchParams.get("origin_place_id")).toBe("origin-google-id");
    expect(url.searchParams.get("destination")).toBe("34.9949,135.785");
    expect(url.searchParams.get("destination_place_id")).toBe("destination-google-id");
    expect(url.searchParams.has("travelmode")).toBe(false);
  });

  it("can open transit directions for a likely bus leg", () => {
    const result = googleMapsDirectionsUrl(
      { latitude: 35.0593, longitude: 135.7525, providerPlaceId: null },
      { latitude: 35.0302, longitude: 135.7727, providerPlaceId: null },
      "transit",
    );

    expect(new URL(result!).searchParams.get("travelmode")).toBe("transit");
  });

  it.each([
    [{ latitude: null, longitude: 0, providerPlaceId: null }, { latitude: 1, longitude: 1, providerPlaceId: null }],
    [{ latitude: 0, longitude: Number.NaN, providerPlaceId: null }, { latitude: 1, longitude: 1, providerPlaceId: null }],
    [{ latitude: -91, longitude: 0, providerPlaceId: null }, { latitude: 1, longitude: 1, providerPlaceId: null }],
    [{ latitude: 0, longitude: 0, providerPlaceId: null }, { latitude: 1, longitude: 181, providerPlaceId: null }],
  ])("rejects an invalid endpoint instead of asking Maps to guess", (origin, destination) => {
    expect(googleMapsDirectionsUrl(origin, destination)).toBeNull();
  });
});
