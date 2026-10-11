import { describe, expect, it, vi } from "vitest";
import type { RouteObservationQuery } from "@along-the-way/contracts/planning-observations";
import { GoogleRoutesProvider } from "../src/planning/google-routes-provider";

const NOW = new Date("2026-10-01T00:00:00Z");
const query: RouteObservationQuery = {
  origin: { placeId: "origin", latitude: 34.9858, longitude: 135.7588 },
  destination: { placeId: "destination", latitude: 34.9671, longitude: 135.7727 },
  departureTime: "2026-10-02T09:00:00+09:00",
};
const transitRoute = {
  duration: "1800.000000001s",
  distanceMeters: 2500,
  warnings: ["Service schedules may change"],
  legs: [{ steps: [
    { travelMode: "WALK", staticDuration: "480s" },
    { travelMode: "WALK", staticDuration: "480.1s" },
    { travelMode: "TRANSIT", staticDuration: "300s" },
    { travelMode: "WALK", staticDuration: "120s" },
  ] }],
};

// The seam is HTTP; every assertion consumes the public observation result.
function providerWithResponse(body: unknown, status = 200) {
  return new GoogleRoutesProvider({
    apiKey: "test-only-key", now: () => NOW,
    fetch: async () => Response.json(body, { status }),
  });
}

describe("Google Routes observation adapter", () => {
  it("retains attributed route facts, rounds up, and groups consecutive transit walking instructions", async () => {
    const observations = await providerWithResponse({ routes: [transitRoute] }).observe(query);
    expect(observations).toEqual([
      {
        status: "available", mode: "walking", originPlaceId: "origin", destinationPlaceId: "destination",
        requestedDepartureTime: "2026-10-02T00:00:00Z", provider: "google", attribution: "Google Maps",
        observedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-10-01T00:15:00.000Z",
        durationMinutes: 31, distanceMeters: 2500, walkingLegMinutes: [31], manualChecks: [],
        warnings: ["Service schedules may change"],
      },
      {
        status: "available", mode: "transit", originPlaceId: "origin", destinationPlaceId: "destination",
        requestedDepartureTime: "2026-10-02T00:00:00Z", provider: "google", attribution: "Google Maps",
        observedAt: "2026-10-01T00:00:00.000Z", expiresAt: "2026-10-01T00:15:00.000Z",
        durationMinutes: 31, distanceMeters: 2500, walkingLegMinutes: [17, 2], manualChecks: [],
        warnings: ["Service schedules may change"],
      },
    ]);
  });

  it("never loses a positive nanosecond at a large whole-minute boundary", async () => {
    const observations = await providerWithResponse({ routes: [{
      duration: "17280000.000000001s", distanceMeters: 100,
      legs: [{ steps: [
        { travelMode: "WALK", staticDuration: "8640000s" },
        { travelMode: "WALK", staticDuration: "8640000.000000001s" },
      ] }],
    }] }).observe(query);
    expect(observations.map((entry) => entry.durationMinutes)).toEqual([288001, 288001]);
    expect(observations[1]).toMatchObject({ walkingLegMinutes: [288001] });
  });

  it("keeps a successful mode when the other mode exhausts quota", async () => {
    const provider = new GoogleRoutesProvider({
      apiKey: "test-only-key", now: () => NOW,
      fetch: async (_input, init) => JSON.parse(String(init?.body)).travelMode === "WALK"
        ? Response.json({ routes: [{ duration: "120s", distanceMeters: 100 }] })
        : Response.json({ error: { message: "private provider details" } }, { status: 429 }),
    });
    const observations = await provider.observe(query);
    expect(observations[0]).toMatchObject({ status: "available", durationMinutes: 2 });
    expect(observations[1]).toMatchObject({ status: "unavailable", reason: "quota", durationMinutes: null, distanceMeters: null });
    expect(JSON.stringify(observations)).not.toContain("private provider details");
  });

  it.each([{}, { routes: [] }])("reports omitted or empty route collections as no-route: %j", async (body) => {
    const observations = await providerWithResponse(body).observe(query);
    expect(observations.map((entry) => entry.status === "unavailable" ? entry.reason : "available")).toEqual(["no_route", "no_route"]);
    expect(observations.map((entry) => entry.durationMinutes)).toEqual([null, null]);
  });

  it("reads an omitted distance as zero, as protobuf JSON omits zero values", async () => {
    // Google's answer for two points it places at the same spot, e.g. a hotel beside a station.
    const observations = await providerWithResponse({ routes: [{
      duration: "0s",
      legs: [{ steps: [{ travelMode: "WALK", staticDuration: "0s" }] }],
    }] }).observe(query);
    expect(observations.map((entry) => [entry.status, entry.durationMinutes, entry.distanceMeters]))
      .toEqual([["available", 0, 0], ["available", 0, 0]]);
  });

  it.each([
    { duration: "oops", distanceMeters: 10 },
    { duration: "-1s", distanceMeters: 10 },
    { distanceMeters: 10 },
    { duration: "10s", distanceMeters: -1 },
    { duration: "10s", distanceMeters: 1.5 },
    { duration: "10s", distanceMeters: "100" },
    { duration: "10s", distanceMeters: 100, warnings: [42] },
  ])("does not manufacture duration or distance from malformed route facts: %j", async (route) => {
    const observations = await providerWithResponse({ routes: [route] }).observe(query);
    expect(observations.map((entry) => entry.status === "unavailable" ? entry.reason : "available")).toEqual(["invalid_response", "invalid_response"]);
    expect(observations.map((entry) => entry.durationMinutes)).toEqual([null, null]);
  });

  it.each([
    undefined,
    [{ steps: [] }],
    [{ steps: [{ travelMode: "WALK" }, { travelMode: "TRANSIT" }] }],
    [{ steps: [{ travelMode: "DRIVE", staticDuration: "60s" }] }],
  ])("preserves unknown transit walking duration as a manual check: %j", async (legs) => {
    const observations = await providerWithResponse({ routes: [{ ...transitRoute, legs }] }).observe(query);
    expect(observations[1]).toMatchObject({ status: "available", durationMinutes: 31, walkingLegMinutes: null, manualChecks: ["walking_duration_unknown"] });
  });

  it("accepts known zero walking only when all steps are transit", async () => {
    const observations = await providerWithResponse({ routes: [{ ...transitRoute, legs: [{ steps: [{ travelMode: "TRANSIT" }] }] }] }).observe(query);
    expect(observations[1]).toMatchObject({ status: "available", walkingLegMinutes: [], manualChecks: [] });
  });

  it("returns missing location or credential without making a provider request", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    const noCredential = new GoogleRoutesProvider({ now: () => NOW, fetch });
    expect((await noCredential.observe(query)).map((entry) => entry.status === "unavailable" && entry.reason)).toEqual(["provider_not_configured", "provider_not_configured"]);
    const provider = new GoogleRoutesProvider({ apiKey: "test-only-key", now: () => NOW, fetch });
    expect((await provider.observe({ ...query, origin: { ...query.origin, latitude: null } })).map((entry) => entry.status === "unavailable" && entry.reason)).toEqual(["location_unknown", "location_unknown"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not replace an unsupported trip departure time with now", async () => {
    const provider = providerWithResponse({ routes: [{ duration: "60s", distanceMeters: 100 }] });
    const future = await provider.observe({ ...query, departureTime: "2027-10-02T00:00:00Z" });
    expect(future[0]).toMatchObject({ status: "available", requestedDepartureTime: "2027-10-02T00:00:00Z" });
    expect(future[1]).toMatchObject({ status: "unavailable", reason: "unsupported_departure_time", durationMinutes: null });
    const past = await provider.observe({ ...query, departureTime: "2026-09-30T00:00:00Z" });
    expect(past[0]).toMatchObject({ status: "unavailable", reason: "unsupported_departure_time" });
    expect(past[1]).toMatchObject({ status: "available", requestedDepartureTime: "2026-09-30T00:00:00Z" });
  });

  it.each(["2026-10-02T09:00:00", "2026-02-30T09:00:00Z", "not a date"])("rejects ambiguous or invalid instants before routing: %s", async (departureTime) => {
    await expect(providerWithResponse({}).observe({ ...query, departureTime })).rejects.toBeInstanceOf(TypeError);
  });

  it("reports actual abort deadlines as timeout rather than zero-duration routes", async () => {
    const provider = new GoogleRoutesProvider({
      apiKey: "test-only-key", now: () => NOW, timeoutMs: 10,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("secret transport detail")), { once: true });
      }),
    });
    const observations = await provider.observe(query);
    expect(observations.map((entry) => entry.status === "unavailable" ? entry.reason : "available")).toEqual(["timeout", "timeout"]);
    expect(observations.map((entry) => entry.durationMinutes)).toEqual([null, null]);
    expect(JSON.stringify(observations)).not.toContain("secret transport detail");
  });

  it("isolates network failure and binds results before callers edit the query", async () => {
    const input = structuredClone(query);
    const provider = new GoogleRoutesProvider({
      apiKey: "test-only-key", now: () => NOW,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        input.origin.placeId = "changed";
        input.destination.longitude = 0;
        if (body.travelMode === "TRANSIT") throw new Error("network failed");
        return Response.json({ routes: [{ duration: "61s", distanceMeters: 100 }] });
      },
    });
    const observations = await provider.observe(input);
    expect(observations[0]).toMatchObject({ originPlaceId: "origin", status: "available", durationMinutes: 2 });
    expect(observations[1]).toMatchObject({ originPlaceId: "origin", status: "unavailable", reason: "provider_unavailable" });
  });
});
