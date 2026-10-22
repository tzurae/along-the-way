// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { NearbyActivitiesResponse, NearbyActivityDto } from "@along-the-way/contracts/trip-places";
import { ApiRequestError } from "../src/api-error";
import type { PlaceDetailRequest, PlaceDetailRequestOptions } from "../src/PlaceThumbnail";
import { TodayWorkspace } from "../src/TodayWorkspace";
import type { TodayDay, TodayModel } from "../src/today-model";

const temple: TodayDay["wishlist"][number] = {
  id: "stop-temple", name: "清水寺", type: "worship", latitude: 34.9949, longitude: 135.785, providerPlaceId: null, replacedStop: null,
};
const lane: TodayDay["wishlist"][number] = {
  id: "stop-lane", name: "二年坂", type: "restaurant", latitude: 34.998, longitude: 135.781, providerPlaceId: null, replacedStop: null,
};
const unlocated: TodayDay["wishlist"][number] = {
  id: "stop-unlocated", name: "沒有座標的店", type: "restaurant", latitude: null, longitude: null, providerPlaceId: null, replacedStop: null,
};

function model(wishlist: TodayDay["wishlist"] = [temple, lane]): TodayModel {
  return {
    tripId: "trip",
    tripName: "京都",
    tripVersion: 3,
    memberId: "member",
    days: [{ id: "day21", date: "2026-10-21", title: null, note: null, timeZone: "UTC", itemIds: [], wishlist }],
    items: [],
  };
}

function activity(overrides: Partial<NearbyActivityDto>): NearbyActivityDto {
  return {
    title: "秋季夜間特別拝観",
    description: "清水寺在秋季晚上點燈開放參拜。",
    timeText: null,
    startsAt: "2026-10-21T18:00",
    endsAt: "2026-10-21T21:30",
    kind: "event",
    venueName: "清水寺",
    latitude: 34.995,
    longitude: 135.785,
    straightLineMeters: 600,
    sourceUrl: "https://www.kiyomizudera.or.jp/event/lightup.html",
    sourceTitle: "清水寺 夜間特別拝観",
    ...overrides,
  };
}

function response(activities: NearbyActivityDto[]): NearbyActivitiesResponse {
  return { stopTripPlaceId: temple.id, date: "2026-10-21", fetchedAt: "2026-10-21T05:05:00Z", activities };
}

type Reply = { resolve(value: unknown): void; reject(reason: unknown): void };

/** Records every request; each one stays pending until the test answers it. */
function controlledRequest() {
  const calls: Array<{ url: string; init?: PlaceDetailRequestOptions; reply: Reply }> = [];
  const request: PlaceDetailRequest = async <T,>(url: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    // Previews and guides are not part of these tests.
    if (!url.endsWith("/nearby-activities")) return new Promise<T>(() => {});
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    calls.push({ url, init, reply: { resolve, reject } });
    const value = await promise;
    return (init?.parse ? init.parse(value) : value) as T;
  };
  return { calls, request };
}

function show(options: { request?: PlaceDetailRequest; canArrange?: boolean; offline?: boolean; wishlist?: TodayDay["wishlist"] } = {}) {
  return render(<TodayWorkspace
    model={model(options.wishlist)}
    selectedDate="2026-10-21"
    onDayChanged={() => {}}
    fetchedAt="2026-10-21T05:00:00Z"
    retry={() => {}}
    request={options.request}
    canArrange={options.canArrange}
    onChanged={async () => {}}
    offline={options.offline}
  />);
}

function pill(name: string) {
  return screen.queryByRole("button", { name: `看${name}附近的活動` });
}

async function openActivities(name: string) {
  await act(async () => fireEvent.click(pill(name)!));
  return screen.getByRole("dialog", { name: `${name}附近` });
}

async function answer(reply: Reply, value: unknown, failed = false) {
  await act(async () => (failed ? reply.reject(value) : reply.resolve(value)));
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-21T05:00:00Z"));
  // The sheet measures its title; jsdom has no layout.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("行程 附近活動", () => {
  it("sits beside 備案 in each located stop's leg row, including a stop without directions", () => {
    const { request } = controlledRequest();
    show({ request, canArrange: true, wishlist: [temple, lane, unlocated] });

    const templeRow = pill("清水寺")!.closest<HTMLElement>(".today-route-leg")!;
    expect(within(templeRow).getByRole("link", { name: /Google Maps/ })).toBeInTheDocument();
    expect(within(templeRow).getByRole("button", { name: "找清水寺附近的寺社備案" })).toBeInTheDocument();
    expect(pill("清水寺")).toHaveTextContent("附近活動");
    // The next stop has no coordinates, so there is no directions link; both quiet actions still share one row.
    const laneRow = pill("二年坂")!.closest<HTMLElement>(".today-route-leg")!;
    expect(within(laneRow).queryByRole("link", { name: /Google Maps/ })).toBeNull();
    expect(within(laneRow).getByRole("button", { name: "找二年坂附近的餐廳備案" })).toBeInTheDocument();
    expect(pill("沒有座標的店")).toBeNull();
  });

  it("is offered to a member who cannot arrange the itinerary, and hidden offline", () => {
    const { request } = controlledRequest();
    const { unmount } = show({ request, canArrange: false });
    expect(pill("清水寺")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^找清水寺附近的/ })).toBeNull();
    // The last stop has neither directions nor 備案 here; its own leg row still carries the pill.
    expect(pill("二年坂")!.closest(".today-route-leg")).toBeInTheDocument();
    unmount();

    show({ request, canArrange: true, offline: true });
    expect(pill("清水寺")).toBeNull();
    expect(pill("二年坂")).toBeNull();
  });

  it("loads in a sheet, then shows each activity as a card with its time, distance, and source", async () => {
    const { calls, request } = controlledRequest();
    show({ request });

    const dialog = await openActivities("清水寺");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/trips/trip/days/day21/trip-places/stop-temple/nearby-activities");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(within(dialog).getByRole("status")).toHaveTextContent("正在找附近的活動…");
    expect(dialog.querySelectorAll(".today-activity--skeleton")).toHaveLength(3);

    await answer(calls[0]!.reply, response([
      activity({}),
      activity({ title: "清水寺市集", startsAt: null, endsAt: null, straightLineMeters: 1_234, sourceTitle: null, sourceUrl: "https://market.example.jp/kiyomizu" }),
      activity({ title: "和服租借", kind: "experience", startsAt: null, endsAt: null, latitude: null, longitude: null, straightLineMeters: null, venueName: null }),
      activity({ title: "茶道體驗", startsAt: null, endsAt: null, timeText: "日落後" }),
    ]));

    expect(dialog.querySelectorAll(".today-activity--skeleton")).toHaveLength(0);
    const cards = within(dialog).getAllByRole("listitem");
    expect(cards.map((card) => within(card).getByRole("heading").textContent)).toEqual(["秋季夜間特別拝観", "清水寺市集", "和服租借", "茶道體驗"]);
    expect(cards[0]).toHaveTextContent("今天 18:00–21:30");
    expect(cards[0]).toHaveTextContent("直線 600 m");
    expect(cards[1]).toHaveTextContent("時間未確認");
    expect(cards[1]).toHaveTextContent("直線 1.2 km");
    expect(cards[2]).toHaveTextContent("常設");
    expect(cards[2]).not.toHaveTextContent("直線");
    expect(cards[3]).toHaveTextContent("日落後");

    const source = within(cards[0]!).getByRole("link", { name: /來源：清水寺 夜間特別拝観/ });
    expect(source).toHaveAttribute("href", "https://www.kiyomizudera.or.jp/event/lightup.html");
    expect(source).toHaveAttribute("target", "_blank");
    expect(source).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(cards[1]!).getByRole("link", { name: /來源：market\.example\.jp/ })).toBeInTheDocument();
    const maps = new URL(within(cards[0]!).getByRole("link", { name: /在 Google Maps 開啟/ }).getAttribute("href")!);
    expect(maps.searchParams.get("query")).toBe("秋季夜間特別拝観 34.995,135.785");
    expect(new URL(within(cards[2]!).getByRole("link", { name: /在 Google Maps 開啟/ }).getAttribute("href")!).searchParams.get("query")).toBe("和服租借");
    expect(dialog).toHaveTextContent("查詢於 05:05・結果可能有誤，出發前請看來源");
  });

  it("shows a single result as a card and an empty answer as a sentence", async () => {
    const { calls, request } = controlledRequest();
    show({ request });

    let dialog = await openActivities("清水寺");
    await answer(calls[0]!.reply, response([activity({})]));
    const list = within(dialog).getByRole("list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(list.querySelector("li.today-activity")).toHaveTextContent("秋季夜間特別拝観");

    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "關閉" })));
    dialog = await openActivities("清水寺");
    await answer(calls[1]!.reply, response([]));
    expect(within(dialog).getByRole("status")).toHaveTextContent("附近沒有找到今天的活動。");
    expect(within(dialog).queryByRole("listitem")).toBeNull();
  });

  it("offers a retry after a failure and no retry once the quota is used up", async () => {
    const { calls, request } = controlledRequest();
    show({ request });

    let dialog = await openActivities("清水寺");
    await answer(calls[0]!.reply, new ApiRequestError("provider_unavailable", "down", undefined, undefined, undefined, 503), true);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("暫時查不到，請再試一次。");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "再試一次" })));
    expect(calls).toHaveLength(2);
    expect(within(dialog).getByRole("status")).toHaveTextContent("正在找附近的活動…");
    await answer(calls[1]!.reply, response([activity({})]));
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(1);

    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "關閉" })));
    dialog = await openActivities("二年坂");
    await answer(calls[2]!.reply, new ApiRequestError("rate_limited", "slow down", undefined, undefined, undefined, 429), true);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("今天查詢次數已用完，請明天再試。");
    expect(within(dialog).queryByRole("button", { name: "再試一次" })).toBeNull();
  });

  it("returns focus to the pill that opened the sheet", async () => {
    const { calls, request } = controlledRequest();
    show({ request });

    const dialog = await openActivities("二年坂");
    await answer(calls[0]!.reply, { ...response([]), stopTripPlaceId: lane.id });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "關閉" })));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(pill("二年坂")).toHaveFocus());
  });
});
