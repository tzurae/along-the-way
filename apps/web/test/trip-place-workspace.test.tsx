// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { TripDto } from "@along-the-way/contracts/private-trips";
import type { GooglePlacePhotoDto, PlacePhotoDto } from "@along-the-way/contracts/place-details";
import type { ProviderCandidatesResponse, TripPlaceDto } from "@along-the-way/contracts/trip-places";
import { ApiRequestError } from "../src/api-error";
import { TripPlaceWorkspace } from "../src/TripPlaceWorkspace";
import { AppToaster } from "../src/AppToaster";
import type { PlaceDetailRequestOptions } from "../src/PlaceThumbnail";

const tripId = "11111111-1111-4111-8111-111111111111";
const unscheduledId = "22222222-2222-4222-8222-222222222222";
const scheduledId = "33333333-3333-4333-8333-333333333333";
const providerPlaceId = "ChIJSearchPhoto123";
const photoFingerprint = "a1b2c3d4e5f60708";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

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
    editorsCanSchedule: false,
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
    effortLevel: null,
    assignedDayId: null,
    dayPosition: null,
    replacedStop: null,
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
  const capability = "resource=photo-resource-0&maxWidth=";
  const suffix = `&exp=1791676799&sig=${"A".repeat(43)}`;
  return {
    source: "google",
    index: 0,
    id: `google:${providerPlaceId}:0:${photoFingerprint}`,
    thumbnailUrl: `/api/trips/${tripId}/google-place-photos/${providerPlaceId}?index=0&photo=${photoFingerprint}&${capability}192${suffix}`,
    imageUrl: `/api/trips/${tripId}/google-place-photos/${providerPlaceId}?index=0&photo=${photoFingerprint}&${capability}1024${suffix}`,
    width: 1200,
    height: 800,
    authors: [{ displayName: "搜尋攝影者", uri: "https://maps.google.com/contrib/search-author" }],
    googleMapsUri: "https://maps.google.com/?cid=456",
  };
}

const previewPhoto: PlacePhotoDto = {
  source: "commons",
  id: "wishlist-preview",
  title: "口袋名單地點",
  description: "口袋名單地點照片",
  sourceName: "Wikimedia Commons",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Wishlist_place.jpg",
  fileSourceUrl: "https://upload.wikimedia.org/wishlist-place.jpg",
  author: "口袋名單攝影者",
  authorUrl: null,
  creditText: "口袋名單地點，口袋名單攝影者",
  licenseName: "CC BY-SA 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  capturedAt: null,
  checkedAt: "2026-10-18T00:00:00Z",
  verificationUrl: "https://commons.wikimedia.org/w/index.php?title=File:Wishlist_place.jpg&oldid=1234",
  locationEvidence: "作品頁標示地點。",
  changes: "縮圖裁切。",
  notices: [],
  originalWidth: 1200,
  originalHeight: 800,
  imageUrl: `/api/trips/${tripId}/place-photo-assets/${"a".repeat(64)}.jpg?kind=trip-place&id=${unscheduledId}`,
  thumbnailUrl: `/api/trips/${tripId}/place-photo-assets/${"b".repeat(64)}.jpg?kind=trip-place&id=${unscheduledId}`,
  width: 1200,
  height: 800,
};

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
  render(<AppToaster />);
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

  render(<TripPlaceWorkspace accountId="account" trip={trip("owner")} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
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

  render(<TripPlaceWorkspace accountId="account" trip={trip("owner")} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
  await screen.findByRole("heading", { name: /^口袋名單$/ });
  fireEvent.click(screen.getByRole("button", { name: /^加入地點$/ }));
  const dialog = await screen.findByRole("dialog", { name: /^加入地點$/ });
  fireEvent.change(within(dialog).getByLabelText("搜尋 Google Maps"), { target: { value: "東福寺" } });
  fireEvent.click(within(dialog).getByRole("button", { name: /^搜尋地點$/ }));

  const alert = await screen.findByRole("alert");
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

  render(<TripPlaceWorkspace accountId="account" trip={trip("owner")} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
  await screen.findByRole("heading", { name: /^口袋名單$/ });
  fireEvent.click(screen.getByRole("button", { name: /^加入地點$/ }));
  const dialog = await screen.findByRole("dialog", { name: /^加入地點$/ });
  const query = within(dialog).getByLabelText("搜尋 Google Maps");
  const note = within(dialog).getByLabelText("為什麼想去？（選填）");
  fireEvent.change(query, { target: { value: "清水寺" } });
  fireEvent.change(note, { target: { value: "家人想看夜間點燈" } });
  fireEvent.click(within(dialog).getByRole("button", { name: /^搜尋地點$/ }));
  fireEvent.click(await within(dialog).findByRole("button", { name: /^新增這個地點：清水寺・佛寺$/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("這個地點已在口袋名單。");
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

  render(<TripPlaceWorkspace accountId="account" trip={trip("owner")} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
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

it("refreshes an auto-applied Commons row photo while keeping Google first in the open detail", async () => {
  const added: TripPlaceDto = {
    ...place(unscheduledId, "自動照片地點", false),
    provider: "google",
    providerPlaceId,
    providerObservedAt: "2026-10-18T00:00:00Z",
    providerExpiresAt: "2026-11-17T00:00:00Z",
    providerAttribution: "Google Maps",
    factsSource: "provider",
    sourceUrl: "https://maps.google.com/?cid=1",
  };
  const candidate: ProviderCandidatesResponse["candidates"][number] = {
    provider: "google",
    providerPlaceId,
    name: added.name,
    type: added.type,
    typeLabel: "餐廳",
    address: added.address,
    latitude: added.latitude,
    longitude: added.longitude,
    timeZone: added.timeZone,
    sourceUrl: added.sourceUrl,
    attribution: "Google Maps",
    observedAt: "2026-10-18T00:00:00Z",
    expiresAt: "2026-11-17T00:00:00Z",
    photo: googlePhoto(),
    alreadyInWishlist: false,
  };
  let addedOnServer = false;
  let autoApplied = false;
  let scheduledRefresh: (() => void) | null = null;
  const realSetTimeout = window.setTimeout.bind(window);
  vi.spyOn(window as Window, "setTimeout").mockImplementation((handler, timeout) => {
    if (timeout === 16_000) {
      scheduledRefresh = () => {
        if (typeof handler === "function") handler();
      };
      return 16_000;
    }
    return realSetTimeout(handler, timeout);
  });
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    if (path.endsWith("/trip-places") && !init?.method) {
      return applyParser({ tripPlaces: addedOnServer ? [added] : [] }, init);
    }
    if (path.endsWith("/trip-places/search")) {
      return applyParser({ attribution: "Google Maps", candidates: [candidate] }, init);
    }
    if (path.endsWith("/trip-places") && init?.method === "POST") {
      addedOnServer = true;
      return applyParser({ tripPlace: added }, init);
    }
    if (path.includes("/place-previews?")) {
      return applyParser({ previews: addedOnServer ? [{
        reference: { kind: "trip-place", id: added.id },
        photo: autoApplied ? previewPhoto : null,
        photoCount: autoApplied ? 1 : 0,
      }] : [] }, init);
    }
    if (path.includes("/place-details?")) {
      return applyParser({ detail: {
        reference: { kind: "trip-place", id: added.id },
        canonicalPlaceId: added.placeId,
        name: added.name,
        asOfDate: null,
        sections: [],
        sources: [],
        photos: [],
        googlePhotos: [googlePhoto()],
        photosUnavailable: false,
      } }, init);
    }
    if (path.endsWith("/must-items") && !init?.method) return applyParser({ items: [] }, init);
    throw new Error(`Unexpected request: ${path}`);
  };

  const rendered = render(
    <TripPlaceWorkspace accountId="account" trip={trip("owner")} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />,
  );
  await screen.findByRole("heading", { name: /^口袋名單$/ });
  fireEvent.click(screen.getByRole("button", { name: /^加入地點$/ }));
  const addDialog = await screen.findByRole("dialog", { name: /^加入地點$/ });
  fireEvent.change(within(addDialog).getByLabelText("搜尋 Google Maps"), { target: { value: added.name } });
  fireEvent.click(within(addDialog).getByRole("button", { name: /^搜尋地點$/ }));
  fireEvent.click(await within(addDialog).findByRole("button", { name: /^新增這個地點：自動照片地點・餐廳$/ }));

  const row = await waitFor(() => {
    const element = rendered.container.querySelector<HTMLElement>(`[data-wishlist-place="${added.name}"]`);
    expect(element).not.toBeNull();
    return element!;
  });
  await waitFor(() => expect(row.querySelector('[data-place-thumbnail="empty"]')).toBeInTheDocument());
  expect(document.querySelector(".commons-candidate-banner")).not.toBeInTheDocument();

  fireEvent.click(row.querySelector(".list-place-row__media")!);
  const detail = await screen.findByRole("dialog", { name: added.name });
  await waitFor(() => expect(detail.querySelector(`[data-photo-credit="${googlePhoto().id}"]`)).toHaveTextContent("Google Maps・照片：搜尋攝影者"));
  expect(scheduledRefresh).not.toBeNull();

  autoApplied = true;
  act(() => scheduledRefresh?.());

  await waitFor(() => expect(
    rendered.container.querySelector(`[data-wishlist-place="${added.name}"] [data-place-thumbnail="${previewPhoto.id}"] img`),
  ).toBeInTheDocument());
  expect(detail.querySelector(`[data-photo-credit="${googlePhoto().id}"]`)).toHaveTextContent("Google Maps・照片：搜尋攝影者");
  expect(detail.querySelector(`[data-photo-credit="${previewPhoto.id}"]`)).not.toBeInTheDocument();
  expect(document.querySelector(".commons-candidate-banner")).not.toBeInTheDocument();
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
        photo: index === 0 ? previewPhoto : null,
        photoCount: index === 0 ? 3 : 0,
      })) }, init);
    }
    if (path.includes("/place-details?")) {
      const id = new URL(path, "https://example.test").searchParams.get("id")!;
      const selected = places.find((entry) => entry.id === id)!;
      return applyParser({ detail: {
        reference: { kind: "trip-place", id }, canonicalPlaceId: selected.placeId, name: selected.name,
        asOfDate: null, sections: [], sources: [], photos: [], googlePhotos: [],
        photosUnavailable: false,
      } }, init);
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  render(<TripPlaceWorkspace accountId="account" trip={trip("editor")} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
  await screen.findByText("未排程咖啡店", { exact: true });
  expect(screen.getAllByText("只有旅程擁有者，或擁有者開放的編輯者，可以排入、改期或移出行程。你仍可加入地點、投票與編輯備註。", { exact: true })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: /^排入行程$/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^加入地點$/ })).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /^想去，/ }).length).toBeGreaterThan(0);
  expect(screen.getAllByRole("button", { name: /^查看 未排程咖啡店 的詳情$/ })).toHaveLength(2);
  const rows = [...document.querySelectorAll<HTMLElement>("[data-place-list-row]")];
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("想去：未排程咖啡店 的家庭備註");
  expect(rows[0]).not.toHaveTextContent("京都市中京區");
  for (const row of rows) expect(row.querySelectorAll(".pd-vote-control")).toHaveLength(1);
  const photographed = rows[0]!;
  await waitFor(() => expect(photographed.querySelectorAll("img")).toHaveLength(1));
  expect(within(photographed).getByRole("img", { name: "共 3 張照片" })).toHaveTextContent("+2");

  fireEvent.click(document.querySelector(`[data-place-detail-trigger="${unscheduledId}"]`)!);
  let detail = await screen.findByRole("dialog", { name: /^未排程咖啡店$/ });
  expect(within(detail).getByRole("button", { name: /^編輯停留時間與體力$/ })).toBeInTheDocument();
  expect(within(detail).getByRole("button", { name: "新增" })).toBeEnabled();
  // The detail only displays; removal lives in the row's ⋯ menu.
  expect(within(detail).queryByRole("button", { name: /^從口袋名單移除$/ })).not.toBeInTheDocument();
  expect(within(detail).queryByRole("button", { name: /^排入行程$/ })).not.toBeInTheDocument();
  expect(within(detail).queryByRole("button", { name: /^合併$/ })).not.toBeInTheDocument();
  expect(within(detail).getByRole("button", { name: /^關閉$/ })).toHaveClass("min-h-11", "min-w-11");
  expect(within(detail).getByRole("button", { name: /^保持分開$/ })).toBeInTheDocument();
  fireEvent.click(within(detail).getByRole("button", { name: /^關閉$/ }));

  fireEvent.click(document.querySelector(`[data-place-detail-trigger="${scheduledId}"]`)!);
  detail = await screen.findByRole("dialog", { name: /^固定行程餐廳$/ });
  expect(within(detail).queryByRole("button", { name: /^更改日期$/ })).not.toBeInTheDocument();
  expect(within(detail).queryByRole("button", { name: /^從口袋名單移除$/ })).not.toBeInTheDocument();

  // An editor without scheduling rights may remove an unscheduled place but not move or remove a scheduled one.
  fireEvent.click(within(detail).getByRole("button", { name: /^關閉$/ }));
  fireEvent.click(screen.getByRole("button", { name: "未排程咖啡店 的更多動作" }));
  expect(screen.getByRole("menuitem", { name: "從口袋名單移除" })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: "更改日期" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "固定行程餐廳 的更多動作" })).not.toBeInTheDocument();
});

it("renders unsafe wishlist and duplicate source URLs as text instead of external links", async () => {
  const current = { ...place(unscheduledId, "未受信任來源地點", false), sourceUrl: "javascript:alert(document.domain)" };
  const duplicate = { ...place(scheduledId, "重複地點", false), sourceUrl: "data:text/html,unsafe" };
  current.duplicateSuggestions = [{
    id: "88888888-8888-4888-8888-888888888888",
    otherTripPlaceId: duplicate.id,
    reason: "same normalized name",
    status: "pending",
  }];
  const places = [current, duplicate];
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    if (path.endsWith("/trip-places") && !init?.method) return { tripPlaces: places } as T;
    if (path.includes("/place-previews?")) return applyParser({ previews: [] }, init);
    if (path.includes("/place-details?")) return applyParser({ detail: {
      reference: { kind: "trip-place", id: current.id }, canonicalPlaceId: current.placeId, name: current.name,
      asOfDate: null, sections: [], sources: [], photos: [], googlePhotos: [],
      photosUnavailable: false,
    } }, init);
    throw new Error(`Unexpected request: ${path}`);
  };

  render(<TripPlaceWorkspace accountId="account" trip={trip("owner")} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
  await waitFor(() => expect(document.querySelector(`[data-place-detail-trigger="${current.id}"]`)).not.toBeNull());
  fireEvent.click(document.querySelector(`[data-place-detail-trigger="${current.id}"]`)!);
  const detail = await screen.findByRole("dialog", { name: current.name });
  const labels = within(detail).getAllByText("開啟原始來源");
  expect(labels).toHaveLength(3);
  expect(labels.every((label) => label.tagName === "SPAN")).toBe(true);
  expect(detail.querySelector('a[href^="javascript:"], a[href^="data:"]')).toBeNull();
});

it("keeps the reason, duration and budget when only the effort is changed", async () => {
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
      reference: { kind: "trip-place", id: current.id }, canonicalPlaceId: current.placeId, name: current.name,
      asOfDate: null, sections: [], sources: [], photos: [], googlePhotos: [], photosUnavailable: false,
    } }, init);
    if (path.endsWith("/must-items") && !init?.method) return applyParser({ items: [] }, init);
    if (path.endsWith("/planning-load")) throw new Error("planning load unavailable in this test");
    if (path.endsWith("/planning") && init?.method === "PATCH") {
      savedPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
      return applyParser({ tripPlace: { ...current, effortLevel: savedPayload.effortLevel, version: 2 } }, init);
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  render(<TripPlaceWorkspace accountId="account" trip={trip("editor")} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
  await waitFor(() => expect(document.querySelector(`[data-place-detail-trigger="${current.id}"]`)).not.toBeNull());
  fireEvent.click(document.querySelector(`[data-place-detail-trigger="${current.id}"]`)!);
  const detail = await screen.findByRole("dialog", { name: "哲學之道" });
  fireEvent.click(within(detail).getByRole("button", { name: "編輯停留時間與體力" }));
  fireEvent.click(within(detail).getByRole("radio", { name: "4・偏累" }));
  fireEvent.click(within(detail).getByRole("button", { name: "儲存規劃資訊" }));

  await waitFor(() => expect(savedPayload).toEqual({
    durationMinutes: 75,
    effortLevel: 4,
    budgetAmountMinor: 3200,
    budgetCurrency: "JPY",
    notes: "想看櫻花",
    expectedVersion: 1,
  }));
});

it("keeps thumbnail detail access in and out of selection mode with Commons row attribution", async () => {
  const current = place(unscheduledId, "縮圖測試地點", false);
  const requestWithPhoto = (photo: PlacePhotoDto) => async <T,>(
    path: string,
    init?: PlaceDetailRequestOptions,
  ): Promise<T> => {
    let value: unknown;
    if (path.endsWith("/trip-places") && !init?.method) {
      value = { tripPlaces: [current] };
    } else if (path.includes("/place-previews?")) {
      value = { previews: [{ reference: { kind: "trip-place", id: current.id }, photo, photoCount: 1 }] };
    } else if (path.includes("/place-details?")) {
      value = { detail: {
        reference: { kind: "trip-place", id: current.id },
        canonicalPlaceId: current.placeId,
        name: current.name,
        asOfDate: null,
        sections: [],
        sources: [],
        photos: [],
        googlePhotos: [],
        photosUnavailable: false,
      } };
    } else if (path.endsWith("/must-items") && !init?.method) {
      value = { items: [] };
    } else {
      throw new Error(`Unexpected request: ${path}`);
    }
    return applyParser(value, init);
  };

  const rendered = render(
    <TripPlaceWorkspace accountId="account" trip={trip("owner")} request={requestWithPhoto(previewPhoto)} placesRevision={0} onPlacesChanged={vi.fn()} />,
  );
  const row = await waitFor(() => {
    const element = rendered.container.querySelector<HTMLElement>(`[data-wishlist-place="${current.name}"]`);
    expect(element?.querySelector("img")).toBeInTheDocument();
    return element!;
  });
  expect(row.querySelector(".place-photo-credit")).toHaveTextContent("口袋名單攝影者・CC BY-SA 4.0");

  fireEvent.click(row.querySelector(".list-place-row__media")!);
  let detail = await screen.findByRole("dialog", { name: current.name });
  fireEvent.click(within(detail).getByRole("button", { name: "關閉" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: current.name })).not.toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: "排入行程" }));
  expect(screen.getByRole("heading", { name: "已選 0 個地點" })).toBeInTheDocument();
  fireEvent.click(row.querySelector(".list-place-row__media")!);
  detail = await screen.findByRole("dialog", { name: current.name });
  expect(detail).toBeInTheDocument();
  rendered.unmount();
});

it("updates a wishlist vote immediately, blocks a double tap, keeps a concurrent refresh, and confirms with a fresh read", async () => {
  const current = place(unscheduledId, "即時投票地點", false);
  // Another member's place arrives through a refresh that is in flight while the vote is pending.
  const added = place(scheduledId, "別人剛加入的地點", false);
  const concurrentRead = deferred<{ tripPlaces: TripPlaceDto[] }>();
  const voteResponse = deferred<{ tripPlace: TripPlaceDto }>();
  const onPlacesChanged = vi.fn();
  let listReads = 0;
  let voteRequests = 0;
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    if (path.endsWith("/trip-places") && !init?.method) {
      listReads += 1;
      if (listReads === 1) return applyParser({ tripPlaces: [current] }, init);
      if (listReads === 2) return applyParser(await concurrentRead.promise, init);
      return applyParser({ tripPlaces: [{ ...current, ownVote: true, voteCount: 1 }, added] }, init);
    }
    if (path.includes("/place-previews?")) return applyParser({ previews: [] }, init);
    if (path.endsWith(`/${current.id}/vote`) && init?.method === "PUT") {
      voteRequests += 1;
      return applyParser(await voteResponse.promise, init);
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  const rendered = render(
    <TripPlaceWorkspace accountId="account" trip={trip("editor")} request={request} placesRevision={0} onPlacesChanged={onPlacesChanged} />,
  );
  const button = await screen.findByRole("button", { name: "想去，0 票" });
  rendered.rerender(
    <TripPlaceWorkspace accountId="account" trip={trip("editor")} request={request} placesRevision={1} onPlacesChanged={onPlacesChanged} />,
  );
  await waitFor(() => expect(listReads).toBe(2));

  fireEvent.click(button);
  fireEvent.click(button);

  expect(voteRequests).toBe(1);
  expect(button).toHaveAttribute("aria-pressed", "true");
  expect(button).toHaveAttribute("aria-busy", "true");
  expect(button).toHaveAccessibleName("已表態想去，1 票");
  expect(button).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("已選擇「即時投票地點」想去，正在儲存");

  // The refresh read before the vote committed: its new place is kept, its old count is not shown.
  await act(async () => concurrentRead.resolve({ tripPlaces: [current, added] }));
  expect(await screen.findByText("別人剛加入的地點")).toBeInTheDocument();
  expect(button).toHaveAccessibleName("已表態想去，1 票");

  await act(async () => voteResponse.resolve({
    tripPlace: { ...current, ownVote: true, voteCount: 1 },
  }));
  await waitFor(() => expect(listReads).toBe(3));
  await waitFor(() => expect(button).not.toBeDisabled());
  expect(button).toHaveAttribute("aria-pressed", "true");
  expect(button).not.toHaveAttribute("aria-busy");
  expect(button).toHaveAccessibleName("已表態想去，1 票");
  expect(screen.getByText("別人剛加入的地點")).toBeInTheDocument();
  expect(onPlacesChanged).not.toHaveBeenCalled();
});

it("restores a failed wishlist vote, announces the exact error, and reuses its idempotency key", async () => {
  const current = place(unscheduledId, "失敗投票地點", false);
  const failedVote = deferred<never>();
  const idempotencyKeys: string[] = [];
  let voteRequests = 0;
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    if (path.endsWith("/trip-places") && !init?.method) return applyParser({ tripPlaces: [current] }, init);
    if (path.includes("/place-previews?")) return applyParser({ previews: [] }, init);
    if (path.endsWith(`/${current.id}/vote`) && init?.method === "PUT") {
      voteRequests += 1;
      idempotencyKeys.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
      if (voteRequests === 1) return await failedVote.promise;
      return applyParser({ tripPlace: { ...current, ownVote: true, voteCount: 1 } }, init);
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  render(<TripPlaceWorkspace accountId="account" trip={trip("editor")} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
  const button = await screen.findByRole("button", { name: "想去，0 票" });
  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-pressed", "true");
  await act(async () => failedVote.reject(new Error("offline")));

  await waitFor(() => expect(button).not.toBeDisabled());
  expect(button).toHaveAttribute("aria-pressed", "false");
  expect(button).toHaveAccessibleName("想去，0 票");
  expect(screen.getByRole("alert")).toHaveTextContent("無法更新「失敗投票地點」的想去狀態；已恢復原狀，請再試一次。");

  fireEvent.click(screen.getByRole("button", { name: "重試投票" }));
  await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
  expect(voteRequests).toBe(2);
  expect(idempotencyKeys[0]).toBeTruthy();
  expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
});

it("links an unlocated wishlist place to the working overview repair editor", async () => {
  const current = {
    ...place(unscheduledId, "待補位置地點", false),
    latitude: null,
    longitude: null,
    legacyPlaceId: "88888888-8888-4888-8888-888888888888",
  };
  const request = async <T,>(path: string, init?: PlaceDetailRequestOptions): Promise<T> => {
    if (path.endsWith("/trip-places") && !init?.method) return applyParser({ tripPlaces: [current] }, init);
    if (path.includes("/place-previews?")) return applyParser({ previews: [] }, init);
    if (path.includes("/place-details?")) return applyParser({
      detail: {
        reference: { kind: "trip-place", id: current.id },
        canonicalPlaceId: current.placeId,
        name: current.name,
        asOfDate: null,
        sections: [],
        sources: [],
        photos: [],
        googlePhotos: [],
        photosUnavailable: false,
      },
    }, init);
    throw new Error(`Unexpected request: ${path}`);
  };
  render(<TripPlaceWorkspace accountId="account" trip={trip("owner")} request={request} placesRevision={0} onPlacesChanged={vi.fn()} />);
  fireEvent.click((await screen.findAllByRole("button", { name: `查看 ${current.name} 的詳情` }))[0]!);
  const dialog = await screen.findByRole("dialog", { name: current.name });

  const repair = within(dialog).getByRole("link", { name: "補上位置" });
  expect(repair).toHaveAttribute("href", expect.stringContaining(`repair=${current.id}`));
  expect(repair).not.toHaveAttribute("href", expect.stringContaining("manage=places"));
});
