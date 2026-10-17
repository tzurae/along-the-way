import { describe, expect, it, vi } from "vitest";
import type { RouteObservationQuery } from "@along-the-way/contracts/planning-observations";
import { NavitimeRoutesProvider } from "../src/planning/navitime-routes-provider";
import { legFor } from "../src/planning/travel-modes";

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
  return new NavitimeRoutesProvider({ keysForRequest: async () => ["test-only-key"], now: () => NOW,
  fetch: async () => Response.json(body, { status }), });
}

describe("NAVITIME route observation adapter", () => {
  it("turns missing user keys into a labelled estimate but keeps a confirmed no-route unknown", async () => {
    const fetch = vi.fn(async () => Response.json({ items: [] }));
    const provider = new NavitimeRoutesProvider({ keysForRequest: async () => [], now: () => NOW, fetch });
    const observations = await provider.observe(query);
    expect(observations[1]).toMatchObject({ status: "unavailable", reason: "provider_not_configured" });
    expect(fetch).not.toHaveBeenCalled();
    expect(legFor(observations, { fromName: "A", toName: "B" }, "transit", 15, 23)).toMatchObject({
      mode: "transit", durationMinutes: 23, estimated: true, transitMinutes: null,
      attribution: null, unavailableReason: "provider_not_configured",
    });
    const noRoute = await providerWithResponse({ items: [] }).observe(query);
    expect(legFor(noRoute, { fromName: "A", toName: "B" }, "transit", 15, 23)).toMatchObject({
      mode: null, durationMinutes: null, estimated: false, transitMinutes: null,
    });
    expect(legFor([...observations, ...noRoute], { fromName: "A", toName: "B" }, "transit", 15, 23).mode).toBeNull();
  });

  it("contains unexpected key-loading failures without fetching or exposing details", async () => {
    const fetch = vi.fn(async () => Response.json({ items: [route] }));
    const provider = new NavitimeRoutesProvider({
      keysForRequest: async () => { throw new Error("private credential details"); }, now: () => NOW, fetch,
    });
    const observations = await provider.observe(query);
    expect(observations[1]).toMatchObject({ status: "unavailable", reason: "provider_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(observations)).not.toContain("private credential details");
  });

  it.each([true, false])("never reuses a previous route answer, including no-route: %s", async (hasRoute) => {
    const fetch = vi.fn(async () => Response.json({ items: hasRoute ? [route] : [] }));
    const provider = new NavitimeRoutesProvider({ keysForRequest: async () => ["syntheticKeyA"], now: () => NOW, fetch });
    const first = await provider.observe(query);
    await provider.observe(query);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(first[1]?.expiresAt).toBe("2026-10-02T00:15:00.000Z");
  });

  it("skips a locally exhausted key and reserves the next key by hash", async () => {
    const hashes: string[] = [];
    const sent: string[] = [];
    const provider = new NavitimeRoutesProvider({
      keysForRequest: async () => ["syntheticKeyA", "syntheticKeyB"], now: () => NOW,
      consumeBudget: async (hash) => { hashes.push(hash); return hashes.length === 2; },
      fetch: async (_url, init) => {
        sent.push(new Headers(init?.headers).get("X-RapidAPI-Key")!);
        return Response.json({ items: [route] });
      },
    });
    expect((await provider.observe(query))[1]?.status).toBe("available");
    expect(sent).toEqual(["syntheticKeyB"]);
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).not.toBe(hashes[1]);
    expect(hashes.every((hash) => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
  });

  it.each([
    { body: "Monthly quota exceeded", resume: "2026-10-03T00:00:00Z" },
    { body: "Too many requests", resume: "2026-10-02T12:01:00Z" },
  ])("pauses only a refused key until $resume and tries the next key in order", async ({ body, resume }) => {
    let now = new Date("2026-10-02T12:00:00Z");
    const sent: string[] = [];
    const provider = new NavitimeRoutesProvider({
      keysForRequest: async () => ["syntheticKeyA", "syntheticKeyB"], now: () => now,
      fetch: async (_url, init) => {
        const key = new Headers(init?.headers).get("X-RapidAPI-Key")!;
        sent.push(key);
        return key === "syntheticKeyA" ? new Response(body, { status: 429 }) : Response.json({ items: [route] });
      },
    });
    expect((await provider.observe(query))[1]?.status).toBe("available");
    now = new Date(Date.parse(resume) - 1);
    expect((await provider.observe(query))[1]?.status).toBe("available");
    expect(sent).toEqual(["syntheticKeyA", "syntheticKeyB", "syntheticKeyB"]);
    now = new Date(resume);
    await provider.observe(query);
    expect(sent.slice(-2)).toEqual(["syntheticKeyA", "syntheticKeyB"]);
  });

  it.each(["Monthly quota exceeded", "Too many requests"])(
    "sends five parallel legs through one exhausted-key probe before using the good key: %s", async (body) => {
      const sent: string[] = [];
      const consumeBudget = vi.fn(async () => true);
      const provider = new NavitimeRoutesProvider({
        keysForRequest: async () => ["syntheticKeyA", "syntheticKeyB"], now: () => NOW, consumeBudget,
        fetch: async (_url, init) => {
          const key = new Headers(init?.headers).get("X-RapidAPI-Key")!;
          sent.push(key);
          return key === "syntheticKeyA" ? new Response(body, { status: 429 }) : Response.json({ items: [route] });
        },
      });
      const observations = await Promise.all(Array.from({ length: 5 }, () => provider.observe(query)));
      expect(observations.every((result) => result[1]?.status === "available")).toBe(true);
      expect(sent.filter((key) => key === "syntheticKeyA")).toHaveLength(1);
      expect(sent.filter((key) => key === "syntheticKeyB")).toHaveLength(5);
      expect(consumeBudget).toHaveBeenCalledTimes(6);
    },
  );

  it("starts all five fetches on a confirmed-good key before any resolves", async () => {
    const gate = Promise.withResolvers<void>();
    let holdResponses = false;
    const fetch = vi.fn(async () => {
      if (holdResponses) await gate.promise;
      return Response.json({ items: [route] });
    });
    const provider = new NavitimeRoutesProvider({
      keysForRequest: async () => ["syntheticKeyA"], now: () => NOW, fetch,
    });
    expect((await provider.observe(query))[1]?.status).toBe("available");
    fetch.mockClear();
    holdResponses = true;
    const pending = Promise.all(Array.from({ length: 5 }, () => provider.observe(query)));
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
    } finally {
      gate.resolve();
      await pending;
    }
    expect((await pending).every((result) => result[1]?.status === "available")).toBe(true);
  });

  it("requires a new single-flight probe after a confirmed key is paused and resumes", async () => {
    let now = NOW;
    let exhausted = false;
    const fetch = vi.fn(async () => exhausted
      ? new Response("Too many requests", { status: 429 })
      : Response.json({ items: [route] }));
    const provider = new NavitimeRoutesProvider({
      keysForRequest: async () => ["syntheticKeyA"], now: () => now, fetch,
    });
    expect((await provider.observe(query))[1]?.status).toBe("available");
    exhausted = true;
    expect((await provider.observe(query))[1]).toMatchObject({ reason: "quota" });
    fetch.mockClear();
    now = new Date(NOW.getTime() + 60_000);
    const observations = await Promise.all(Array.from({ length: 5 }, () => provider.observe(query)));
    for (const result of observations) expect(result[1]).toMatchObject({ status: "unavailable", reason: "quota" });
    expect(fetch).toHaveBeenCalledTimes(1);
    exhausted = false;
    now = new Date(now.getTime() + 60_000);
    expect((await provider.observe(query))[1]?.status).toBe("available");
  });

  it("does not let a pre-pause success confirm the key again after the pause", async () => {
    let now = NOW;
    const oldResponse = Promise.withResolvers<Response>();
    const oldRequestStarted = Promise.withResolvers<void>();
    let requestNumber = 0;
    const fetch = vi.fn(async () => {
      requestNumber += 1;
      if (requestNumber === 1) return Response.json({ items: [route] });
      if (requestNumber === 2) {
        oldRequestStarted.resolve();
        return oldResponse.promise;
      }
      return new Response("Too many requests", { status: 429 });
    });
    const provider = new NavitimeRoutesProvider({
      keysForRequest: async () => ["syntheticKeyA"], now: () => now, fetch,
    });
    await provider.observe(query);
    const oldRequest = provider.observe(query);
    await oldRequestStarted.promise;
    expect((await provider.observe(query))[1]).toMatchObject({ reason: "quota" });
    now = new Date(NOW.getTime() + 60_000);
    oldResponse.resolve(Response.json({ items: [route] }));
    expect((await oldRequest)[1]?.status).toBe("available");
    fetch.mockClear();
    const observations = await Promise.all(Array.from({ length: 5 }, () => provider.observe(query)));
    for (const result of observations) expect(result[1]).toMatchObject({ reason: "quota" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("resumes a quota pause at UTC midnight even when refused less than a minute before", async () => {
    let now = new Date("2026-10-02T23:59:59Z");
    const fetch = vi.fn(async () => new Response("Monthly quota exceeded", { status: 429 }));
    const provider = new NavitimeRoutesProvider({
      keysForRequest: async () => ["syntheticKeyA"], now: () => now, fetch,
    });
    await provider.observe(query);
    now = new Date("2026-10-03T00:00:00Z");
    await provider.observe(query);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["fetch", "budget"])("releases an unconfirmed probe when %s rejects", async (failure) => {
    let first = true;
    const failOnce = () => {
      if (!first) return;
      first = false;
      throw new Error("private request failure");
    };
    const provider = new NavitimeRoutesProvider({
      keysForRequest: async () => ["syntheticKeyA"], now: () => NOW,
      consumeBudget: async () => { if (failure === "budget") failOnce(); return true; },
      fetch: async () => {
        if (failure === "fetch") failOnce();
        return Response.json({ items: [route] });
      },
    });
    const observations = await Promise.all(Array.from({ length: 5 }, () => provider.observe(query)));
    expect(observations[0]?.[1]).toMatchObject({ status: "unavailable", reason: "provider_unavailable" });
    expect(observations.slice(1).every((result) => result[1]?.status === "available")).toBe(true);
  });

  it("returns quota without outbound requests while all keys are paused", async () => {
    const fetch = vi.fn(async () => new Response("Quota exceeded", { status: 429 }));
    const provider = new NavitimeRoutesProvider({
      keysForRequest: async () => ["syntheticKeyA", "syntheticKeyB"], now: () => NOW, fetch,
    });
    await provider.observe(query);
    expect((await provider.observe(query))[1]).toMatchObject({ status: "unavailable", reason: "quota" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

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

  it("does not fetch when the requested modes exclude transit", async () => {
    const fetch = vi.fn(async () => Response.json({ items: [route] }));
    const provider = new NavitimeRoutesProvider({ keysForRequest: async () => ["test-only-key"], now: () => NOW, fetch, });

    await expect(provider.observe({ ...query, modes: ["walking", "drive"] })).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not fetch NAVITIME unless both endpoints are in Japan", async () => {
    const fetch = vi.fn(async () => Response.json({ items: [route] }));
    const provider = new NavitimeRoutesProvider({ keysForRequest: async () => ["test-only-key"], now: () => NOW, fetch, });

    const observations = await provider.observe({
      ...query,
      origin: { ...query.origin, latitude: 25.04, longitude: 121.56 },
    });

    expect(observations[1]).toMatchObject({ status: "unavailable", reason: "unsupported_mode" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns quota without fetching when the daily NAVITIME budget is exhausted", async () => {
    const fetch = vi.fn(async () => Response.json({ items: [route] }));
    const provider = new NavitimeRoutesProvider({ keysForRequest: async () => ["test-only-key"], now: () => NOW, fetch,
    consumeBudget: async () => false, });

    const observations = await provider.observe(query);

    expect(observations[1]).toMatchObject({ status: "unavailable", reason: "quota" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("includes time waiting before the provider route actually starts", async () => {
    const delayed = { ...route, summary: { move: {
      ...route.summary.move, from_time: "2026-10-04T09:05:00+09:00", to_time: "2026-10-04T09:36:00+09:00",
    } } };
    expect((await providerWithResponse({ items: [delayed] }).observe(query))[1])
      .toMatchObject({ status: "available", durationMinutes: 36 });
  });

  it("converts an offset-bearing departure across the Japan date boundary", async () => {
    const provider = new NavitimeRoutesProvider({ keysForRequest: async () => ["test-only-key"], now: () => NOW,
    fetch: async (input) => {
      if (new URL(String(input)).searchParams.get("start_time") !== "2026-10-04T15:30:00") {
        return Response.json({}, { status: 400 });
      }
      return Response.json({ items: [{ ...route, summary: { move: {
        ...route.summary.move, from_time: "2026-10-04T15:30:00+09:00", to_time: "2026-10-04T16:01:00+09:00",
      } } }] });
    }, });
    expect((await provider.observe({ ...query, departureTime: "2026-10-03T23:30:00-07:00" }))[1])
      .toMatchObject({ status: "available", durationMinutes: 31, requestedDepartureTime: "2026-10-04T06:30:00Z" });
  });

  it("does not lose a positive nanosecond when request precision advances departure", async () => {
    const provider = new NavitimeRoutesProvider({ keysForRequest: async () => ["test-only-key"], now: () => NOW,
    fetch: async (input) => {
      if (new URL(String(input)).searchParams.get("start_time") !== "2026-10-04T09:00:01") {
        return Response.json({}, { status: 400 });
      }
      return Response.json({ items: [{ ...route, summary: { move: {
        ...route.summary.move, from_time: "2026-10-04T09:00:01+09:00", to_time: "2026-10-04T09:31:01+09:00",
      } } }] });
    }, });
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
    const provider = new NavitimeRoutesProvider({ keysForRequest: async () => ["test-only-key"], now: () => NOW,
    fetch: async () => new Response("<html>private details</html>"), });
    const result = await provider.observe(query);
    expect(result[1]).toMatchObject({ status: "unavailable", reason: "invalid_response", durationMinutes: null });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("does not replace unknown locations or credentials with invented routes", async () => {
    const fetch = async () => { throw new Error("A network attempt cannot supply the missing fact"); };
    const provider = new NavitimeRoutesProvider({ keysForRequest: async () => ["test-only-key"], now: () => NOW, fetch });
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
    const provider = new NavitimeRoutesProvider({ keysForRequest: async () => ["test-only-key"], now: () => NOW,
    fetch: async () => {
      input.origin.placeId = "changed";
      input.destination.placeId = "changed";
      input.departureTime = "2027-01-01T00:00:00Z";
      return Response.json({ items: [route] });
    }, });
    expect((await provider.observe(input))[1]).toMatchObject({
      status: "available", originPlaceId: "origin", destinationPlaceId: "destination",
      requestedDepartureTime: "2026-10-04T00:00:00Z", durationMinutes: 31,
    });
  });

  it("turns an actual abort deadline into timeout, not a zero-minute route", async () => {
    const provider = new NavitimeRoutesProvider({ keysForRequest: async () => ["test-only-key"], now: () => NOW, timeoutMs: 10,
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("private timeout")), { once: true });
    }), });
    const result = await provider.observe(query);
    expect(result[1]).toMatchObject({ status: "unavailable", reason: "timeout", durationMinutes: null });
    expect(JSON.stringify(result)).not.toContain("private timeout");
  });
});
