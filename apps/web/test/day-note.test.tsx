// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { DayNote } from "../src/TripDayDetails";
import { TodayWorkspace } from "../src/TodayWorkspace";
import { createTodayModel, type TodayModel } from "../src/today-model";
import { TodaySnapshotStore } from "../src/today-snapshot";
import { todaySkeleton, todayTrip, todayUser } from "./today-fixtures";

const NOTE = "早上先去清水寺避開人潮。\n中午在二年坂吃湯豆腐。\n下午走到八坂神社。\n晚上祇園散步。";
const mounted: Array<{ root: Root; host: HTMLDivElement }> = [];
const observers: Array<() => void> = [];
/** Rendered full height of every `.clamped-text`; its clamped box is always 44px. */
let fullTextHeight = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: () => void) {}
    observe() { observers.push(this.callback); }
    unobserve() {}
    disconnect() { if (observers.includes(this.callback)) observers.splice(observers.indexOf(this.callback), 1); }
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("clamped-text") ? fullTextHeight : 0;
  });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("clamped-text") ? Math.min(fullTextHeight, 44) : 0;
  });
});

afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  observers.splice(0);
  localStorage.clear();
  fullTextHeight = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node));
  return { host, root };
}

function todayModelWith(details: { title: string | null; note: string | null }): TodayModel {
  const trip = todayTrip();
  const skeleton = todaySkeleton(trip);
  Object.assign(skeleton.days[0]!, details);
  return createTodayModel(trip, skeleton, [], todayUser.id);
}

function today(model: TodayModel, offline = false) {
  return <TodayWorkspace model={model} selectedDate="2026-10-21" onDayChanged={() => {}} fetchedAt="2026-10-21T01:30:00Z" retry={() => {}} offline={offline} />;
}

function staticToday(model: TodayModel, offline = false) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(today(model, offline));
  return host;
}

describe("安排 day note", () => {
  it("offers 展開全文 only when the note is longer than its three-line clamp", async () => {
    fullTextHeight = 44;
    const { host } = await mount(<DayNote note="短短一行" />);

    expect(host.querySelector<HTMLElement>(".clamped-text")!.style.getPropertyValue("--clamped-text-lines")).toBe("3");
    expect(host.querySelector("button")).toBeNull();
  });

  it("expands and collapses a long note in place", async () => {
    fullTextHeight = 120;
    const { host } = await mount(<DayNote note={NOTE} />);
    const text = host.querySelector<HTMLParagraphElement>(".clamped-text")!;
    const toggle = host.querySelector<HTMLButtonElement>(".clamped-text__toggle")!;

    expect(toggle).toHaveTextContent("展開全文");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", text.id);
    expect(text).toHaveAttribute("data-expanded", "false");

    await act(async () => toggle.click());
    expect(toggle).toHaveTextContent("收起");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(text).toHaveAttribute("data-expanded", "true");
    expect(text.textContent).toBe(NOTE);

    await act(async () => toggle.click());
    expect(toggle).toHaveTextContent("展開全文");
    expect(text).toHaveAttribute("data-expanded", "false");
  });

  it("re-measures when the box resizes and when the note changes", async () => {
    fullTextHeight = 44;
    const { host, root } = await mount(<DayNote note="一行" />);
    expect(host.querySelector("button")).toBeNull();

    fullTextHeight = 120;
    await act(async () => observers.forEach((measure) => measure()));
    expect(host.querySelector("button")).toHaveTextContent("展開全文");

    fullTextHeight = 44;
    await act(async () => root.render(<DayNote note="改短了" />));
    expect(host.querySelector("button")).toBeNull();
  });
});

describe("行程 tab day title and day-note card", () => {
  beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T01:30:00Z")); });

  it("puts the day title after the date and the note card between reminders and the timeline", () => {
    const host = staticToday(todayModelWith({ title: "東山散步", note: NOTE }));

    expect(host.querySelector(".today-pagehead h2")).toHaveTextContent(/^今天・10月21日週三・東山散步$/);
    const grid = host.querySelector(".today-grid")!;
    expect(grid).toHaveClass("has-dayplan");
    const card = grid.querySelector(".today-dayplan")!;
    expect(card.querySelector("h3")).toHaveTextContent("今天玩法");
    expect(card.querySelector(".clamped-text")?.textContent).toBe(NOTE);
    expect(card.querySelector<HTMLElement>(".clamped-text")!.style.getPropertyValue("--clamped-text-lines")).toBe("2");
    const order = [...grid.children].map((child) => child.className.split(" ")[0]);
    expect(order.indexOf("today-dayplan")).toBe(order.indexOf("today-timeline") - 1);
    expect(order.indexOf("today-dayplan")).toBeGreaterThan(order.indexOf("today-reminder"));
  });

  it("titles the card 這天玩法 when the selected day is not today in the trip's time zone", () => {
    const trip = todayTrip();
    const skeleton = todaySkeleton(trip);
    const otherDay = skeleton.days[1]!;
    Object.assign(otherDay, { title: null, note: NOTE });
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<TodayWorkspace
      model={createTodayModel(trip, skeleton, [], todayUser.id)}
      selectedDate={otherDay.date}
      onDayChanged={() => {}}
      fetchedAt="2026-10-21T01:30:00Z"
      retry={() => {}}
    />);

    expect(otherDay.date).not.toBe("2026-10-21");
    expect(host.querySelector(".today-dayplan h3")).toHaveTextContent(/^這天玩法$/);
    expect(host.querySelector(".today-dayplan")).toHaveAttribute("aria-label", "這天玩法");
  });

  it("shows only the date and no card when the day has neither title nor note", () => {
    const host = staticToday(todayModelWith({ title: null, note: null }));

    expect(host.querySelector(".today-pagehead h2")).toHaveTextContent(/^今天・10月21日週三$/);
    expect(host.querySelector(".today-dayplan")).toBeNull();
    expect(host.querySelector(".today-grid")).not.toHaveClass("has-dayplan");
  });

  it("toggles 看完整玩法 only for an overflowing note", async () => {
    fullTextHeight = 120;
    const { host } = await mount(today(todayModelWith({ title: null, note: NOTE })));
    const toggle = host.querySelector<HTMLButtonElement>(".today-dayplan .clamped-text__toggle")!;

    expect(toggle).toHaveTextContent("看完整玩法");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await act(async () => toggle.click());
    expect(toggle).toHaveTextContent("收起");
    expect(host.querySelector(".today-dayplan .clamped-text")).toHaveAttribute("data-expanded", "true");
    await act(async () => toggle.click());
    expect(toggle).toHaveTextContent("看完整玩法");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("shows no toggle when the note fits in two lines", async () => {
    fullTextHeight = 44;
    const { host } = await mount(today(todayModelWith({ title: null, note: "散步就好" })));

    expect(host.querySelector(".today-dayplan")).toHaveTextContent("散步就好");
    expect(host.querySelector(".today-dayplan button")).toBeNull();
  });

  it("shows a stored snapshot's title and note while offline", () => {
    const store = new TodaySnapshotStore(localStorage);
    store.save(todayUser.id, todayModelWith({ title: "東山散步", note: NOTE }), Date.parse("2026-10-21T01:30:00Z"));
    const snapshot = new TodaySnapshotStore(localStorage).read(todayUser.id, "A", Date.parse("2026-10-21T01:30:00Z"))!;

    const host = staticToday(snapshot.model, true);

    expect(host.querySelector(".today-notice")).toHaveTextContent("離線資料");
    expect(host.querySelector(".today-pagehead h2")).toHaveTextContent("東山散步");
    expect(host.querySelector(".today-dayplan .clamped-text")?.textContent).toBe(NOTE);
  });
});
