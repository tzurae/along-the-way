import { describe, expect, it } from "vitest";
import { googleMapsCoordinatesUrl } from "../src/google-maps";

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
