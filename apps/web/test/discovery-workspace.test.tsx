// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

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

it("shows the AI description and renders proposals through the shared place-card anatomy", async () => {
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

  const card = await waitFor(() => {
    const element = container.querySelector<HTMLElement>('[data-place-card][data-discovery-proposal="錦市場"]');
    expect(element).not.toBeNull();
    return element!;
  });
  expect(card.querySelector(".list-place-card__location")).toHaveTextContent("地址未知");
  expect(card.querySelector(".list-place-card__description")).toHaveTextContent("適合安排成輕鬆的市場散步。");
  expect(card.querySelectorAll(".pd-vote-control")).toHaveLength(1);
  expect([...card.querySelector(".list-place-card__actions")!.children].map((child) => child.className)).toEqual([
    "list-place-card__vote",
    "list-place-card__wishlist-action",
  ]);
  expect(within(card).getByRole("button", { name: "加入口袋名單" })).toBeVisible();
});
