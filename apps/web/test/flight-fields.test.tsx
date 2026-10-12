// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { TripFlightInput } from "@along-the-way/contracts/private-trips";

import { airportInput, searchAirports } from "../src/airport-data";
import airports from "../src/airport-data.generated";
import { ambiguousUtcOffsets, FlightFields, flightComplete } from "../src/FlightFields";

function completeFlight(overrides: Partial<TripFlightInput> = {}): TripFlightInput {
  return {
    serviceNumber: "",
    carrier: null,
    departureAirport: airportInput(searchAirports(airports, "TPE")[0]!),
    arrivalAirport: airportInput(searchAirports(airports, "KIX")[0]!),
    departureLocalDateTime: "2026-10-21T09:00",
    arrivalLocalDateTime: "2026-10-21T13:00",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("simplified flight fields", () => {
  it("derives zone and coordinates from an airport result and needs no flight number", () => {
    const taipei = airportInput(searchAirports(airports, "Taipei Taoyuan International Airport")[0]!);
    expect(taipei).toMatchObject({
      name: expect.stringMatching(/^TPE ·/),
      timeZone: "Asia/Taipei",
      latitude: 25.0777,
      longitude: 121.233,
    });
    expect(flightComplete(completeFlight({ departureAirport: taipei }))).toBe(true);
  });

  it("keeps optional and advanced fields closed by default", () => {
    render(<FlightFields legend="去程" value={completeFlight()} onChange={() => {}} />);
    const optional = screen.getByText("航班資訊（選填）").closest("details");
    const advanced = screen.getByText("進階設定").closest("details");
    expect(optional).not.toHaveAttribute("open");
    expect(advanced).not.toHaveAttribute("open");
    expect(screen.getAllByText(/自機場推定/)).toHaveLength(2);
  });

  it("reveals and requires a choice only for a repeated local hour", () => {
    expect(ambiguousUtcOffsets("2026-11-01T01:30", "America/New_York")).toEqual(["-04:00", "-05:00"]);
    expect(ambiguousUtcOffsets("2026-11-01T03:30", "America/New_York")).toEqual([]);

    const repeated = completeFlight({
      departureAirport: { name: "JFK · John F Kennedy International Airport", timeZone: "America/New_York" },
      departureLocalDateTime: "2026-11-01T01:30",
    });
    const { rerender } = render(<FlightFields legend="去程" value={repeated} onChange={() => {}} />);
    expect(screen.getByLabelText("選擇起飛時間")).toBeRequired();
    expect(flightComplete(repeated)).toBe(false);

    rerender(<FlightFields legend="去程" value={{ ...repeated, departureUtcOffset: "-04:00" }} onChange={() => {}} />);
    expect(flightComplete({ ...repeated, departureUtcOffset: "-04:00" })).toBe(true);
  });
});
