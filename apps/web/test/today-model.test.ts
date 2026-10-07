import { describe, expect, it } from "vitest";
import { createTodayModel, dayItems, localDate, parallelItemIds, personalState, tripClock, type TodayItem, type TodayModel } from "../src/today-model";
import { resolveDayTimeZone } from "@along-the-way/contracts/day-time-zone";
import type { TripSkeletonDto } from "@along-the-way/contracts/trip-skeleton";
import { todayActivity, todaySkeleton, todayTrip, todayUser } from "./today-fixtures";

function activity(id: string, member: string | null, start: string, end: string): TodayItem {
  return { id, title: id, type: "activity", start, end, endpoints: [], participants: member ? [{ id: member, name: member }] : null, locked: false, constraints: [], facts: [], notes: null, sourceUrl: null };
}
const a = activity("A", "甲", "2026-10-21T01:00:00Z", "2026-10-21T03:00:00Z");
const b = activity("B", "乙", "2026-10-21T02:00:00Z", "2026-10-21T04:00:00Z");
const later = activity("C", "甲", "2026-10-21T05:00:00Z", "2026-10-21T06:00:00Z");
const model: TodayModel = { tripId: "trip", tripName: "Trip", tripVersion: 1, memberId: "甲", items: [b, later, a], days: [
  { id: "d1", date: "2026-10-21", timeZone: "Asia/Tokyo", itemIds: ["B", "C", "A"], wishlist: [] },
  { id: "d2", date: "2026-10-22", timeZone: "Asia/Tokyo", itemIds: [], wishlist: [] },
] };

describe("Today uses each trip day's zone and the device clock only as an instant", () => {
  it("chooses Tokyo's Oct 21 while a Los Angeles device is still on Oct 20", () => {
    const now = Date.parse("2026-10-21T02:30:00Z");
    expect(localDate(now, "America/Los_Angeles")).toBe("2026-10-20");
    expect(tripClock(model, now)).toMatchObject({ phase: "during", today: { id: "d1" } });
    expect(tripClock({ ...model, days: model.days.map((day) => ({ ...day, timeZone: "America/Los_Angeles" })) }, now)).toMatchObject({ phase: "before", daysUntil: 1, today: null });
  });
  it("does not label a day today before departure, after completion, or without a known zone", () => {
    expect(tripClock(model, Date.parse("2026-10-19T15:00Z"))).toMatchObject({ phase: "before", daysUntil: 1, today: null });
    expect(tripClock(model, Date.parse("2026-10-22T15:00Z"))).toMatchObject({ phase: "after", today: null });
    expect(tripClock({ ...model, days: model.days.map((day) => ({ ...day, timeZone: null })) }, Date.parse("2026-10-21T02:30Z"))).toMatchObject({ phase: "unknown", today: null });
  });
  it("handles a repeated DST clock without confusing the current and next instants", () => {
    const first = activity("first", "甲", "2026-11-01T08:00Z", "2026-11-01T08:45Z");
    const second = activity("second", "甲", "2026-11-01T09:00Z", "2026-11-01T09:45Z");
    expect(personalState([first, second], "甲", Date.parse("2026-11-01T08:30Z"))).toMatchObject({ current: [{ id: "first" }], next: { id: "second" }, minutesUntil: 30 });
  });
  it("reuses planner zone precedence with an explicit country fallback", () => {
    const skeleton: TripSkeletonDto = { tripVersion: 1, places: [], items: [], days: [{ id: "day", date: "2026-10-21", entries: [] }], events: [], tripInformationItemIds: [] };
    expect(resolveDayTimeZone(skeleton, skeleton.days[0]!, [{ timeZone: "Europe/Paris" }], "Asia/Tokyo")).toBe("Europe/Paris");
    expect(resolveDayTimeZone(skeleton, skeleton.days[0]!, [], "Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(resolveDayTimeZone(skeleton, skeleton.days[0]!, [], null)).toBeNull();
  });
});

describe("participant-specific current and next without invented group travel", () => {
  it("keeps A 10–12 and B 11–13 concurrently at 11:30, and each member's next independent", () => {
    const now = Date.parse("2026-10-21T02:30Z");
    expect(dayItems(model, model.days[0]!).map((item) => item.id)).toEqual(["A", "B", "C"]);
    expect([...parallelItemIds(model.items)].sort()).toEqual(["A", "B"]);
    expect(personalState(model.items, "甲", now)).toMatchObject({ current: [{ id: "A" }], next: { id: "C" }, minutesUntil: 150 });
    expect(personalState(model.items, "乙", now)).toMatchObject({ current: [{ id: "B" }], next: null });
  });
  it("uses only the member's own first item, gap and last completion", () => {
    expect(personalState(model.items, "乙", Date.parse("2026-10-21T01:30Z"))).toMatchObject({ current: [], next: { id: "B" }, minutesUntil: 30 });
    expect(personalState(model.items, "甲", Date.parse("2026-10-21T03:00Z"))).toMatchObject({ phase: "between", current: [], next: { id: "C" }, minutesUntil: 120 });
    expect(personalState(model.items, "乙", Date.parse("2026-10-21T04:00Z"))).toMatchObject({ phase: "done", current: [], next: null });
    expect(personalState(model.items, "甲", Date.parse("2026-10-21T06:00Z"))).toMatchObject({ phase: "done", current: [], next: null });
  });
  it("never assigns unconfirmed participants to a member or retains a removed next item", () => {
    const unconfirmed = activity("unknown", null, a.start!, a.end!);
    expect(personalState([unconfirmed, b], "甲", Date.parse("2026-10-21T02:30Z"))).toMatchObject({ phase: "empty", current: [], next: null });
    expect(personalState([a, b], "甲", Date.parse("2026-10-21T03:30Z"))).toMatchObject({ phase: "done", next: null });
  });
});

describe("formal interval membership across local days", () => {
  it("keeps a duration-based overnight activity current on the following day", () => {
    const trip = todayTrip();
    const item = todayActivity();
    if (item.type !== "activity") throw new Error("Expected activity fixture");
    item.endpoints[0]!.instant = "2026-10-21T14:30:00Z";
    item.endpoints[0]!.localDateTime = "2026-10-21T23:30";
    item.details.durationMinutes = 120;
    const readModel = createTodayModel(trip, todaySkeleton(trip, [item]), [], todayUser.id);
    const nextDay = dayItems(readModel, readModel.days[1]!);
    expect(personalState(nextDay, "member", Date.parse("2026-10-21T15:30:00Z"))).toMatchObject({ current: [{ id: item.id }], phase: "current" });
    expect(dayItems(readModel, readModel.days[2]!)).toEqual([]);
  });
  it("includes lodging on intermediate nights without inventing extra endpoint projections", () => {
    const trip = todayTrip();
    const item = { ...todayActivity("hotel"), type: "lodging" as const, details: { bookedBy: null, confirmationCode: null } };
    item.endpoints.push({ ...item.endpoints[0]!, role: "end", instant: "2026-10-23T01:00:00Z", localDateTime: "2026-10-23T10:00" });
    const skeleton = todaySkeleton(trip, [item]);
    skeleton.days[2]!.entries = [{ itemId: item.id, projection: "continuation", sortInstant: item.endpoints[1]!.instant }];
    const readModel = createTodayModel(trip, skeleton, [], todayUser.id);
    expect(dayItems(readModel, readModel.days[1]!).map((entry) => entry.id)).toEqual(["hotel"]);
    expect(personalState(dayItems(readModel, readModel.days[1]!), "member", Date.parse("2026-10-22T01:00:00Z")).current.map((entry) => entry.id)).toEqual(["hotel"]);
    expect(skeleton.days[1]!.entries).toEqual([]);
  });
  it("uses the actual DST day boundary, not an assumed 24-hour window", () => {
    const trip = todayTrip();
    trip.countryStops[0]!.timeZone = "America/Los_Angeles";
    trip.days = [{ id: "dst", date: "2026-11-01", title: null }];
    const item = todayActivity("late-after-fallback");
    item.endpoints[0]!.instant = "2026-11-02T07:30:00Z";
    item.endpoints[0]!.timeZone = "America/Los_Angeles";
    const skeleton = todaySkeleton(trip, [item]);
    skeleton.days[0]!.entries = [];
    const readModel = createTodayModel(trip, skeleton, [], todayUser.id);
    expect(dayItems(readModel, readModel.days[0]!).map((entry) => entry.id)).toEqual([item.id]);
  });
  it.each([
    { zone: "America/Santiago", country: "CL", date: "2026-09-06", nextDate: "2026-09-07", offset: "-03:00", now: "2026-09-07T02:15:00Z", itemStart: "2026-09-07T03:30:00Z" },
    { zone: "America/Havana", country: "CU", date: "2026-03-08", nextDate: "2026-03-09", offset: "-04:00", now: "2026-03-09T03:15:00Z", itemStart: "2026-03-09T04:30:00Z" },
  ])("excludes tomorrow's 00:30 activity from personal next after the $zone midnight gap", ({ zone, country, date, nextDate, offset, now, itemStart }) => {
    const trip = todayTrip();
    trip.startDate = date;
    trip.endDate = nextDate;
    trip.dayCount = 2;
    trip.countryStops[0]!.countryCode = country;
    trip.countryStops[0]!.timeZone = zone;
    trip.days = [{ id: "gap-day", date, title: null }, { id: "next-day", date: nextDate, title: null }];
    const item = todayActivity("tomorrow-at-0030");
    Object.assign(item.endpoints[0]!, { localDateTime: `${nextDate}T00:30`, timeZone: zone, utcOffset: offset, instant: itemStart });
    const skeleton = todaySkeleton(trip, [item]);
    skeleton.days[1]!.entries = skeleton.days[0]!.entries;
    skeleton.days[0]!.entries = [];
    const readModel = createTodayModel(trip, skeleton, [], todayUser.id);
    const clock = tripClock(readModel, Date.parse(now));
    expect(clock.today?.id).toBe("gap-day");
    expect(personalState(dayItems(readModel, readModel.days[0]!), "member", Date.parse(now))).toMatchObject({ next: null, phase: "empty" });
    expect(dayItems(readModel, readModel.days[1]!).map((entry) => entry.id)).toEqual([item.id]);
    expect(personalState(dayItems(readModel, readModel.days[1]!), "member", Date.parse(now))).toMatchObject({ next: { id: item.id }, minutesUntil: 75 });
  });
  it("uses display names then email only for explicit item participants", () => {
    const trip = todayTrip();
    const item = todayActivity();
    item.participants!.push({ memberId: "named", displayName: "旅伴", email: "named@example.test", removed: false });
    const readModel = createTodayModel(trip, todaySkeleton(trip, [item]), [], todayUser.id);
    expect(readModel.items[0]!.participants).toEqual([{ id: "member", name: todayUser.email }, { id: "named", name: "旅伴" }]);
    expect(JSON.stringify(readModel)).not.toContain("named@example.test");
  });
});
