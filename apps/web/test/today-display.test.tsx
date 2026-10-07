// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TodayWorkspace } from "../src/TodayWorkspace";
import { createTodayModel, type TodayModel } from "../src/today-model";
import { todayActivity, todaySkeleton, todayTrip, todayUser } from "./today-fixtures";

const trip = todayTrip();
function display(model: TodayModel, offline = false) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<TodayWorkspace model={model} selectedDate="2026-10-21" onDayChanged={() => {}} fetchedAt="2026-10-21T01:30:00Z" retry={() => {}} offline={offline} />);
  return host;
}
afterEach(() => vi.restoreAllMocks());

it("shows each cross-zone flight endpoint's local time and zone in the card and personal current/next", () => {
  const start = { ...todayActivity().endpoints[0]!, instant: "2026-10-21T01:00:00Z", localDateTime: "2026-10-21T09:00", timeZone: "Asia/Taipei", utcOffset: "+08:00" };
  const flight = { ...todayActivity("跨時區航班"), type: "flight" as const, details: { carrier: "Test airline", serviceNumber: "T123", confirmationNotes: null },
    endpoints: [start, { ...start, role: "end" as const, placeId: "arrival", instant: "2026-10-21T03:30:00Z", localDateTime: "2026-10-21T12:30", timeZone: "Asia/Tokyo", utcOffset: "+09:00" }] };
  const skeleton = todaySkeleton(trip, [flight]);
  skeleton.places[0]!.name = "台北";
  skeleton.places.push({ ...skeleton.places[0]!, id: "arrival", name: "東京" });
  const model = createTodayModel(trip, skeleton, [], todayUser.id);
  model.days[0]!.timeZone = "Asia/Tokyo";
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T01:30:00Z"));
  const current = display(model);
  for (const surface of [current.querySelector("article > p"), current.querySelector('[aria-label="我的目前與下一步"]')]) {
    expect(surface).toHaveTextContent(/09:00.*台北.*Asia\/Taipei.*12:30.*東京.*Asia\/Tokyo/);
  }
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T00:30:00Z"));
  expect(display(model).querySelector('[aria-label="我的目前與下一步"]')).toHaveTextContent(/09:00.*Asia\/Taipei.*12:30.*Asia\/Tokyo/);
  model.items[0]!.endpoints[1]!.place = null;
  expect(display(model).querySelector("article > p")).toHaveTextContent(/12:30 · Asia\/Tokyo/);
  expect(display(model).querySelector("article > p")).not.toHaveTextContent(/12:30.*台北/);
});

it("uses an email fallback instead of an opaque participant ID", () => {
  const model = createTodayModel(trip, todaySkeleton(trip, [todayActivity()]), [], todayUser.id);
  expect(display(model).querySelector("article")).toHaveTextContent(`參與者：${todayUser.email}（你）`);
});

it("shows one actionable pending-participant state rather than duplicate warnings", () => {
  const item = todayActivity(); item.participants = null;
  const card = display(createTodayModel(trip, todaySkeleton(trip, [item]), [], todayUser.id)).querySelector("article")!;
  expect(card.textContent?.match(/參與者待確認/g)).toHaveLength(1);
  expect(card).not.toHaveTextContent("參與者：參與者待確認");
});

it("distinguishes online synchronization from offline reconnect", () => {
  const model = createTodayModel(trip, todaySkeleton(trip), [], todayUser.id);
  expect(display(model).querySelector("header button")).toHaveTextContent(/^重新同步$/);
  expect(display(model, true).querySelector("header button")).toHaveTextContent(/^重新連線並同步$/);
});
