import { parseTransitGeoJson, type TransitGeoJson } from "@along-the-way/contracts/day-plans";
import { isRecord } from "@along-the-way/contracts/private-trips";
import type { GeoPoint } from "./day-route-order";

const HOST = "navitime-route-totalnavi.p.rapidapi.com";

export class NavitimeError extends Error {
  constructor(readonly code: "navitime_quota" | "navitime_unavailable") {
    super(code);
  }
}

/** HTTP only: no retries or logging. The day-plan module owns the seven-day DB cache. */
export class NavitimeProvider {
  readonly configured: boolean;
  private readonly apiKey: string;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly options: {
    apiKey?: string;
    consumeBudget: () => Promise<boolean>;
  }) {
    this.apiKey = options.apiKey?.trim() ?? "";
    this.configured = this.apiKey.length > 0;
  }

  private async request(path: "route_transit" | "shape_transit", from: GeoPoint, to: GeoPoint, date: string, signal: AbortSignal): Promise<unknown> {
    if (!this.configured || signal.aborted) throw new NavitimeError("navitime_unavailable");
    if (this.active >= 4) await new Promise<void>((resolve, reject) => {
      const acquire = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const index = this.waiting.indexOf(acquire);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new NavitimeError("navitime_unavailable"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.push(acquire);
    });
    else this.active += 1;
    try {
      signal.throwIfAborted();
      const reserved = await this.options.consumeBudget();
      signal.throwIfAborted();
      if (!reserved) throw new NavitimeError("navitime_quota");
      const url = new URL(`https://${HOST}/${path}`);
      url.search = new URLSearchParams({
        start: `${from.latitude},${from.longitude}`,
        goal: `${to.latitude},${to.longitude}`,
        start_time: `${date}T09:00:00`,
        limit: "1",
        ...(path === "shape_transit" ? {
          format: "geojson", options: "transport_shape", shape_color: "railway_line",
        } : {}),
      }).toString();
      const response = await fetch(url, {
        headers: { "x-rapidapi-host": HOST, "x-rapidapi-key": this.apiKey },
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
        cache: "no-store",
        redirect: "error",
      });
      if (response.status === 429) throw new NavitimeError("navitime_quota");
      if (!response.ok) throw new NavitimeError("navitime_unavailable");
      return await response.json();
    } catch (error) {
      throw error instanceof NavitimeError ? error : new NavitimeError("navitime_unavailable");
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }

  async transit(from: GeoPoint, to: GeoPoint, date: string, signal: AbortSignal): Promise<{ minutes: number; lines: string[] }> {
    const value = await this.request("route_transit", from, to, date, signal);
    const item = isRecord(value) && Array.isArray(value.items) ? value.items[0] : null;
    const move = isRecord(item) && isRecord(item.summary) && isRecord(item.summary.move) ? item.summary.move : null;
    if (!move || typeof move.time !== "number" || !Number.isSafeInteger(move.time) || move.time < 0
      || !isRecord(item) || !Array.isArray(item.sections)) throw new NavitimeError("navitime_unavailable");
    const lines: string[] = [];
    for (const section of item.sections) {
      if (!isRecord(section) || section.type !== "move" || section.move === "walk") continue;
      if (typeof section.move !== "string") throw new NavitimeError("navitime_unavailable");
      // Do not label a transit leg as walking just because a provider omits its line name.
      const name = typeof section.line_name === "string" && section.line_name.trim() ? section.line_name
        : typeof section.name === "string" && section.name.trim() ? section.name : "大眾運輸";
      if (lines.at(-1) !== name) lines.push(name);
    }
    return { minutes: move.time, lines };
  }

  async shape(from: GeoPoint, to: GeoPoint, date: string, signal: AbortSignal): Promise<TransitGeoJson> {
    const value = await this.request("shape_transit", from, to, date, signal);
    try {
      return parseTransitGeoJson(value);
    } catch {
      throw new NavitimeError("navitime_unavailable");
    }
  }
}

/** A 20-second batch deadline bounds HTTP latency; unfinished shapes retain their null defaults. */
export async function mapNavitimeLegs<T, R>(
  legs: readonly T[],
  work: (leg: T, signal: AbortSignal) => Promise<R>,
  unfinished?: (leg: T) => R,
): Promise<R[]> {
  const results: R[] = unfinished ? legs.map(unfinished) : new Array(legs.length);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, 20_000);
  });
  let index = 0;
  let failure: unknown;
  let failed = false;
  const workers = Promise.all(Array.from({ length: Math.min(4, legs.length) }, async () => {
    while (!failed && !controller.signal.aborted && index < legs.length) {
      const current = index++;
      try {
        const result = await work(legs[current]!, controller.signal);
        if (!controller.signal.aborted) results[current] = result;
      } catch (error) {
        failed = true;
        // A timeout/provider failure must never replace an already-observed quota refusal.
        if (!(failure instanceof NavitimeError && failure.code === "navitime_quota")) failure = error;
      }
    }
  }));
  await Promise.race([workers, deadline]);
  clearTimeout(timer!);
  if (failed) throw failure;
  if (controller.signal.aborted && !unfinished) throw new NavitimeError("navitime_unavailable");
  return results;
}
