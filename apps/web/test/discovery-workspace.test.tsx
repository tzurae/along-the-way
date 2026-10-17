// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { TripDto } from "@along-the-way/contracts/private-trips";
import type { GooglePlacePhotoDto, PlacePhotoDto } from "@along-the-way/contracts/place-details";
import { DiscoveryWorkspace } from "../src/DiscoveryWorkspace";
import { AppToaster } from "../src/AppToaster";
import type { PlaceDetailRequestOptions } from "../src/PlaceThumbnail";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

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
  editorsCanSchedule: false,
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

const googlePhoto: GooglePlacePhotoDto = {
  source: "google",
  index: 0,
  id: "google:ChIJ-Nishiki:0:abcdef1234567890",
  thumbnailUrl: `/api/trips/${trip.id}/google-place-photos/ChIJ-Nishiki?index=0&photo=abcdef1234567890&maxWidth=192`,
  imageUrl: `/api/trips/${trip.id}/google-place-photos/ChIJ-Nishiki?index=0&photo=abcdef1234567890&maxWidth=1024`,
  width: 1200,
  height: 800,
  authors: [{ displayName: "市場攝影者", uri: "https://maps.google.com/contrib/market-author" }],
  googleMapsUri: "https://maps.google.com/?cid=123",
};

beforeEach(() => {
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  Object.defineProperty(window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 1; } });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  render(<AppToaster />);
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

  const { container } = render(<DiscoveryWorkspace accountId="account" trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
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
  // AI 建議 go only into the itinerary; there is no path into 口袋名單.
  expect(within(row).queryByRole("button", { name: "加入口袋名單" })).not.toBeInTheDocument();
});

it("renders an unsafe discovery citation as text instead of an external link", async () => {
  const unsafe = {
    ...proposal,
    recommendationSentences: [{ text: "市場適合散步。", evidenceIds: ["evidence-1"] }],
    evidence: [{
      id: "evidence-1",
      kind: "web-source",
      providerPlaceId: null,
      sourceUrl: "javascript:alert(document.domain)",
      title: "未受信任來源",
      attribution: "Web",
      observedAt: "2026-10-17T00:00:00Z",
      expiresAt: null,
      isStale: false,
    }],
  };
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    let value: unknown;
    if (path.endsWith("/discovery")) value = { discovery: { brief: null, latestRun: null, proposals: [unsafe], decided: [], modelAvailable: true, placeProviderAvailable: true } };
    else if (path.endsWith("/trip-places")) value = { tripPlaces: [] };
    else if (path.includes("/place-previews?")) value = { previews: [] };
    else if (path.includes("/place-details?")) value = { detail: {
      reference: { kind: "proposal", id: proposal.id }, canonicalPlaceId: null, name: proposal.name,
      asOfDate: null, sections: [], sources: [], photos: [], googlePhotos: [],
    } };
    else throw new Error(`Unexpected request: ${path}`);
    return (init?.parse ? init.parse(value) : value) as T;
  };

  render(<DiscoveryWorkspace accountId="account" trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
  await waitFor(() => expect(document.querySelector(`[data-proposal-detail-trigger="${proposal.id}"]`)).not.toBeNull());
  fireEvent.click(document.querySelector(`[data-proposal-detail-trigger="${proposal.id}"]`)!);
  const detail = await screen.findByRole("dialog", { name: proposal.name });
  const citation = within(detail).getByText("[1]");
  expect(citation.tagName).toBe("SPAN");
  expect(detail.querySelector('a[href^="javascript:"]')).toBeNull();
});

it("shows an accepted proposal's detail as reasons then location, without wishlist-only sections", async () => {
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
    } else {
      throw new Error(`Unexpected request: ${path}`);
    }
    return (init?.parse ? init.parse(value) : value) as T;
  };

  render(<DiscoveryWorkspace accountId="account" trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
  await waitFor(() => expect(document.querySelector(`[data-proposal-detail-trigger="${proposal.id}"]`)).not.toBeNull());
  fireEvent.click(document.querySelector(`[data-proposal-detail-trigger="${proposal.id}"]`)!);
  const detail = await screen.findByRole("dialog", { name: "錦市場" });
  expect(within(detail).queryByText("豆乳甜甜圈")).not.toBeInTheDocument();
  expect(within(detail).queryByRole("link", { name: "到口袋名單查看或新增" })).not.toBeInTheDocument();

  const headings = within(detail).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
  expect(headings).toEqual(expect.arrayContaining(["推薦重點", "地點"]));
  expect(headings.indexOf("推薦重點")).toBeLessThan(headings.indexOf("地點"));
  // Empty cautions and the article-style evidence section are not rendered.
  expect(headings).not.toEqual(expect.arrayContaining(["必買／必吃／必喝"]));
  expect(headings).not.toEqual(expect.arrayContaining(["需要注意"]));
  expect(headings).not.toEqual(expect.arrayContaining(["佐證與景點資訊"]));
});

it("opens proposal thumbnails during normal and selection modes without per-row credits", async () => {
  const selectableProposal = { ...proposal, latitude: 35.005, longitude: 135.765 };
  const requestWithPhoto = (photo: GooglePlacePhotoDto | PlacePhotoDto) => async <T,>(
    path: string,
    init?: PlaceDetailRequestOptions,
  ): Promise<T> => {
    let value: unknown;
    if (path.endsWith("/discovery")) {
      value = { discovery: {
        brief: null,
        latestRun: null,
        proposals: [selectableProposal],
        decided: [],
        modelAvailable: true,
        placeProviderAvailable: true,
      } };
    } else if (path.endsWith("/trip-places")) {
      value = { tripPlaces: [] };
    } else if (path.includes("/place-previews?")) {
      value = { previews: [{
        reference: { kind: "proposal", id: selectableProposal.id },
        photo,
        photoCount: 1,
      }] };
    } else if (path.includes("/place-details?")) {
      value = { detail: {
        reference: { kind: "proposal", id: selectableProposal.id },
        canonicalPlaceId: null,
        name: selectableProposal.name,
        asOfDate: null,
        sections: [],
        sources: [],
        photos: [],
        googlePhotos: [],
      } };
    } else {
      throw new Error(`Unexpected request: ${path}`);
    }
    return (init?.parse ? init.parse(value) : value) as T;
  };

  const rendered = render(
    <DiscoveryWorkspace accountId="account" trip={trip} request={requestWithPhoto(googlePhoto)} placesRevision={0} onPlacesChanged={vi.fn()} />,
  );
  const row = await waitFor(() => {
    const element = rendered.container.querySelector<HTMLElement>(`[data-discovery-proposal="${selectableProposal.name}"]`);
    expect(element?.querySelector("img")).toBeInTheDocument();
    return element!;
  });
  expect(row.querySelector(".place-photo-credit")).not.toBeInTheDocument();

  fireEvent.click(row.querySelector(".list-place-row__media")!);
  let detail = await screen.findByRole("dialog", { name: selectableProposal.name });
  fireEvent.click(within(detail).getByRole("button", { name: "關閉" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: selectableProposal.name })).not.toBeInTheDocument());

  // The row has its own 排入行程; the page-level one starts selection mode.
  fireEvent.click(screen.getAllByRole("button", { name: "排入行程" }).find((button) => !row.contains(button))!);
  expect(screen.getByRole("heading", { name: "已選 0 個地點" })).toBeInTheDocument();
  fireEvent.click(row.querySelector(".list-place-row__media")!);
  detail = await screen.findByRole("dialog", { name: selectableProposal.name });
  expect(detail).toBeInTheDocument();
  rendered.unmount();
});

it("updates a discovery vote immediately, blocks a double tap, never lets a late vote response undo a decision, and confirms with a fresh read", async () => {
  const discovery = {
    brief: null,
    latestRun: null,
    proposals: [proposal],
    decided: [],
    modelAvailable: true,
    placeProviderAvailable: true,
  };
  // While the vote is in flight another owner accepts the proposal; a refresh carries that.
  const accepted = { ...proposal, status: "accepted" as const, version: proposal.version + 1 };
  const concurrentRead = deferred<{ discovery: typeof discovery }>();
  const confirmedRead = deferred<{ discovery: typeof discovery }>();
  const voteResponse = deferred<{ proposal: typeof proposal }>();
  let discoveryReads = 0;
  let voteRequests = 0;
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    if (path.endsWith("/discovery") && !init?.method) {
      discoveryReads += 1;
      const value = discoveryReads === 1 ? { discovery }
        : discoveryReads === 2 ? await concurrentRead.promise
        : await confirmedRead.promise;
      return (init?.parse ? init.parse(value) : value) as T;
    }
    if (path.endsWith("/trip-places") && !init?.method) return { tripPlaces: [] } as T;
    if (path.includes("/place-previews?")) return { previews: [] } as T;
    if (path.endsWith(`/${proposal.id}/vote`) && init?.method === "PUT") {
      voteRequests += 1;
      const value = await voteResponse.promise;
      return (init.parse ? init.parse(value) : value) as T;
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  const rendered = render(
    <DiscoveryWorkspace accountId="account" trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />,
  );
  const button = await screen.findByRole("button", { name: "想去，0 票" });
  rendered.rerender(
    <DiscoveryWorkspace accountId="account" trip={trip} request={request} placesRevision={1} onPlacesChanged={vi.fn()} />,
  );
  await waitFor(() => expect(discoveryReads).toBe(2));

  fireEvent.click(button);
  fireEvent.click(button);

  expect(voteRequests).toBe(1);
  expect(button).toHaveAttribute("aria-pressed", "true");
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button).toHaveAccessibleName("已表態想去，1 票");
  expect(button).toBeDisabled();
  expect(screen.getByText("已選擇「錦市場」想去，正在儲存")).toBeInTheDocument();

  await act(async () => concurrentRead.resolve({ discovery: { ...discovery, proposals: [accepted] } }));
  expect(await screen.findByText("已選進行程・待排日期")).toBeInTheDocument();

  // The vote committed before the acceptance, so its response still says pending.
  await act(async () => voteResponse.resolve({ proposal: { ...proposal, ownVote: true, voteCount: 1 } }));
  await waitFor(() => expect(discoveryReads).toBe(3));
  expect(screen.getByText("已選進行程・待排日期")).toBeInTheDocument();
  expect(screen.queryByText("待討論")).not.toBeInTheDocument();

  await act(async () => confirmedRead.resolve({ discovery: { ...discovery, proposals: [{ ...accepted, ownVote: true, voteCount: 1 }] } }));
  expect(screen.getByText("已選進行程・待排日期")).toBeInTheDocument();
  expect(screen.queryByText("待討論")).not.toBeInTheDocument();
});

it("restores a failed discovery vote, announces the exact error, and reuses its idempotency key", async () => {
  const discovery = {
    brief: null,
    latestRun: null,
    proposals: [proposal],
    decided: [],
    modelAvailable: true,
    placeProviderAvailable: true,
  };
  const failedVote = deferred<never>();
  const idempotencyKeys: string[] = [];
  let voteRequests = 0;
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    let value: unknown;
    if (path.endsWith("/discovery") && !init?.method) value = { discovery };
    else if (path.endsWith("/trip-places") && !init?.method) value = { tripPlaces: [] };
    else if (path.includes("/place-previews?")) value = { previews: [] };
    else if (path.endsWith(`/${proposal.id}/vote`) && init?.method === "PUT") {
      voteRequests += 1;
      idempotencyKeys.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
      if (voteRequests === 1) return await failedVote.promise;
      value = { proposal: { ...proposal, ownVote: true, voteCount: 1 } };
    } else throw new Error(`Unexpected request: ${path}`);
    return (init?.parse ? init.parse(value) : value) as T;
  };

  render(<DiscoveryWorkspace accountId="account" trip={trip} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
  const button = await screen.findByRole("button", { name: "想去，0 票" });
  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-pressed", "true");
  await act(async () => failedVote.reject(new Error("offline")));

  await waitFor(() => expect(button).not.toBeDisabled());
  expect(button).toHaveAttribute("aria-pressed", "false");
  expect(button).toHaveAccessibleName("想去，0 票");
  expect(screen.getByRole("alert")).toHaveTextContent("無法更新「錦市場」的想去狀態；已恢復原狀，請再試一次。");

  fireEvent.click(button);
  await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
  expect(voteRequests).toBe(2);
  expect(idempotencyKeys[0]).toBeTruthy();
  expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
});
