import { describe, expect, it } from "vitest";

import { hoursOn, type OpeningPeriod, type PlaceOpeningHours } from "../src/planning/opening-hours";

function period(open: [number, number, number], close: [number, number, number] | null, dates?: [string, string]): OpeningPeriod {
  return {
    open: { day: open[0], hour: open[1], minute: open[2], date: dates?.[0] ?? null },
    close: close ? { day: close[0], hour: close[1], minute: close[2], date: dates?.[1] ?? null } : null,
  };
}

function hours(overrides: Partial<PlaceOpeningHours>): PlaceOpeningHours {
  return { businessStatus: "operational", regular: null, current: null, ...overrides };
}

const allWeek = Array.from({ length: 7 }, (_, day) => period([day, 9, 0], [day, 17, 0]));
// A day far outside Google's coming week, so only the usual week applies.
const longBefore = "2026-09-01";

// 2026-10-19 is a Monday; 2026-10-23 a Friday (day 5); 2026-10-24 a Saturday (day 6).
describe("opening hours on a date", () => {
  it("splits a period that closes after midnight across both days", () => {
    const bar = hours({ regular: [period([5, 18, 0], [6, 2, 0]), period([6, 18, 0], [0, 2, 0])] });

    expect(hoursOn(bar, "2026-10-23", longBefore)).toEqual({ status: "open", intervals: [[18 * 60, 24 * 60]] });
    expect(hoursOn(bar, "2026-10-24", longBefore)).toEqual({ status: "open", intervals: [[0, 120], [18 * 60, 24 * 60]] });
    // Saturday 18:00 runs into Sunday 02:00 across the end of the week.
    expect(hoursOn(bar, "2026-10-25", longBefore)).toEqual({ status: "open", intervals: [[0, 120]] });
    expect(hoursOn(bar, "2026-10-22", longBefore)).toEqual({ status: "closed", reason: "closed_that_day" });
  });

  it("keeps a place open on every day inside a period that spans several midnights", () => {
    const weekend = hours({ regular: [period([5, 10, 0], [0, 22, 0])] });
    const dated = hours({
      regular: allWeek,
      current: [period([1, 0, 0], [0, 23, 59], ["2026-10-19", "2026-10-25"])],
    });

    expect(hoursOn(weekend, "2026-10-24", longBefore)).toEqual({ status: "open", intervals: [[0, 24 * 60]] });
    expect(hoursOn(weekend, "2026-10-25", longBefore)).toEqual({ status: "open", intervals: [[0, 22 * 60]] });
    expect(hoursOn(dated, "2026-10-22", "2026-10-19")).toEqual({ status: "open", intervals: [[0, 24 * 60]] });
  });

  it("treats an opening without a close as open all day", () => {
    expect(hoursOn(hours({ regular: [period([0, 0, 0], null)] }), "2026-10-23", longBefore))
      .toEqual({ status: "open", intervals: [[0, 24 * 60]] });
  });

  it("uses the dated hours for the seven days from today, and the usual week after them", () => {
    // Closed for a holiday on Monday the 19th, today; open shorter on Saturday.
    const current = [
      ...[20, 21, 22, 23].map((day) => period([day - 18, 9, 0], [day - 18, 17, 0], [`2026-10-${day}`, `2026-10-${day}`])),
      period([6, 10, 0], [6, 15, 0], ["2026-10-24", "2026-10-24"]),
      period([0, 9, 0], [0, 17, 0], ["2026-10-25", "2026-10-25"]),
    ];
    const museum = hours({ regular: allWeek, current });
    const today = "2026-10-19";

    expect(hoursOn(museum, "2026-10-19", today)).toEqual({ status: "closed", reason: "closed_that_day" });
    expect(hoursOn(museum, "2026-10-24", today)).toEqual({ status: "open", intervals: [[600, 900]] });
    expect(hoursOn(museum, "2026-10-26", today)).toEqual({ status: "open", intervals: [[540, 1020]] });
    // Empty dated hours mean closed all week, even though the usual week has hours.
    expect(hoursOn(hours({ regular: allWeek, current: [] }), "2026-10-21", today))
      .toEqual({ status: "closed", reason: "temporarily_closed" });
  });

  it("separates unknown hours from places that are closed", () => {
    expect(hoursOn(null, "2026-10-23", longBefore)).toEqual({ status: "unknown" });
    expect(hoursOn(hours({ regular: null }), "2026-10-23", longBefore)).toEqual({ status: "unknown" });
    expect(hoursOn(hours({ regular: [] }), "2026-10-23", longBefore)).toEqual({ status: "closed", reason: "temporarily_closed" });
    expect(hoursOn(hours({ businessStatus: "closed_permanently", regular: [period([0, 0, 0], null)] }), "2026-10-23", longBefore))
      .toEqual({ status: "closed", reason: "permanently_closed" });
  });
});
