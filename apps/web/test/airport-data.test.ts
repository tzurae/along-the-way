import { describe, expect, it } from "vitest";

import airports, { AIRPORT_DATA_COMMIT } from "../src/airport-data.generated";
import { searchAirports } from "../src/airport-data";

describe("pinned airport data", () => {
  it("is generated from the reviewed pinned upstream commit", () => {
    expect(AIRPORT_DATA_COMMIT).toBe("47ae282a8491758e6dafe28d4139539e561b54d5");
  });

  it("contains unique valid IATA rows with finite coordinates and IANA zones", () => {
    expect(airports.length).toBe(7_884);
    const codes = new Set<string>();
    const zones = new Set<string>();
    const invalidRows: string[] = [];
    for (const [code, name, , , latitude, longitude, timeZone] of airports) {
      if (!/^[A-Z]{3}$/.test(code) || codes.has(code) || !name.trim()
        || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
        || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        invalidRows.push(code);
      }
      codes.add(code);
      zones.add(timeZone);
    }
    expect(invalidRows).toEqual([]);
    const invalidZones = [...zones].filter((timeZone) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone }).format(0);
        return false;
      } catch {
        return true;
      }
    });
    expect(invalidZones).toEqual([]);
  });

  it.each([
    ["TPE", "TPE", "Asia/Taipei"],
    ["Taipei Taoyuan International Airport", "TPE", "Asia/Taipei"],
    ["KIX", "KIX", "Asia/Tokyo"],
  ])("finds %s by code, English name, or city", (query, code, zone) => {
    const result = searchAirports(airports, query);
    expect(result[0]?.[0]).toBe(code);
    expect(result[0]?.[6]).toBe(zone);
    expect(result[0]?.[4]).toEqual(expect.any(Number));
    expect(result[0]?.[5]).toEqual(expect.any(Number));
  });
});
