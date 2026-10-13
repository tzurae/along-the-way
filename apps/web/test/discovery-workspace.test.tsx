// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { TripDto } from "@along-the-way/contracts/private-trips";
import { DiscoveryWorkspace } from "../src/DiscoveryWorkspace";
import type { PlaceDetailRequestOptions } from "../src/PlaceThumbnail";

const trip: TripDto = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "京都家庭旅行",
  startDate: "2026-11-03",
  endDate: "2026-11-09",
  defaultCurrency: "JPY",
  countryStops: [{ id: "44444444-4444-4444-8444-444444444444", countryCode: "JP", position: 0, timeZone: "Asia/Tokyo" }],
  days: [{ id: "55555555-5555-4555-8555-555555555555", date: "2026-11-03", title: null }],
  members: [],
  invites: [],
  memberCount: 2,
  dayCount: 1,
  role: "owner",
  version: 1,
};

const proposal = {
  id: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333",
  providerPlaceId: "ChIJ-Nishiki",
  name: "錦市場",
  type: "activity",
  address: null,
  latitude: null,
  longitude: null,
  sourceUrl: null,
  recommendation: "適合安排成輕鬆的市場散步。",
  recommendationSentences: null,
  matchedNeeds: ["在地美食"],
  tradeoffs: [],
  tradeoffSentences: null,
  unknowns: [],
  status: "pending",
  evidence: [],
  voters: [],
  voteCount: 0,
  ownVote: false,
  votingAvailable: true,
  acceptedTripPlaceId: null,
  version: 1,
  category: "市場",
  endorsements: [],
};

beforeEach(() => {
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  Object.defineProperty(window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 1; } });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("renders proposal behavior in the compact shared row without exposing the address", async () => {
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    let value: unknown;
    if (path.endsWith("/discovery")) {
      value = { discovery: {
        brief: null,
        latestRun: null,
        proposals: [proposal],
        decided: [],
        feedback: [],
        modelAvailable: true,
        placeProviderAvailable: true,
      } };
    } else if (path.endsWith("/trip-places")) {
      value = { tripPlaces: [] };
    } else if (path.includes("/place-previews?")) {
      value = { previews: [{ reference: { kind: "proposal", id: proposal.id }, photo: null, photoCount: 0 }] };
    } else {
      throw new Error(`Unexpected request: ${path}`);
    }
    return (init?.parse ? init.parse(value) : value) as T;
  };

  const { container } = render(<DiscoveryWorkspace trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
  const heading = await screen.findByRole("heading", { name: "AI 建議" });
  const headingCopy = heading.closest(".pd-pagehead-copy")!;
  expect(within(headingCopy as HTMLElement).getByText("只要說明一次旅程需求，AI 就會研究可信來源、在 Google Maps 確認每個地點，並只顯示至少有兩個獨立來源推薦的地點。", { exact: true })).toBeInTheDocument();

  const row = await waitFor(() => {
    const element = container.querySelector<HTMLElement>('[data-place-list-row][data-discovery-proposal="錦市場"]');
    expect(element).not.toBeNull();
    return element!;
  });
  expect(row).toHaveTextContent("適合安排成輕鬆的市場散步。");
  expect(row).toHaveTextContent("來源未逐句對應");
  expect(row).toHaveTextContent("待討論");
  expect(row).not.toHaveTextContent("地址未知");
  expect(row.querySelectorAll(".pd-vote-control")).toHaveLength(1);
  expect(within(row).getByRole("button", { name: "不要再推薦" })).toBeVisible();
  expect(within(row).getByRole("button", { name: "加入口袋名單" })).toBeVisible();
});

it("orders accepted proposal detail and shows its wishlist items read-only with a deep link", async () => {
  const acceptedPlaceId = "66666666-6666-4666-8666-666666666666";
  const accepted = { ...proposal, status: "accepted", acceptedTripPlaceId: acceptedPlaceId };
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    let value: unknown;
    if (path.endsWith("/discovery")) {
      value = { discovery: {
        brief: null,
        latestRun: null,
        proposals: [accepted],
        decided: [],
        feedback: [],
        modelAvailable: true,
        placeProviderAvailable: true,
      } };
    } else if (path.endsWith("/trip-places")) {
      value = { tripPlaces: [] };
    } else if (path.includes("/place-previews?")) {
      value = { previews: [{ reference: { kind: "proposal", id: proposal.id }, photo: null, photoCount: 0 }] };
    } else if (path.includes("/place-details?")) {
      value = { detail: {
        reference: { kind: "proposal", id: proposal.id },
        canonicalPlaceId: null,
        name: proposal.name,
        asOfDate: null,
        sections: [],
        sources: [],
        photos: [],
        googlePhotos: [],
      } };
    } else if (path.endsWith(`/${acceptedPlaceId}/must-items`)) {
      value = { items: [{
        id: "77777777-7777-4777-8777-777777777777",
        tripPlaceId: acceptedPlaceId,
        kind: "eat",
        label: "豆乳甜甜圈",
        version: 1,
        createdAt: "2026-10-14T00:00:00.000Z",
        updatedAt: "2026-10-14T00:00:00.000Z",
      }] };
    } else {
      throw new Error(`Unexpected request: ${path}`);
    }
    return (init?.parse ? init.parse(value) : value) as T;
  };

  render(<DiscoveryWorkspace trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "查看 錦市場 的詳情" }));
  const detail = await screen.findByRole("dialog", { name: "錦市場" });
  expect(await within(detail).findByText("豆乳甜甜圈")).toBeInTheDocument();
  expect(within(detail).queryByRole("button", { name: "編輯『豆乳甜甜圈』" })).not.toBeInTheDocument();
  const wishlist = within(detail).getByRole("link", { name: "到口袋名單查看或新增" });
  expect(wishlist).toHaveAttribute("href", expect.stringContaining(`place=${acceptedPlaceId}`));

  const headings = within(detail).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
  expect(headings).toEqual(expect.arrayContaining(["推薦重點", "必買／必吃／必喝", "需要注意", "地點", "佐證與景點資訊"]));
  expect(headings.indexOf("推薦重點")).toBeLessThan(headings.indexOf("必買／必吃／必喝"));
  expect(headings.indexOf("必買／必吃／必喝")).toBeLessThan(headings.indexOf("需要注意"));
  expect(headings.indexOf("需要注意")).toBeLessThan(headings.indexOf("地點"));
  expect(headings.indexOf("地點")).toBeLessThan(headings.indexOf("佐證與景點資訊"));
});
