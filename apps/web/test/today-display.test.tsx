// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { TodayWorkspace } from "../src/TodayWorkspace";
import { createTodayModel, type TodayModel } from "../src/today-model";
import { todayActivity, todaySkeleton, todayTrip, todayUser } from "./today-fixtures";

const mounted: Array<{ root: Root; host: HTMLDivElement }> = [];
const trip = todayTrip();
function display(model: TodayModel, offline = false) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<TodayWorkspace model={model} selectedDate="2026-10-21" onDayChanged={() => {}} fetchedAt="2026-10-21T01:30:00Z" retry={() => {}} offline={offline} />);
  return host;
}
async function openDetails(model: TodayModel) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(<TodayWorkspace model={model} selectedDate="2026-10-21" onDayChanged={() => {}} fetchedAt="2026-10-21T01:30:00Z" retry={() => {}} />));
  const trigger = host.querySelector<HTMLButtonElement>("[data-today-item-trigger]");
  expect(trigger).toBeInTheDocument();
  await act(async () => trigger!.click());
  const details = document.querySelector<HTMLElement>(".today-item-detail");
  expect(details).toBeInTheDocument();
  return details!;
}
afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps cross-zone flight state and navigation while omitting clocks from rows, lead, and detail", async () => {
  const start = { ...todayActivity().endpoints[0]!, instant: "2026-10-21T01:00:00Z", localDateTime: "2026-10-21T09:00", timeZone: "Asia/Taipei", utcOffset: "+08:00" };
  const flight = { ...todayActivity("跨時區航班"), type: "flight" as const, details: { carrier: "Test airline", serviceNumber: "T123", confirmationNotes: null },
    endpoints: [start, { ...start, role: "end" as const, placeId: "arrival", instant: "2026-10-21T03:30:00Z", localDateTime: "2026-10-21T12:30", timeZone: "Asia/Tokyo", utcOffset: "+09:00" }] };
  const skeleton = todaySkeleton(trip, [flight]);
  skeleton.places[0]!.name = "台北";
  skeleton.places.push({ ...skeleton.places[0]!, id: "arrival", name: "東京", latitude: 35, longitude: 139 });
  const model = createTodayModel(trip, skeleton, [], todayUser.id);
  model.days[0]!.timeZone = "Asia/Tokyo";
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T01:30:00Z"));

  const current = display(model);
  const currentRow = current.querySelector('[data-today-item-trigger="跨時區航班"]')?.closest("li");
  expect(currentRow).toHaveClass("is-current");
  expect(currentRow).toHaveTextContent(/跨時區航班.*航班.*進行中.*東京/);
  expect(currentRow).not.toHaveTextContent(/09:00|12:30|Asia\/Taipei|Asia\/Tokyo/);
  expect(current.querySelector(".today-lead")).toHaveTextContent("跨時區航班");
  expect(current.querySelector(".today-lead")).not.toHaveTextContent(/09:00|12:30|Asia\/Taipei|Asia\/Tokyo/);

  now.mockReturnValue(Date.parse("2026-10-21T00:30:00Z"));
  const upcoming = display(model);
  expect(upcoming.querySelector('[data-today-item-trigger="跨時區航班"]')?.closest("li")).toHaveClass("is-next");
  expect(upcoming.querySelector(".today-route")).toHaveTextContent("目的地：台北");
  const navigation = upcoming.querySelector<HTMLAnchorElement>(".today-primary-action");
  expect(new URL(navigation!.href).searchParams.get("destination")).toBe("34,135");

  const details = await openDetails(model);
  expect(details).toHaveTextContent(/台北.*東京/);
  expect(details).not.toHaveTextContent(/09:00|12:30|Asia\/Taipei|Asia\/Tokyo/);
});

it("uses an email fallback instead of an opaque participant ID", async () => {
  const model = createTodayModel(trip, todaySkeleton(trip, [todayActivity()]), [], todayUser.id);
  expect(await openDetails(model)).toHaveTextContent(`參與者：${todayUser.email}（你）`);
});

it("updates an open item detail when a live refresh changes its participants", async () => {
  const initial = createTodayModel(trip, todaySkeleton(trip, [todayActivity()]), [], todayUser.id);
  const details = await openDetails(initial);
  expect(details).toHaveTextContent(todayUser.email);

  const refreshed = structuredClone(initial);
  refreshed.items[0]!.participants = [{ id: "new-member", name: "新的旅伴", removed: false }];
  await act(async () => mounted.at(-1)!.root.render(
    <TodayWorkspace
      model={refreshed}
      selectedDate="2026-10-21"
      onDayChanged={() => {}}
      fetchedAt="2026-10-21T01:30:00Z"
      retry={() => {}}
    />,
  ));

  expect(document.querySelector(".today-item-detail")).toHaveTextContent("參與者：新的旅伴");
  expect(document.querySelector(".today-item-detail")).not.toHaveTextContent(todayUser.email);
});

it("shows one actionable pending-participant state rather than duplicate warnings", async () => {
  const item = todayActivity(); item.participants = null;
  const details = await openDetails(createTodayModel(trip, todaySkeleton(trip, [item]), [], todayUser.id));
  expect(details.textContent?.match(/參與者待確認/g)).toHaveLength(1);
  expect(details).not.toHaveTextContent("參與者：參與者待確認");
});

it("keeps transport availability guidance fully in Traditional Chinese", async () => {
  const item = {
    ...todayActivity("電車"),
    type: "transport" as const,
    details: { mode: "train", ticketInfo: null },
  };
  const details = await openDetails(createTodayModel(trip, todaySkeleton(trip, [item]), [], todayUser.id));
  expect(details).toHaveTextContent("無法取得即時交通資料");
  expect(details).not.toHaveTextContent("unavailable");
});

it("marks a retained historical participant after that member is removed from the trip", async () => {
  const item = todayActivity("歷史行程");
  item.participants = [{
    memberId: "removed-member",
    displayName: "已退出的旅伴",
    email: "removed@example.test",
    removed: true,
  }];
  const details = await openDetails(createTodayModel(trip, todaySkeleton(trip, [item]), [], todayUser.id));
  expect(details).toHaveTextContent("參與者：已退出的旅伴・已移除");
});

it("distinguishes online synchronization from offline reconnect", () => {
  const model = createTodayModel(trip, todaySkeleton(trip), [], todayUser.id);
  expect(display(model).querySelector(".today-sync-status")).toHaveTextContent(/^已同步$/);
  expect(display(model).querySelector(".today-zone button")).toBeNull();
  expect(display(model, true).querySelector(".today-zone button")).toHaveTextContent(/^重新連線並同步$/);
});
