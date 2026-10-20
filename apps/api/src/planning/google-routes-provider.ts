import { Temporal } from "@js-temporal/polyfill";
import type { TransitGeoJson, TransitMatrixEntry } from "@along-the-way/contracts/day-plans";
import { isRecord } from "@along-the-way/contracts/private-trips";
import type { PaidProviderReservation } from "../private-trips/postgres-rate-limiter";
import type { GeoPoint } from "./day-route-order";
import { mapTransitLegs, TransitError } from "./transit-batch";

const MAX_TRANSIT_ELEMENTS = 100;
const MATRIX_FIELDS = "originIndex,destinationIndex,status,condition,duration";
const SHAPE_FIELDS = [
  "routes.legs.steps.polyline.encodedPolyline",
  "routes.legs.steps.travelMode",
  "routes.legs.steps.transitDetails.transitLine.color",
].join(",");

/** Google encoded polylines are latitude/longitude deltas at 1e-5; GeoJSON is longitude first. */
function decodePolyline(encoded: string): [number, number][] {
  const coordinates: [number, number][] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  const delta = () => {
    let value = 0;
    let factor = 1;
    for (let group = 0; group < 7 && index < encoded.length; group += 1) {
      const byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) throw new TransitError("transit_unavailable");
      value += (byte & 31) * factor;
      if (byte < 32) return value % 2 === 1 ? -(value + 1) / 2 : value / 2;
      factor *= 32;
    }
    throw new TransitError("transit_unavailable");
  };
  while (index < encoded.length) {
    latitude += delta();
    longitude += delta();
    if (Math.abs(latitude) > 90e5 || Math.abs(longitude) > 180e5) throw new TransitError("transit_unavailable");
    coordinates.push([longitude / 1e5, latitude / 1e5]);
  }
  return coordinates;
}

/** HTTP only. No response cache, logging, persistence or retries. */
export class GoogleRoutesProvider {
  readonly configured: boolean;
  private readonly apiKey: string;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly options: {
    apiKey?: string;
    reserveBudget: (elements: number) => Promise<PaidProviderReservation | null>;
  }) {
    this.apiKey = options.apiKey?.trim() ?? "";
    this.configured = this.apiKey.length > 0;
  }

  private async request(
    path: "distanceMatrix/v2:computeRouteMatrix" | "directions/v2:computeRoutes",
    body: Record<string, unknown>, fields: string, cost: number, signal: AbortSignal,
  ): Promise<unknown> {
    if (!this.configured || signal.aborted) throw new TransitError("transit_unavailable");
    if (this.active >= 4) await new Promise<void>((resolve, reject) => {
      const acquire = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const index = this.waiting.indexOf(acquire);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new TransitError("transit_unavailable"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.push(acquire);
    });
    else this.active += 1;
    let reservation: PaidProviderReservation | null = null;
    let sent = false;
    try {
      signal.throwIfAborted();
      reservation = await this.options.reserveBudget(cost);
      signal.throwIfAborted();
      if (!reservation) throw new TransitError("transit_quota");
      const request: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey,
          "X-Goog-FieldMask": fields,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
        cache: "no-store",
        redirect: "error",
      };
      signal.throwIfAborted();
      sent = true;
      const response = await fetch(`https://routes.googleapis.com/${path}`, request);
      if (response.status === 429) throw new TransitError("transit_quota");
      if (!response.ok) throw new TransitError("transit_unavailable");
      return await response.json();
    } catch (error) {
      throw error instanceof TransitError ? error : new TransitError("transit_unavailable");
    } finally {
      try {
        if (reservation && !sent) await reservation.refund();
      } finally {
        const next = this.waiting.shift();
        if (next) next();
        else this.active -= 1;
      }
    }
  }

  async matrix(pairs: readonly { from: GeoPoint; to: GeoPoint }[], date: string, timeZone: string | null): Promise<TransitMatrixEntry[]> {
    if (!timeZone) throw new TransitError("transit_unavailable");
    const departureTime = Temporal.PlainDate.from(date).toZonedDateTime({ timeZone, plainTime: "09:00" }).toInstant().toString();
    const rows = new Map<string, { from: GeoPoint; destinations: GeoPoint[] }>();
    for (const { from, to } of pairs) {
      let row = rows.get(from.id);
      if (!row) {
        row = { from, destinations: [] };
        rows.set(from.id, row);
      }
      row.destinations.push(to);
    }
    // One origin per batch avoids buying unused self/anchor elements in a rectangular matrix.
    const batches: { from: GeoPoint; destinations: GeoPoint[] }[] = [];
    for (const row of rows.values()) {
      for (let start = 0; start < row.destinations.length; start += MAX_TRANSIT_ELEMENTS) {
        batches.push({ from: row.from, destinations: row.destinations.slice(start, start + MAX_TRANSIT_ELEMENTS) });
      }
    }
    const results = await mapTransitLegs(batches, async ({ from, destinations }, signal) => {
      const value = await this.request("distanceMatrix/v2:computeRouteMatrix", {
        origins: [{ waypoint: { location: { latLng: { latitude: from.latitude, longitude: from.longitude } } } }],
        destinations: destinations.map((to) => ({ waypoint: { location: { latLng: { latitude: to.latitude, longitude: to.longitude } } } })),
        travelMode: "TRANSIT", departureTime, languageCode: "zh-TW",
      }, MATRIX_FIELDS, destinations.length, signal);
      if (!Array.isArray(value) || value.length !== destinations.length) throw new TransitError("transit_unavailable");
      const seen = new Set<number>();
      return value.map((element): TransitMatrixEntry => {
        if (!isRecord(element)) throw new TransitError("transit_unavailable");
        // Protobuf JSON may omit zero-valued indices and status.code.
        const originIndex = element.originIndex ?? 0;
        const destinationIndex = element.destinationIndex ?? 0;
        const status = isRecord(element.status) ? element.status.code ?? 0 : null;
        if (status === 8) throw new TransitError("transit_quota");
        if (status !== 0 || element.condition !== "ROUTE_EXISTS" || originIndex !== 0
          || typeof destinationIndex !== "number" || !Number.isSafeInteger(destinationIndex)
          || destinationIndex < 0 || destinationIndex >= destinations.length || seen.has(destinationIndex)
          || typeof element.duration !== "string" || !/^\d+(?:\.\d{1,9})?s$/.test(element.duration)) {
          throw new TransitError("transit_unavailable");
        }
        seen.add(destinationIndex);
        const minutes = Math.ceil(Number(element.duration.slice(0, -1)) / 60);
        if (!Number.isSafeInteger(minutes)) throw new TransitError("transit_unavailable");
        const to = destinations[destinationIndex]!;
        return {
          fromId: from.id, toId: to.id,
          fromLatitude: from.latitude, fromLongitude: from.longitude,
          toLatitude: to.latitude, toLongitude: to.longitude,
          // Matrix responses contain durations, not modes or line names; never claim walk-only.
          minutes, lines: ["大眾運輸／步行"],
        };
      });
    });
    return results.flat();
  }

  async shape(from: GeoPoint, to: GeoPoint, date: string, timeZone: string | null, signal: AbortSignal): Promise<TransitGeoJson | null> {
    if (!timeZone) throw new TransitError("transit_unavailable");
    const departureTime = Temporal.PlainDate.from(date).toZonedDateTime({ timeZone, plainTime: "09:00" }).toInstant().toString();
    const value = await this.request("directions/v2:computeRoutes", {
      origin: { location: { latLng: { latitude: from.latitude, longitude: from.longitude } } },
      destination: { location: { latLng: { latitude: to.latitude, longitude: to.longitude } } },
      travelMode: "TRANSIT", departureTime, languageCode: "zh-TW", polylineEncoding: "ENCODED_POLYLINE",
    }, SHAPE_FIELDS, 1, signal);
    if (!isRecord(value)) throw new TransitError("transit_unavailable");
    if (value.routes === undefined || (Array.isArray(value.routes) && value.routes.length === 0)) return null;
    const route = Array.isArray(value.routes) ? value.routes[0] : null;
    if (!isRecord(route) || !Array.isArray(route.legs)) throw new TransitError("transit_unavailable");
    const features: TransitGeoJson["features"] = [];
    for (const leg of route.legs) {
      if (!isRecord(leg) || !Array.isArray(leg.steps)) throw new TransitError("transit_unavailable");
      for (const step of leg.steps) {
        if (!isRecord(step) || (step.travelMode !== "WALK" && step.travelMode !== "TRANSIT")
          || !isRecord(step.polyline) || typeof step.polyline.encodedPolyline !== "string") {
          throw new TransitError("transit_unavailable");
        }
        const coordinates = decodePolyline(step.polyline.encodedPolyline);
        if (coordinates.length < 2) continue;
        const line = isRecord(step.transitDetails) && isRecord(step.transitDetails.transitLine)
          ? step.transitDetails.transitLine : null;
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates },
          properties: {
            ways: step.travelMode === "WALK" ? "walk" : "transport",
            inline: { color: typeof line?.color === "string" && /^#[0-9a-f]{6}$/i.test(line.color) ? line.color : null },
          },
        });
      }
    }
    return features.length > 0 ? { type: "FeatureCollection", features } : null;
  }
}
