// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { TripDto } from "@along-the-way/contracts/private-trips";
import type { GooglePlacePhotoDto } from "@along-the-way/contracts/place-details";
import type { ProviderCandidatesResponse, TripPlaceDto } from "@along-the-way/contracts/trip-places";
import { ApiRequestError } from "../src/api-error";
import { TripPlaceWorkspace } from "../src/TripPlaceWorkspace";
import type { PlaceDetailRequestOptions } from "../src/PlaceThumbnail";

const tripId = "11111111-1111-4111-8111-111111111111";
const unscheduledId = "22222222-2222-4222-8222-222222222222";
const scheduledId = "33333333-3333-4333-8333-333333333333";
const providerPlaceId = "ChIJSearchPhoto123";
const photoFingerprint = "a1b2c3d4e5f60708";

function trip(role: "owner" | "editor"): TripDto {
  return {
    id: tripId,
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
    role,
    version: 1,
  };
}

function place(id: string, name: string, scheduled: boolean): TripPlaceDto {
  return {
    id,
    tripId,
    placeId: id === unscheduledId ? "66666666-6666-4666-8666-666666666666" : "77777777-7777-4777-8777-777777777777",
    legacyPlaceId: null,
    provider: "manual",
    aiProposalId: null,
    providerPlaceId: null,
    providerObservedAt: null,
    providerExpiresAt: null,
    providerAttribution: null,
    factsSource: "member",
    providerFactsExpired: false,
    name,
    type: "restaurant",
    address: "京都市中京區",
    latitude: 35.01,
    longitude: 135.76,
    timeZone: "Asia/Tokyo",
    status: scheduled ? "scheduled" : "ready",
    scheduled,
    selectedForItinerary: scheduled,
    unplacedFromDate: null,
    durationMinutes: null,
    assignedDayId: null,
    dayPosition: null,
    budgetAmountMinor: null,
    budgetCurrency: null,
    notes: `${name} 的家庭備註`,
    sourceUrl: null,
    voters: [],
    voteCount: 0,
    ownVote: false,
    votingAvailable: true,
    duplicateSuggestions: [],
    version: 1,
  };
}

function googlePhoto(): GooglePlacePhotoDto {
  return {
    source: "google",
    index: 0,
    id: `google:${providerPlaceId}:0:${photoFingerprint}`,
    thumbnailUrl: `/api/trips/${tripId}/google-place-photos/${providerPlaceId}?index=0&photo=${photoFingerprint}&maxWidth=192`,
    imageUrl: `/api/trips/${tripId}/google-place-photos/${providerPlaceId}?index=0&photo=${photoFingerprint}&maxWidth=1024`,
    width: 1200,
    height: 800,
    authors: [{ displayName: "搜尋攝影者", uri: "https://maps.google.com/contrib/search-author" }],
    googleMapsUri: "https://maps.google.com/?cid=456",
  };
}

function applyParser<T>(value: unknown, init?: PlaceDetailRequestOptions): T {
  return (init?.parse ? init.parse(value) : value) as T;
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
  Object.defineProperty(window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 1; } });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("reports result count, disables listed places, and clears stale search results before the next request settles", async () => {
  const firstResponse: ProviderCandidatesResponse = {
    attribution: "Google Maps",
    candidates: [
      {
        provider: "google", providerPlaceId, name: "清水寺", type: "activity", typeLabel: "佛寺", address: "京都府京都市東山區", latitude: 34.9948, longitude: 135.785, timeZone: "Asia/Tokyo",
        sourceUrl: "https://maps.google.com/?cid=1", attribution: "Google Maps", observedAt: "2026-10-12T00:00:00Z", expiresAt: "2026-11-11T00:00:00Z",
        photo: googlePhoto(), alreadyInWishlist: true,
      },
      {
        provider: "google", providerPlaceId: "ChIJSecondPlace123", name: "清水坂", type: "activity", typeLabel: "商店街", address: "京都府京都市東山區清水", latitude: 34.996, longitude: 135.78, timeZone: "Asia/Tokyo",
        sourceUrl: "https://maps.google.com/?cid=2", attribution: "Google Maps", observedAt: "2026-10-12T00:00:00Z", expiresAt: "2026-11-11T00:00:00Z",
        photo: null, alreadyInWishlist: false,
      },
    ],
  };
  let searchCount = 0;
  let settleSecond!: (value: ProviderCandidatesResponse) => void;
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    if (path.endsWith("/trip-places") && !init?.method) return { tripPlaces: [] } as T;
    if (path.includes("/place-previews?")) return applyParser({ previews: [] }, init);
    if (path.endsWith("/trip-places/search")) {
      searchCount += 1;
      if (searchCount === 1) return firstResponse as T;
      return new Promise<T>((resolve) => { settleSecond = (value) => resolve(value as T); });
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  render(<TripPlaceWorkspace trip={trip("owner")} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
  await screen.findByRole("heading", { name: /^口袋名單$/ });
  fireEvent.click(screen.getByRole("button", { name: /^加入地點$/ }));
  const dialog = await screen.findByRole("dialog", { name: /^加入地點$/ });
  fireEvent.change(within(dialog).getByLabelText("搜尋 Google Maps"), { target: { value: "清水寺" } });
  fireEvent.click(within(dialog).getByRole("button", { name: /^搜尋地點$/ }));

  expect(await within(dialog).findByText("找到 2 個地點")).toHaveAttribute("role", "status");
  expect(within(dialog).getByText("京都府京都市東山區", { exact: true })).toBeInTheDocument();
  expect(within(dialog).queryByText(/資料擷取於/)).not.toBeInTheDocument();
  expect(within(dialog).getByText("· 佛寺", { exact: true })).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: /^已在口袋名單：清水寺・佛寺$/ })).toBeDisabled();
  expect(dialog.querySelector(`[data-place-thumbnail="google:${providerPlaceId}:0:${photoFingerprint}"] img`)).toBeInTheDocument();

  fireEvent.change(within(dialog).getByLabelText("搜尋 Google Maps"), { target: { value: "伏見稻荷" } });
  fireEvent.click(within(dialog).getByRole("button", { name: /^搜尋地點$/ }));
  await waitFor(() => expect(within(dialog).queryByText("清水寺", { exact: true })).not.toBeInTheDocument());
  expect(within(dialog).queryByText(/^找到 \d+ 個地點$/)).not.toBeInTheDocument();
  await act(async () => settleSecond({ attribution: "Google Maps", candidates: [] }));
  expect(await within(dialog).findByText("找到 0 個地點")).toHaveAttribute("role", "status");
});

it("shows a zh-TW provider error instead of leaking the server's English message", async () => {
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    if (path.endsWith("/trip-places") && !init?.method) return { tripPlaces: [] } as T;
    if (path.includes("/place-previews?")) return applyParser({ previews: [] }, init);
    if (path.endsWith("/trip-places/search")) {
      throw new ApiRequestError(
        "provider_unavailable",
        "Google Places is temporarily unavailable; use manual entry instead",
        undefined,
        undefined,
        undefined,
        503,
      );
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  render(<TripPlaceWorkspace trip={trip("owner")} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
  await screen.findByRole("heading", { name: /^口袋名單$/ });
  fireEvent.click(screen.getByRole("button", { name: /^加入地點$/ }));
  const dialog = await screen.findByRole("dialog", { name: /^加入地點$/ });
  fireEvent.change(within(dialog).getByLabelText("搜尋 Google Maps"), { target: { value: "東福寺" } });
  fireEvent.click(within(dialog).getByRole("button", { name: /^搜尋地點$/ }));

  const alert = await within(dialog).findByRole("alert");
  expect(alert).toHaveTextContent("Google 地點服務暫時無法使用，請稍後再試或改用手動輸入。");
  expect(alert).not.toHaveTextContent("temporarily unavailable");
});

it("preserves search and note drafts when confirmation returns already_in_wishlist", async () => {
  const candidate: ProviderCandidatesResponse["candidates"][number] = {
    provider: "google", providerPlaceId, name: "清水寺", type: "activity", typeLabel: "佛寺", address: "京都府京都市東山區", latitude: 34.9948, longitude: 135.785, timeZone: "Asia/Tokyo",
    sourceUrl: "https://maps.google.com/?cid=1", attribution: "Google Maps", observedAt: "2026-10-12T00:00:00Z", expiresAt: "2026-11-11T00:00:00Z",
    photo: googlePhoto(), alreadyInWishlist: false,
  };
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    if (path.endsWith("/trip-places") && !init?.method) return { tripPlaces: [] } as T;
    if (path.includes("/place-previews?")) return applyParser({ previews: [] }, init);
    if (path.endsWith("/trip-places/search")) return { attribution: "Google Maps", candidates: [candidate] } as T;
    if (path.endsWith("/trip-places") && init?.method === "POST") throw new ApiRequestError("already_in_wishlist", "duplicate", undefined, undefined, undefined, 409);
    throw new Error(`Unexpected request: ${path}`);
  };

  render(<TripPlaceWorkspace trip={trip("owner")} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
  await screen.findByRole("heading", { name: /^口袋名單$/ });
  fireEvent.click(screen.getByRole("button", { name: /^加入地點$/ }));
  const dialog = await screen.findByRole("dialog", { name: /^加入地點$/ });
  const query = within(dialog).getByLabelText("搜尋 Google Maps");
  const note = within(dialog).getByLabelText("為什麼想去？（選填）");
  fireEvent.change(query, { target: { value: "清水寺" } });
  fireEvent.change(note, { target: { value: "家人想看夜間點燈" } });
  fireEvent.click(within(dialog).getByRole("button", { name: /^搜尋地點$/ }));
  fireEvent.click(await within(dialog).findByRole("button", { name: /^新增這個地點：清水寺・佛寺$/ }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("這個地點已在口袋名單。");
  expect(query).toHaveValue("清水寺");
  expect(note).toHaveValue("家人想看夜間點燈");
});

it("shows progress only on the pending candidate and restores its label after failure", async () => {
  const candidates: ProviderCandidatesResponse["candidates"] = [
    {
      provider: "google", providerPlaceId, name: "清水寺", type: "activity", typeLabel: "佛寺", address: "京都府京都市東山區", latitude: 34.9948, longitude: 135.785, timeZone: "Asia/Tokyo",
      sourceUrl: "https://maps.google.com/?cid=1", attribution: "Google Maps", observedAt: "2026-10-12T00:00:00Z", expiresAt: "2026-11-11T00:00:00Z",
      photo: null, alreadyInWishlist: false,
    },
    {
      provider: "google", providerPlaceId: "ChIJSecondPlace123", name: "清水坂", type: "activity", typeLabel: "商店街", address: "京都府京都市東山區清水", latitude: 34.996, longitude: 135.78, timeZone: "Asia/Tokyo",
      sourceUrl: "https://maps.google.com/?cid=2", attribution: "Google Maps", observedAt: "2026-10-12T00:00:00Z", expiresAt: "2026-11-11T00:00:00Z",
      photo: null, alreadyInWishlist: false,
    },
  ];
  let rejectAdd!: (reason?: unknown) => void;
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    if (path.endsWith("/trip-places") && !init?.method) return { tripPlaces: [] } as T;
    if (path.includes("/place-previews?")) return applyParser({ previews: [] }, init);
    if (path.endsWith("/trip-places/search")) return { attribution: "Google Maps", candidates } as T;
    if (path.endsWith("/trip-places") && init?.method === "POST") {
      return new Promise<T>((_resolve, reject) => { rejectAdd = reject; });
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  render(<TripPlaceWorkspace trip={trip("owner")} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
  await screen.findByRole("heading", { name: /^口袋名單$/ });
  fireEvent.click(screen.getByRole("button", { name: /^加入地點$/ }));
  const dialog = await screen.findByRole("dialog", { name: /^加入地點$/ });
  fireEvent.change(within(dialog).getByLabelText("搜尋 Google Maps"), { target: { value: "清水" } });
  fireEvent.click(within(dialog).getByRole("button", { name: /^搜尋地點$/ }));

  const pendingButton = await within(dialog).findByRole("button", { name: /^新增這個地點：清水寺・佛寺$/ });
  const otherButton = within(dialog).getByRole("button", { name: /^新增這個地點：清水坂・商店街$/ });
  fireEvent.click(pendingButton);

  expect(pendingButton).toHaveTextContent("新增中…");
  expect(pendingButton).toHaveAttribute("aria-busy", "true");
  expect(pendingButton).toBeDisabled();
  expect(within(dialog).getByText("正在新增「清水寺」…")).toHaveAttribute("role", "status");
  expect(otherButton).toHaveTextContent("新增這個地點");
  expect(otherButton).not.toHaveAttribute("aria-busy");
  expect(otherButton).toBeDisabled();

  await act(async () => rejectAdd(new Error("photo lookup failed")));
  await waitFor(() => expect(pendingButton).toHaveTextContent("新增這個地點"));
  expect(pendingButton).not.toHaveAttribute("aria-busy");
  expect(pendingButton).toBeEnabled();
  expect(otherButton).toBeEnabled();
  expect(within(dialog).queryByText("正在新增「清水寺」…")).not.toBeInTheDocument();
});

it("hides owner-only scheduling and scheduled removal while retaining editor collaboration", async () => {
  const places = [place(unscheduledId, "未排程咖啡店", false), place(scheduledId, "固定行程餐廳", true)];
  places[0]!.duplicateSuggestions = [{
    id: "88888888-8888-4888-8888-888888888888",
    otherTripPlaceId: scheduledId,
    reason: "same normalized name",
    status: "pending",
  }];
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    if (path.endsWith("/trip-places") && !init?.method) return { tripPlaces: places } as T;
    if (path.includes("/place-previews?")) {
      return applyParser({ previews: places.map((entry, index) => ({
        reference: { kind: "trip-place", id: entry.id },
        photo: index === 0 ? googlePhoto() : null,
        photoCount: index === 0 ? 3 : 0,
      })) }, init);
    }
    if (path.includes("/place-details?")) {
      const id = new URL(path, "https://example.test").searchParams.get("id")!;
      const selected = places.find((entry) => entry.id === id)!;
      return applyParser({ detail: {
        reference: { kind: "trip-place", id }, canonicalPlaceId: selected.placeId, name: selected.name,
        asOfDate: null, sections: [], sources: [], photos: [], googlePhotos: [],
      } }, init);
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  render(<TripPlaceWorkspace trip={trip("editor")} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
  await screen.findByText("未排程咖啡店", { exact: true });
  expect(screen.getAllByText("只有旅程擁有者可以排入、改期或移出行程。你仍可加入地點、投票與編輯備註。", { exact: true })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: /^排入行程$/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^加入地點$/ })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /^想去，/ }).length).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: /^查看 未排程咖啡店 的詳情$/ })).toBeVisible();
  const rows = [...document.querySelectorAll<HTMLElement>("[data-place-list-row]")];
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("想去：未排程咖啡店 的家庭備註");
  expect(rows[0]).not.toHaveTextContent("京都市中京區");
  for (const row of rows) expect(row.querySelectorAll(".pd-vote-control")).toHaveLength(1);
  const photographed = rows[0]!;
  await waitFor(() => expect(photographed.querySelectorAll("img")).toHaveLength(1));
  expect(within(photographed).getByRole("img", { name: "共 3 張照片" })).toHaveTextContent("+2");

  fireEvent.click(screen.getByRole("button", { name: /^查看 未排程咖啡店 的詳情$/ }));
  let detail = await screen.findByRole("dialog", { name: /^未排程咖啡店$/ });
  expect(within(detail).getByRole("button", { name: /^修改原因$/ })).toBeInTheDocument();
  expect(within(detail).getByRole("button", { name: "新增" })).toBeEnabled();
  expect(within(detail).getByRole("button", { name: /^從口袋名單移除$/ })).toBeInTheDocument();
  expect(within(detail).queryByRole("button", { name: /^排入行程$/ })).not.toBeInTheDocument();
  expect(within(detail).queryByRole("button", { name: /^合併$/ })).not.toBeInTheDocument();
  expect(within(detail).getByRole("button", { name: /^關閉$/ })).toHaveClass("min-h-11", "min-w-11");
  expect(within(detail).getByRole("button", { name: /^保持分開$/ })).toBeInTheDocument();
  fireEvent.click(within(detail).getByRole("button", { name: /^關閉$/ }));

  fireEvent.click(screen.getByRole("button", { name: /^查看 固定行程餐廳 的詳情$/ }));
  detail = await screen.findByRole("dialog", { name: /^固定行程餐廳$/ });
  expect(within(detail).getByRole("button", { name: /^修改原因$/ })).toBeInTheDocument();
  expect(within(detail).queryByRole("button", { name: /^更改日期$/ })).not.toBeInTheDocument();
  expect(within(detail).queryByRole("button", { name: /^從口袋名單移除$/ })).not.toBeInTheDocument();
});

it("round-trips duration and budget values when saving only the wishlist reason", async () => {
  const current = {
    ...place(unscheduledId, "哲學之道", false),
    durationMinutes: 75,
    budgetAmountMinor: 3200,
    budgetCurrency: "JPY",
    notes: "想看櫻花",
  };
  let savedPayload: Record<string, unknown> | null = null;
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    if (path.endsWith("/trip-places") && !init?.method) return { tripPlaces: [current] } as T;
    if (path.includes("/place-previews?")) return applyParser({ previews: [] }, init);
    if (path.includes("/place-details?")) return applyParser({ detail: {
      reference: { kind: "trip-place", id: current.id },
      canonicalPlaceId: current.placeId,
      name: current.name,
      asOfDate: null,
      sections: [],
      sources: [],
      photos: [],
      googlePhotos: [],
    } }, init);
    if (path.endsWith("/must-items") && !init?.method) return applyParser({ items: [] }, init);
    if (path.endsWith("/planning") && init?.method === "PATCH") {
      savedPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
      return applyParser({ tripPlace: { ...current, notes: savedPayload.notes, version: 2 } }, init);
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  render(<TripPlaceWorkspace trip={trip("editor")} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "查看 哲學之道 的詳情" }));
  const detail = await screen.findByRole("dialog", { name: "哲學之道" });
  expect(within(detail).queryByText("停留時間和預算")).not.toBeInTheDocument();
  fireEvent.click(within(detail).getByRole("button", { name: "修改原因" }));
  fireEvent.change(within(detail).getByRole("textbox"), { target: { value: "想在清晨散步" } });
  fireEvent.click(within(detail).getByRole("button", { name: "儲存" }));

  await waitFor(() => expect(savedPayload).toEqual({
    durationMinutes: 75,
    budgetAmountMinor: 3200,
    budgetCurrency: "JPY",
    notes: "想在清晨散步",
    expectedVersion: 1,
  }));
});
