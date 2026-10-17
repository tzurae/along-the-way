// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TripDto } from "@along-the-way/contracts/private-trips";
import type { ItineraryItemDto, TripSkeletonDto } from "@along-the-way/contracts/trip-skeleton";
import { AppToaster } from "../src/AppToaster";
import { TravelWorkspace } from "../src/TravelWorkspace";


interface LodgingFixture {
  trip: TripDto;
  item: ItineraryItemDto;
  skeleton: TripSkeletonDto;
}
function lodgingFixture({
  startDate = "2026-11-03",
  endDate = "2026-11-07",
  checkIn = "2026-11-03T15:00",
  checkOut = "2026-11-06T11:00",
  timeZone = "Asia/Tokyo",
  checkInOffset = "+09:00",
  checkOutOffset = "+09:00",
}: {
  startDate?: string;
  endDate?: string;
  checkIn?: string;
  checkOut?: string;
  timeZone?: string;
  checkInOffset?: string;
  checkOutOffset?: string;
} = {}) {
  const dates: string[] = [];
  for (let date = new Date(`${startDate}T00:00:00Z`); date <= new Date(`${endDate}T00:00:00Z`); date = new Date(date.valueOf() + 86_400_000)) {
    dates.push(date.toISOString().slice(0, 10));
  }
  const trip: TripDto = {
    id: "trip",
    name: "住宿測試",
    startDate,
    endDate,
    defaultCurrency: "USD",
    countryStops: [{ id: "stop", countryCode: "US", position: 0, timeZone }],
    days: dates.map((date, index) => ({ id: `day-${index}`, date, title: null })),
    members: [],
    invites: [],
    memberCount: 1,
    dayCount: dates.length,
    role: "owner",
    version: 4,
    editorsCanSchedule: false,
  };
  const item: ItineraryItemDto = {
    id: "lodging",
    tripId: trip.id,
    title: "原飯店",
    type: "lodging",
    notes: null,
    sourceUrl: null,
    money: null,
    lockedAt: null,
    lockedBy: null,
    version: 2,
    endpoints: [
      { role: "start", countryStopId: "stop", placeId: "hotel", localDateTime: checkIn, timeZone, utcOffset: checkInOffset, instant: "2026-11-03T06:00:00Z" },
      { role: "end", countryStopId: "stop", placeId: "hotel", localDateTime: checkOut, timeZone, utcOffset: checkOutOffset, instant: "2026-11-06T02:00:00Z" },
    ],
    constraints: [],
    participants: null,
    details: { bookedBy: null, confirmationCode: null },
  };
  const skeleton: TripSkeletonDto = {
    tripVersion: trip.version,
    places: [{ id: "hotel", tripId: trip.id, name: "原飯店", type: "lodging", address: null, latitude: 35, longitude: 139, timeZone, sourceUrl: null, notes: null, locationStatus: "complete", version: 1 }],
    items: [item],
    days: trip.days.map((day) => ({ id: day.id, date: day.date, entries: [] })),
  };
  return { trip, item, skeleton };
}

function renderLodging(fixture: LodgingFixture) {
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const request = async <T,>(path: string, init?: RequestInit & { parse?: (value: unknown) => unknown }): Promise<T> => {
    let value: unknown;
    if (init?.method === "PATCH") {
      writes.push({ path, body: JSON.parse(String(init.body)) });
      value = { item: fixture.item };
    } else {
      value = { skeleton: fixture.skeleton };
    }
    return (init?.parse ? init.parse(value) : value) as T;
  };
  render(<><TravelWorkspace trip={fixture.trip} type="lodging" request={request} revision={0} onChanged={vi.fn(async () => {})} /><AppToaster /></>);
  return { writes };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("restarts a completed stay so check-in can move later", async () => {
  const fixture = lodgingFixture();
  const { writes } = renderLodging(fixture);
  fireEvent.click(await screen.findByRole("button", { name: "修改 原飯店" }));
  const dialog = await screen.findByRole("dialog", { name: "修改住宿" });

  fireEvent.click(within(dialog).getByRole("button", { name: /入住日：11\/5/ }));
  expect(dialog).toHaveTextContent("點選退房日");
  fireEvent.click(within(dialog).getByRole("button", { name: /退房日：11\/7/ }));
  fireEvent.click(within(dialog).getByRole("button", { name: "儲存" }));

  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]!.body).toMatchObject({
    checkInLocalDateTime: "2026-11-05T15:00",
    checkOutLocalDateTime: "2026-11-07T11:00",
  });
});

it("saves edits to an existing same-day stay", async () => {
  const fixture = lodgingFixture({
    startDate: "2026-11-03",
    endDate: "2026-11-03",
    checkIn: "2026-11-03T10:00",
    checkOut: "2026-11-03T18:00",
  });
  const { writes } = renderLodging(fixture);
  fireEvent.click(await screen.findByRole("button", { name: "修改 原飯店" }));
  const dialog = await screen.findByRole("dialog", { name: "修改住宿" });
  fireEvent.change(within(dialog).getByLabelText("飯店名稱"), { target: { value: "同日新飯店" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "儲存" }));

  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]!.body).toMatchObject({
    hotel: { name: "同日新飯店" },
    checkInLocalDateTime: "2026-11-03T10:00",
    checkOutLocalDateTime: "2026-11-03T18:00",
  });
});

it("requires and saves the selected occurrence of an ambiguous lodging time", async () => {
  const fixture = lodgingFixture({
    startDate: "2026-11-01",
    endDate: "2026-11-02",
    checkIn: "2026-11-01T00:30",
    checkOut: "2026-11-02T11:00",
    timeZone: "America/New_York",
    checkInOffset: "-04:00",
    checkOutOffset: "-05:00",
  });
  const { writes } = renderLodging(fixture);
  fireEvent.click(await screen.findByRole("button", { name: "修改 原飯店" }));
  const dialog = await screen.findByRole("dialog", { name: "修改住宿" });
  fireEvent.click(within(dialog).getByText("進階設定（選填）"));
  fireEvent.change(within(dialog).getByLabelText("入住時刻"), { target: { value: "01:30" } });

  const occurrence = within(dialog).getByLabelText("選擇入住時間");
  expect(within(occurrence).getAllByRole("option").map((option) => option.textContent)).toEqual([
    "選擇這次發生的 UTC 時差",
    "UTC-04:00",
    "UTC-05:00",
  ]);
  fireEvent.change(occurrence, { target: { value: "-05:00" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "儲存" }));

  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]!.body).toMatchObject({
    checkInLocalDateTime: "2026-11-01T01:30",
    checkInUtcOffset: "-05:00",
  });
});
