import type { TransitGeoJson } from "@along-the-way/contracts/day-plans";
import { sql, type Kysely } from "kysely";
import type { AlongTheWayDatabase } from "../database/database";
import type { GeoPoint } from "./day-route-order";

export const TRANSIT_CACHE_DAYS = 7;
const MAX_AGE_MS = TRANSIT_CACHE_DAYS * 24 * 60 * 60 * 1_000;
const KEY_COLUMNS = ["trip_id", "travel_date", "from_lat", "from_lon", "to_lat", "to_lon"] as const;

/** Match PostgreSQL numeric(9,6), including normalization of negative zero. */
export function transitLegKey(from: GeoPoint, to: GeoPoint) {
  return [from.latitude, from.longitude, to.latitude, to.longitude]
    .map((coordinate) => Number(coordinate.toFixed(6))).join(":");
}

function coordinates(from: GeoPoint, to: GeoPoint) {
  return {
    from_lat: from.latitude.toFixed(6), from_lon: from.longitude.toFixed(6),
    to_lat: to.latitude.toFixed(6), to_lon: to.longitude.toFixed(6),
  };
}

/** Trip-scoped cache approved by the owner; minute and shape freshness never refresh each other. */
export class PostgresTransitLegCache {
  constructor(private readonly database: Kysely<AlongTheWayDatabase>) {}

  async minutes(tripId: string, date: string) {
    const rows = await this.database.selectFrom("transit_leg_cache")
      .select(["from_lat", "from_lon", "to_lat", "to_lon", "minutes", "lines"])
      .where("trip_id", "=", tripId).where("travel_date", "=", sql<Date>`${date}::date`)
      .where("minutes_fetched_at", ">", new Date(Date.now() - MAX_AGE_MS))
      .where("minutes", "is not", null).execute();
    const result = new Map<string, { minutes: number; lines: string[] }>();
    for (const row of rows) {
      const key = [row.from_lat, row.from_lon, row.to_lat, row.to_lon].map(Number).join(":");
      result.set(key, { minutes: row.minutes!, lines: row.lines });
    }
    return result;
  }

  async shapes(tripId: string, date: string) {
    const rows = await this.database.selectFrom("transit_leg_cache")
      .select(["from_lat", "from_lon", "to_lat", "to_lon", "shape_geojson"])
      .where("trip_id", "=", tripId).where("travel_date", "=", sql<Date>`${date}::date`)
      .where("shape_fetched_at", ">", new Date(Date.now() - MAX_AGE_MS))
      .where("shape_geojson", "is not", null).execute();
    const result = new Map<string, TransitGeoJson>();
    for (const row of rows) {
      const key = [row.from_lat, row.from_lon, row.to_lat, row.to_lon].map(Number).join(":");
      result.set(key, row.shape_geojson!);
    }
    return result;
  }

  async saveMinutes(tripId: string, date: string, from: GeoPoint, to: GeoPoint, value: { minutes: number; lines: string[] }) {
    const minutes = { minutes: value.minutes, lines: JSON.stringify(value.lines), minutes_fetched_at: new Date() };
    await this.database.insertInto("transit_leg_cache").values({
      trip_id: tripId, travel_date: date, ...coordinates(from, to), ...minutes,
      shape_geojson: null, shape_fetched_at: null,
    }).onConflict((conflict) => conflict.columns(KEY_COLUMNS).doUpdateSet(minutes)).execute();
  }

  async saveShape(tripId: string, date: string, from: GeoPoint, to: GeoPoint, geojson: TransitGeoJson) {
    const shape = { shape_geojson: JSON.stringify(geojson), shape_fetched_at: new Date() };
    await this.database.insertInto("transit_leg_cache").values({
      trip_id: tripId, travel_date: date, ...coordinates(from, to), ...shape,
      minutes: null, lines: "[]", minutes_fetched_at: null,
    }).onConflict((conflict) => conflict.columns(KEY_COLUMNS).doUpdateSet(shape)).execute();
  }
}
