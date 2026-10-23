// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { TodayWorkspace } from "../src/TodayWorkspace";
import type { TodayDay, TodayItem, TodayModel, TodayPlace } from "../src/today-model";

function place(
  name: string,
  latitude: number | null,
  longitude: number | null,
  providerPlaceId: string | null = null,
  replacedStop: TodayDay["wishlist"][number]["replacedStop"] = null,
): TodayDay["wishlist"][number] {
  return { id: name, name, type: "activity", latitude, longitude, providerPlaceId, replacedStop };
}

function endpoint(role: "start" | "end", instant: string, timeZone: string, name: string, latitude: number | null, longitude: number | null) {
  const endpointPlace: TodayPlace = { id: `${name}-id`, name, type: "activity", address: null, latitude, longitude };
  return { role, instant, timeZone, place: endpointPlace };
}

function fixedItem(
  id: string,
  type: TodayItem["type"],
  start: string | null,
  end: string | null,
  endpoints: TodayItem["endpoints"] = [],
): TodayItem {
  return {
    id,
    title: id,
    type,
    start,
    end,
    endpoints,
    participants: [{ id: "member", name: "Traveler", removed: false }],
    locked: false,
    constraints: [],
    facts: [],
    notes: null,
    sourceUrl: null,
  };
}

function tripDay(id: string, date: string, itemIds: string[] = [], wishlist: TodayDay["wishlist"] = [], details: Pick<TodayDay, "title" | "note"> = { title: null, note: null }): TodayDay {
  return { id, date, ...details, timeZone: "UTC", itemIds, wishlist };
}

function todayModel(days: TodayDay[], items: TodayItem[] = []): TodayModel {
  return { tripId: "trip", tripName: "Test trip", tripVersion: 5, memberId: "member", days, items };
}

function renderToday(model: TodayModel, selectedDate: string) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <TodayWorkspace
      model={model}
      selectedDate={selectedDate}
      onDayChanged={() => {}}
      fetchedAt="2026-10-21T00:00:00Z"
      retry={() => {}}
    />,
  );
  return host;
}

/** Shows the page load's first view (today), so a later render keeps a day picked inside the app. */
function afterFirstView(model: TodayModel) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<TodayWorkspace model={model} selectedDate={null} onDayChanged={() => {}} fetchedAt="2026-10-21T00:00:00Z" retry={() => {}} />));
  act(() => root.unmount());
  vi.unstubAllGlobals();
}

function directionQueries(host: HTMLElement) {
  return [...host.querySelectorAll<HTMLAnchorElement>(".route-leg-directions")].map((link) => new URL(link.href).searchParams);
}

afterEach(() => vi.restoreAllMocks());

describe("Today timeline ordering and state", () => {
  it("puts 11:59 fixed items before saved-order places, then 12:00 and unknown-time items", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T10:00:00Z"));
    const beforeNoon = fixedItem("11:59 fixed", "activity", "2026-10-21T11:59:00Z", "2026-10-21T12:30:00Z");
    const noon = fixedItem("12:00 fixed", "reservation", "2026-10-21T12:00:00Z", "2026-10-21T13:00:00Z");
    const unknown = fixedItem("unknown time", "activity", null, null);
    const day = tripDay(
      "day21",
      "2026-10-21",
      ["unknown time", "12:00 fixed", "11:59 fixed"],
      [place("Saved second", 2, 2), place("Saved first", 1, 1)],
    );

    const host = renderToday(todayModel([day], [unknown, noon, beforeNoon]), day.date);
    const labels = [...host.querySelectorAll<HTMLElement>(".today-stop")].map((row) => row.querySelector("strong")?.textContent);

    expect(labels).toEqual(["11:59 fixed", "Saved second", "Saved first", "12:00 fixed", "unknown time"]);
    expect([...host.querySelectorAll(".today-stop-order")].map((entry) => entry.textContent)).toEqual(["1", "2"]);
  });

  it("marks elapsed, current, next, later, and unknown-time rows without rendering clock text", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T12:00:00Z"));
    const items = [
      fixedItem("past", "activity", "2026-10-21T08:00:00Z", "2026-10-21T09:00:00Z"),
      fixedItem("current", "activity", "2026-10-21T10:00:00Z", "2026-10-21T13:00:00Z"),
      fixedItem("next", "reservation", "2026-10-21T14:00:00Z", "2026-10-21T15:00:00Z"),
      fixedItem("later", "meal", "2026-10-21T16:00:00Z", "2026-10-21T17:00:00Z"),
      fixedItem("unknown", "activity", null, null),
    ];
    const day = tripDay("day21", "2026-10-21", items.map((item) => item.id));
    const host = renderToday(todayModel([day], items), day.date);

    expect(host.querySelector('[data-today-item-trigger="past"]')?.closest("li")).toHaveClass("is-past");
    expect(host.querySelector('[data-today-item-trigger="current"]')?.closest("li")).toHaveClass("is-current");
    expect(host.querySelector('[data-today-item-trigger="next"]')?.closest("li")).toHaveClass("is-next");
    expect(host.querySelector('[data-today-item-trigger="later"]')?.closest("li")).toHaveClass("is-later");
    expect(host.querySelector('[data-today-item-trigger="unknown"]')?.closest("li")).toHaveClass("is-unscheduled");
    expect(host.querySelector(".today-timeline")).not.toHaveTextContent(/08:00|09:00|10:00|13:00|14:00|15:00|16:00|17:00/);
    expect(host.querySelector(".today-lead")).not.toHaveTextContent(/10:00|13:00/);
  });
  it("keeps next-stop navigation without the removed group timeline action", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T09:00:00Z"));
    const next = fixedItem(
      "next stop",
      "activity",
      "2026-10-21T10:00:00Z",
      "2026-10-21T11:00:00Z",
      [endpoint("start", "2026-10-21T10:00:00Z", "UTC", "Next stop", 35, 135)],
    );
    const day = tripDay("day21", "2026-10-21", [next.id]);

    const host = renderToday(todayModel([day], [next]), day.date);

    const navigation = host.querySelector<HTMLAnchorElement>(".today-lead-actions a");
    expect(navigation).toHaveTextContent("導航到 Next stop");
    const destination = new URL(navigation!.href);
    expect(destination.origin + destination.pathname).toBe("https://www.google.com/maps/dir/");
    expect(destination.searchParams.get("destination")).toBe("35,135");
    expect(host.querySelector(".today-lead")).not.toHaveTextContent("查看全團時間線");
  });

});

  it("keeps a replacement and its original relation in one numbered Today stop row", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T12:00:00Z"));
    const replacement = place("附近備案", 35, 135, "google-backup", {
      replacementId: "relation-1",
      originalTripPlaceId: "original-1",
      originalName: "原本景點",
    });
    const day = tripDay("day21", "2026-10-21", [], [replacement]);
    const host = renderToday(todayModel([day]), day.date);

    const rows = host.querySelectorAll(".today-stop");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("附近備案");
    expect(rows[0]).toHaveTextContent("原本景點");
    expect(rows[0]!.querySelectorAll(".today-stop-order")).toHaveLength(1);
  });

describe("Today Google Maps legs", () => {
  it("uses the displayed endpoint for arrival-only flights and departure-only transport, preserving wishlist provider IDs", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-22T12:00:00Z"));
    const arrivalFlight = fixedItem(
      "arrival flight",
      "flight",
      "2026-10-21T23:00:00Z",
      "2026-10-22T09:00:00Z",
      [
        endpoint("start", "2026-10-21T23:00:00Z", "UTC", "Previous-day airport", 10, 10),
        endpoint("end", "2026-10-22T09:00:00Z", "UTC", "Arrival airport", 20, 20),
      ],
    );
    const departureTransport = fixedItem(
      "departure transport",
      "transport",
      "2026-10-22T18:00:00Z",
      "2026-10-23T08:00:00Z",
      [
        endpoint("start", "2026-10-22T18:00:00Z", "UTC", "Departure station", 30, 30),
        endpoint("end", "2026-10-23T08:00:00Z", "UTC", "Next-day station", 40, 40),
      ],
    );
    const day = tripDay("day22", "2026-10-22", [arrivalFlight.id, departureTransport.id], [
      place("First stop", 1, 1, "google-first"),
      place("Second stop", 2, 2, "google-second"),
    ]);

    const queries = directionQueries(renderToday(todayModel([day], [arrivalFlight, departureTransport]), day.date));

    expect(queries).toHaveLength(3);
    expect(queries[0]!.get("origin")).toBe("20,20");
    expect(queries[0]!.get("destination")).toBe("1,1");
    expect(queries[0]!.get("destination_place_id")).toBe("google-first");
    expect(queries[1]!.get("origin_place_id")).toBe("google-first");
    expect(queries[1]!.get("destination_place_id")).toBe("google-second");
    expect(queries[2]!.get("origin")).toBe("2,2");
    expect(queries[2]!.get("origin_place_id")).toBe("google-second");
    expect(queries[2]!.get("destination")).toBe("30,30");
  });

  it("uses the only on-day cross-day endpoint for both adjacent badges", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-22T12:00:00Z"));
    const beforeArrival = fixedItem(
      "before arrival",
      "activity",
      "2026-10-22T08:00:00Z",
      "2026-10-22T08:30:00Z",
      [endpoint("start", "2026-10-22T08:00:00Z", "UTC", "Before arrival place", 1, 1)],
    );
    const arrivalFlight = fixedItem(
      "arrival flight",
      "flight",
      "2026-10-21T23:00:00Z",
      "2026-10-22T09:00:00Z",
      [
        endpoint("start", "2026-10-21T23:00:00Z", "UTC", "Previous-day airport", 10, 10),
        endpoint("end", "2026-10-22T09:00:00Z", "UTC", "Arrival airport", 20, 20),
      ],
    );
    const afterArrival = fixedItem(
      "after arrival",
      "activity",
      "2026-10-22T10:00:00Z",
      "2026-10-22T10:30:00Z",
      [endpoint("start", "2026-10-22T10:00:00Z", "UTC", "After arrival place", 2, 2)],
    );
    const beforeDeparture = fixedItem(
      "before departure",
      "activity",
      "2026-10-22T17:00:00Z",
      "2026-10-22T17:30:00Z",
      [endpoint("start", "2026-10-22T17:00:00Z", "UTC", "Before departure place", 3, 3)],
    );
    const departureTransport = fixedItem(
      "departure transport",
      "transport",
      "2026-10-22T18:00:00Z",
      "2026-10-23T08:00:00Z",
      [
        endpoint("start", "2026-10-22T18:00:00Z", "UTC", "Departure station", 30, 30),
        endpoint("end", "2026-10-23T08:00:00Z", "UTC", "Next-day station", 40, 40),
      ],
    );
    const afterDeparture = fixedItem(
      "after departure",
      "activity",
      "2026-10-22T19:00:00Z",
      "2026-10-22T19:30:00Z",
      [endpoint("start", "2026-10-22T19:00:00Z", "UTC", "After departure place", 4, 4)],
    );
    const items = [beforeArrival, arrivalFlight, afterArrival, beforeDeparture, departureTransport, afterDeparture];
    const day = tripDay("day22", "2026-10-22", items.map((item) => item.id));
    const links = [...renderToday(todayModel([day], items), day.date).querySelectorAll<HTMLAnchorElement>(".route-leg-directions")];
    const route = (origin: string, destination: string) => {
      const link = links.find((entry) => entry.getAttribute("aria-label")?.includes(`「${origin}」到「${destination}」`));
      expect(link).toBeDefined();
      return new URL(link!.href).searchParams;
    };

    expect(route("Before arrival place", "Arrival airport").get("destination")).toBe("20,20");
    expect(route("Arrival airport", "After arrival place").get("origin")).toBe("20,20");
    expect(route("Before departure place", "Departure station").get("destination")).toBe("30,30");
    expect(route("Departure station", "After departure place").get("origin")).toBe("30,30");
  });

  it("keeps start-before and end-after routing for same-day transport and flights", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T12:00:00Z"));
    const morningTransport = fixedItem(
      "same-day transport",
      "transport",
      "2026-10-21T08:00:00Z",
      "2026-10-21T09:00:00Z",
      [
        endpoint("start", "2026-10-21T08:00:00Z", "UTC", "Transport origin", 50, 50),
        endpoint("end", "2026-10-21T09:00:00Z", "UTC", "Transport destination", 51, 51),
      ],
    );
    const afternoonFlight = fixedItem(
      "same-day flight",
      "flight",
      "2026-10-21T15:00:00Z",
      "2026-10-21T17:00:00Z",
      [
        endpoint("start", "2026-10-21T15:00:00Z", "UTC", "Flight origin", 60, 60),
        endpoint("end", "2026-10-21T17:00:00Z", "UTC", "Flight destination", 61, 61),
      ],
    );
    const day = tripDay("day21", "2026-10-21", [morningTransport.id, afternoonFlight.id], [
      place("First stop", 1, 1),
      place("Second stop", 2, 2),
    ]);

    const queries = directionQueries(renderToday(todayModel([day], [morningTransport, afternoonFlight]), day.date));

    expect(queries[0]!.get("origin")).toBe("51,51");
    expect(queries.at(-1)!.get("destination")).toBe("60,60");
  });

  it("uses checkout and check-in endpoints on lodging edges", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T12:00:00Z"));
    const checkout = fixedItem(
      "checkout hotel",
      "lodging",
      "2026-10-20T15:00:00Z",
      "2026-10-21T08:00:00Z",
      [
        endpoint("start", "2026-10-20T15:00:00Z", "UTC", "Old check-in", 70, 70),
        endpoint("end", "2026-10-21T08:00:00Z", "UTC", "Checkout hotel", 71, 71),
      ],
    );
    const checkin = fixedItem(
      "checkin hotel",
      "lodging",
      "2026-10-21T18:00:00Z",
      "2026-10-22T08:00:00Z",
      [
        endpoint("start", "2026-10-21T18:00:00Z", "UTC", "Check-in hotel", 72, 72),
        endpoint("end", "2026-10-22T08:00:00Z", "UTC", "Future checkout", 73, 73),
      ],
    );
    const day = tripDay("day21", "2026-10-21", [checkout.id, checkin.id], [place("Day stop", 1, 1)]);

    const queries = directionQueries(renderToday(todayModel([day], [checkout, checkin]), day.date));

    // The day starts at last night's stay (its check-in place) and ends at tonight's; the
    // check-in → tonight's anchor leg is the same hotel, so it has no directions.
    expect(queries).toHaveLength(3);
    expect(queries[0]!.get("origin")).toBe("70,70");
    expect(queries[0]!.get("destination")).toBe("71,71");
    expect(queries[1]!.get("origin")).toBe("71,71");
    expect(queries[1]!.get("destination")).toBe("1,1");
    expect(queries[2]!.get("origin")).toBe("1,1");
    expect(queries[2]!.get("destination")).toBe("72,72");
  });

  it("does not create a directions badge across an adjacent place without coordinates", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T12:00:00Z"));
    const day = tripDay("day21", "2026-10-21", [], [
      place("Located A", 1, 1, "google-a"),
      place("Unknown location", null, null, "google-unknown"),
      place("Located B", 2, 2, "google-b"),
    ]);

    expect(directionQueries(renderToday(todayModel([day]), day.date))).toEqual([]);
  });
});

describe("Today trip reminders", () => {
  it("shows first- and last-day lodging reminders in each endpoint's local zone, but not on a middle day", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-22T12:00:00Z"));
    const lodging = fixedItem(
      "Hotel",
      "lodging",
      "2026-10-20T16:00:00Z",
      "2026-10-23T17:00:00Z",
      [
        endpoint("start", "2026-10-20T16:00:00Z", "Asia/Tokyo", "Tokyo Hotel", 35, 139),
        endpoint("end", "2026-10-23T17:00:00Z", "America/Los_Angeles", "LA Hotel", 34, -118),
      ],
    );
    const days = [
      tripDay("day21", "2026-10-21", [lodging.id]),
      tripDay("day22", "2026-10-22", [lodging.id]),
      tripDay("day23", "2026-10-23", [lodging.id]),
    ];
    const model = todayModel(days, [lodging]);
    afterFirstView(model);

    const firstReminder = renderToday(model, "2026-10-21").querySelector(".today-reminder");
    expect(firstReminder).toHaveTextContent("歡迎抵達");
    expect(firstReminder).toHaveTextContent("Tokyo Hotel 入住時間 01:00");
    expect(firstReminder).not.toHaveTextContent("退房時間");

    expect(renderToday(model, "2026-10-22").querySelector(".today-reminder")).toBeNull();

    const lastReminder = renderToday(model, "2026-10-23").querySelector(".today-reminder");
    expect(lastReminder).toHaveTextContent("旅程就要結束了");
    expect(lastReminder).toHaveTextContent("LA Hotel 退房時間 10:00");
    expect(lastReminder).not.toHaveTextContent("入住時間");
  });

  it("combines first- and last-day reminders for a single-day trip", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T12:00:00Z"));
    const lodging = fixedItem(
      "Single-day hotel",
      "lodging",
      "2026-10-20T16:00:00Z",
      "2026-10-22T03:00:00Z",
      [
        endpoint("start", "2026-10-20T16:00:00Z", "Asia/Tokyo", "Single-day hotel", 35, 139),
        endpoint("end", "2026-10-22T03:00:00Z", "America/Los_Angeles", "Single-day hotel", 35, 139),
      ],
    );
    const day = tripDay("day21", "2026-10-21", [lodging.id]);
    const reminder = renderToday(todayModel([day], [lodging]), day.date).querySelector(".today-reminder");

    expect(reminder).toHaveTextContent("歡迎抵達");
    expect(reminder).toHaveTextContent("旅程就要結束了");
    expect(reminder).toHaveTextContent("入住時間 01:00");
    expect(reminder).toHaveTextContent("退房時間 20:00");
  });

  it("counts down to departure using the trip day zone", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-18T12:00:00Z"));
    const first = tripDay("day21", "2026-10-21");
    const reminder = renderToday(todayModel([first]), first.date).querySelector(".today-reminder");

    expect(reminder).toHaveTextContent("還有 3 天出發");
    expect(reminder).toHaveTextContent("出發前記得確認護照");
  });

  it("labels a previous-day airport deadline and repeats it on that actionable trip day", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-22T18:00:00Z"));
    const flight = fixedItem(
      "深夜航班",
      "flight",
      "2026-10-22T16:00:00Z",
      "2026-10-23T03:00:00Z",
      [
        endpoint("start", "2026-10-22T16:00:00Z", "Asia/Tokyo", "Tokyo Airport", 35, 139),
        endpoint("end", "2026-10-23T03:00:00Z", "Asia/Taipei", "Taipei Airport", 25, 121),
      ],
    );
    const days = [tripDay("day21", "2026-10-21"), tripDay("day22", "2026-10-22"), tripDay("day23", "2026-10-23", [flight.id])];
    for (const day of days) day.timeZone = "Asia/Tokyo";
    const model = todayModel(days, [flight]);
    const expected = "深夜航班 01:00 起飛，建議 前一天 22:00 前抵達機場";

    expect(renderToday(model, "2026-10-23").querySelector(".today-reminder")).toHaveTextContent(expected);
    expect(renderToday(model, "2026-10-22").querySelector(".today-reminder")).toHaveTextContent(expected);
  });
});

describe("Today arranged-place distance", () => {
  it("shows a total only when every consecutive saved leg is measurable", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T12:00:00Z"));
    const complete = tripDay("complete", "2026-10-21", [], [
      place("A", 0, 0),
      place("B", 0, 1),
      place("C", 0, 2),
    ]);
    const noKnownLeg = tripDay("none", "2026-10-21", [], [
      place("A", 0, 0),
      place("Unknown", null, null),
      place("C", 0, 2),
    ]);
    const partlyKnown = tripDay("partial", "2026-10-21", [], [
      place("A", 0, 0),
      place("B", 0, 1),
      place("Unknown", null, null),
    ]);

    const completeReminder = renderToday(todayModel([complete]), complete.date).querySelector(".today-reminder");
    expect(completeReminder).toHaveTextContent(/今天排了 3 個地點，地點間直線距離約 222\.4 公里/);

    for (const incomplete of [noKnownLeg, partlyKnown]) {
      const reminder = renderToday(todayModel([incomplete]), incomplete.date).querySelector(".today-reminder");
      expect(reminder).toHaveTextContent("今天排了 3 個地點");
      expect(reminder).not.toHaveTextContent("公里");
      expect(reminder).not.toHaveTextContent("0.0");
    }
  });
});
