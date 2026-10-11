import { describe, expect, it } from "vitest";
import type { RouteObservationQuery } from "@along-the-way/contracts/planning-observations";
import { NavitimeRoutesProvider } from "../src/planning/navitime-routes-provider";

const NOW = new Date("2026-10-02T00:00:00Z");
const query: RouteObservationQuery = {
  origin: { placeId: "origin", latitude: 34.9858, longitude: 135.7588 },
  destination: { placeId: "destination", latitude: 34.9671, longitude: 135.7727 },
  departureTime: "2026-10-04T09:00:00+09:00",
};

// Synthetic response built from the documented schema, not a captured API payload.
const route = {
  summary: { move: {
    type: "move", time: 31, distance: 4000, move_type: ["local_train", "walk"],
    from_time: "2026-10-04T09:00:00+09:00", to_time: "2026-10-04T09:31:00+09:00",
  } },
  sections: [
    { type: "move", move: "walk", time: 6 },
    { type: "move", move: "local_train", time: 7 },
    { type: "move", move: "walk", time: 8 },
  ],
};

function providerWithResponse(body: unknown, status = 200) {
  return new NavitimeRoutesProvider({
    apiKey: "test-only-key", now: () => NOW,
    fetch: async () => Response.json(body, { status }),
  });
}

describe("NAVITIME route observation adapter", () => {
  it("retains total elapsed time rather than summing sections and marks average travel times", async () => {
    const observations = await providerWithResponse({ items: [route] }).observe(query);
    expect(observations[0]).toMatchObject({
      mode: "walking", status: "unavailable", reason: "unsupported_mode",
      durationMinutes: null, distanceMeters: null,
    });
    expect(observations[1]).toMatchObject({
      mode: "transit", status: "available", durationMinutes: 31, distanceMeters: 4000,
      originPlaceId: "origin", destinationPlaceId: "destination",
      requestedDepartureTime: "2026-10-04T00:00:00Z", provider: "navitime", attribution: "NAVITIME",
      walkingLegMinutes: null,
      manualChecks: ["transit_duration_estimated", "walking_duration_unknown"],
    });
  });

  it("includes time waiting before the provider route actually starts", async () => {
    const delayed = { ...route, summary: { move: {
      ...route.summary.move, from_time: "2026-10-04T09:05:00+09:00", to_time: "2026-10-04T09:36:00+09:00",
    } } };
    expect((await providerWithResponse({ items: [delayed] }).observe(query))[1])
      .toMatchObject({ status: "available", durationMinutes: 36 });
  });

  it("converts an offset-bearing departure across the Japan date boundary", async () => {
    const provider = new NavitimeRoutesProvider({
      apiKey: "test-only-key", now: () => NOW,
      fetch: async (input) => {
        if (new URL(String(input)).searchParams.get("start_time") !== "2026-10-04T15:30:00") {
          return Response.json({}, { status: 400 });
        }
        return Response.json({ items: [{ ...route, summary: { move: {
          ...route.summary.move, from_time: "2026-10-04T15:30:00+09:00", to_time: "2026-10-04T16:01:00+09:00",
        } } }] });
      },
    });
    expect((await provider.observe({ ...query, departureTime: "2026-10-03T23:30:00-07:00" }))[1])
      .toMatchObject({ status: "available", durationMinutes: 31, requestedDepartureTime: "2026-10-04T06:30:00Z" });
  });

  it("does not lose a positive nanosecond when request precision advances departure", async () => {
    const provider = new NavitimeRoutesProvider({
      apiKey: "test-only-key", now: () => NOW,
      fetch: async (input) => {
        if (new URL(String(input)).searchParams.get("start_time") !== "2026-10-04T09:00:01") {
          return Response.json({}, { status: 400 });
        }
        return Response.json({ items: [{ ...route, summary: { move: {
          ...route.summary.move, from_time: "2026-10-04T09:00:01+09:00", to_time: "2026-10-04T09:31:01+09:00",
        } } }] });
      },
    });
    expect((await provider.observe({ ...query, departureTime: "2026-10-04T09:00:00.000000001+09:00" }))[1])
      .toMatchObject({ status: "available", durationMinutes: 32 });
  });

  it("rounds fractional provider minutes up rather than understating travel", async () => {
    const fractional = { ...route, summary: { move: { ...route.summary.move, time: 31.01 } } };
    expect((await providerWithResponse({ items: [fractional] }).observe(query))[1])
      .toMatchObject({ status: "available", durationMinutes: 32 });
  });

  it("accepts the published plural mode field without exposing provider shape", async () => {
    const { move_type: modes, ...move } = route.summary.move;
    const published = { ...route, summary: { move: { ...move, move_types: modes } } };
    expect((await providerWithResponse({ items: [published] }).observe(query))[1])
      .toMatchObject({ status: "available", durationMinutes: 31 });
  });

  it("keeps absent walking detail unknown instead of manufacturing safe walking legs", async () => {
    const { sections: _sections, ...withoutSections } = route;
    expect((await providerWithResponse({ items: [withoutSections] }).observe(query))[1]).toMatchObject({
      status: "available", durationMinutes: 31, walkingLegMinutes: null,
      manualChecks: ["transit_duration_estimated", "walking_duration_unknown"],
    });
  });

  it("does not describe a walking-only result as a public transit route", async () => {
    const walkingOnly = { ...route, summary: { move: { ...route.summary.move, move_type: ["walk"] } } };
    expect((await providerWithResponse({ items: [walkingOnly] }).observe(query))[1])
      .toMatchObject({ status: "unavailable", reason: "no_route", durationMinutes: null });
  });

  it("retains no-route without substituting zero minutes", async () => {
    expect((await providerWithResponse({ items: [] }).observe(query))[1])
      .toMatchObject({ status: "unavailable", reason: "no_route", durationMinutes: null, distanceMeters: null });
  });

  it.each([
    { time: -1 }, { time: "31" }, { time: Number.MAX_SAFE_INTEGER + 1 },
    { distance: null }, { distance: 1.5 },
    { move_type: ["unknown"] }, { move_type: ["car"] }, { move_type: ["constructor"] },
    { from_time: "2026-10-04T08:59:00+09:00" },
    { to_time: "2026-10-04T08:58:00+09:00" }, { to_time: "not a date" },
  ])("rejects corrupt or mismatched route facts instead of claiming feasibility: %j", async (change) => {
    const corrupt = { ...route, summary: { move: { ...route.summary.move, ...change } } };
    expect((await providerWithResponse({ items: [corrupt] }).observe(query))[1])
      .toMatchObject({ status: "unavailable", reason: "invalid_response", durationMinutes: null, distanceMeters: null });
  });

  it.each([null, {}, { items: [null] }, { items: [{ summary: {} }] }])
    ("rejects missing route summaries without manufacturing facts: %j", async (body) => {
      expect((await providerWithResponse(body).observe(query))[1])
        .toMatchObject({ status: "unavailable", reason: "invalid_response", durationMinutes: null });
    });

  it.each([[429, "quota"], [403, "provider_unavailable"], [500, "provider_unavailable"]] as const)
    ("keeps HTTP %i structured and hides provider response details", async (status, reason) => {
      const result = await providerWithResponse({ message: "private test-only-key details" }, status).observe(query);
      expect(result[1]).toMatchObject({ status: "unavailable", reason, durationMinutes: null });
      expect(JSON.stringify(result)).not.toContain("test-only-key");
      expect(JSON.stringify(result)).not.toContain("private");
    });

  it("rejects malformed JSON without returning HTML or provider details", async () => {
    const provider = new NavitimeRoutesProvider({
      apiKey: "test-only-key", now: () => NOW,
      fetch: async () => new Response("<html>private details</html>"),
    });
    const result = await provider.observe(query);
    expect(result[1]).toMatchObject({ status: "unavailable", reason: "invalid_response", durationMinutes: null });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("does not replace unknown locations or credentials with invented routes", async () => {
    const fetch = async () => { throw new Error("A network attempt cannot supply the missing fact"); };
    const provider = new NavitimeRoutesProvider({ apiKey: "test-only-key", now: () => NOW, fetch });
    expect((await provider.observe({ ...query, origin: { ...query.origin, latitude: null } }))[1])
      .toMatchObject({ status: "unavailable", reason: "location_unknown", durationMinutes: null });
    expect((await new NavitimeRoutesProvider({ now: () => NOW, fetch }).observe(query))[1])
      .toMatchObject({ status: "unavailable", reason: "provider_not_configured", durationMinutes: null });
  });

  it.each(["2026-10-04T09:00:00", "2026-02-30T09:00:00Z"])
    ("rejects ambiguous or impossible departure times: %s", async (departureTime) => {
      await expect(providerWithResponse({ items: [route] }).observe({ ...query, departureTime }))
        .rejects.toBeInstanceOf(TypeError);
    });

  it.each([91, Number.NaN])("rejects invalid coordinates before interpreting routes: %s", async (latitude) => {
    await expect(providerWithResponse({ items: [route] }).observe({ ...query, origin: { ...query.origin, latitude } }))
      .rejects.toBeInstanceOf(TypeError);
  });

  it("retains original endpoints and departure when the caller edits the query during fetch", async () => {
    const input = structuredClone(query);
    const provider = new NavitimeRoutesProvider({
      apiKey: "test-only-key", now: () => NOW,
      fetch: async () => {
        input.origin.placeId = "changed";
        input.destination.placeId = "changed";
        input.departureTime = "2027-01-01T00:00:00Z";
        return Response.json({ items: [route] });
      },
    });
    expect((await provider.observe(input))[1]).toMatchObject({
      status: "available", originPlaceId: "origin", destinationPlaceId: "destination",
      requestedDepartureTime: "2026-10-04T00:00:00Z", durationMinutes: 31,
    });
  });

  it("turns an actual abort deadline into timeout, not a zero-minute route", async () => {
    const provider = new NavitimeRoutesProvider({
      apiKey: "test-only-key", now: () => NOW, timeoutMs: 10,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("private timeout")), { once: true });
      }),
    });
    const result = await provider.observe(query);
    expect(result[1]).toMatchObject({ status: "unavailable", reason: "timeout", durationMinutes: null });
    expect(JSON.stringify(result)).not.toContain("private timeout");
  });
});
