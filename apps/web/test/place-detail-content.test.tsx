// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PlaceDetailResponse, PlacePhotoDto } from "@along-the-way/contracts/place-details";
import { PlaceDetailContent } from "../src/PlaceDetailContent";
import type { PlaceDetailRequest, PlaceDetailRequestOptions } from "../src/PlaceThumbnail";

const tripId = "11111111-1111-4111-8111-111111111111";
const referenceId = "22222222-2222-4222-8222-222222222222";

function photo(id: string, title: string, author: string, licenseName: string): PlacePhotoDto {
  const query = `kind=trip-place&id=${referenceId}`;
  const imageHash = (id === "work-one" ? "a" : "c").repeat(64);
  const thumbnailHash = (id === "work-one" ? "b" : "d").repeat(64);
  return {
    source: "curated",
    id,
    title,
    description: `${title}的完整構圖`,
    sourceName: "Wikimedia Commons",
    sourceUrl: `https://commons.wikimedia.org/wiki/File:${id}.jpg`,
    fileSourceUrl: `https://upload.wikimedia.org/${id}.jpg`,
    author,
    authorUrl: `https://commons.wikimedia.org/wiki/User:${author}`,
    creditText: `${title}，${author}`,
    licenseName,
    licenseUrl: licenseName === "CC0 1.0" ? "https://creativecommons.org/publicdomain/zero/1.0/" : "https://creativecommons.org/licenses/by-sa/4.0/",
    capturedAt: "2020-01-02",
    checkedAt: "2026-10-09T12:00:00Z",
    verificationUrl: `https://commons.wikimedia.org/w/index.php?title=File:${id}.jpg&oldid=1234`,
    locationEvidence: "作品頁明確標示此地點。",
    changes: "預覽以 CSS 裁切；原始檔未修改。",
    notices: [],
    originalWidth: 1600,
    originalHeight: 1200,
    imageUrl: `/api/trips/${tripId}/place-photo-assets/${imageHash}.jpg?${query}`,
    thumbnailUrl: `/api/trips/${tripId}/place-photo-assets/${thumbnailHash}.jpg?${query}`,
    width: 1200,
    height: 900,
  };
}

const response: PlaceDetailResponse = {
  detail: {
    reference: { kind: "trip-place", id: referenceId },
    canonicalPlaceId: "33333333-3333-4333-8333-333333333333",
    name: "測試景點",
    asOfDate: "2026-10-21",
    sections: [{ kind: "intro", title: "景點介紹", blocks: [{ text: "這是有來源的完整介紹。", style: "paragraph", sourceIds: ["official"], certainty: "sourced", needsRecheck: false }] }],
    sources: [{ id: "official", title: "官方網站", url: "https://example.test/place", checkedAt: "2026-10-09T12:00:00Z", publishedAt: null, validFrom: null, validUntil: null, expiresAt: null }],
    photos: [photo("work-one", "第一張作品", "作者甲", "CC BY-SA 4.0"), photo("work-two", "第二張作品", "作者乙", "CC0 1.0")],
    googlePhoto: null,
  },
};

const request: PlaceDetailRequest = async <T,>(_path: string, init?: RequestInit & { parse?: (value: unknown) => unknown }) => {
  return (init?.parse ? init.parse(response) : response) as T;
};

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("keeps a healthy selected work, credit, license, and full viewer aligned after another image fails", async () => {
  render(<PlaceDetailContent tripId={tripId} reference={{ kind: "trip-place", id: referenceId }} date="2026-10-21" request={request} />);
  await screen.findByText("這是有來源的完整介紹。");

  fireEvent.error(screen.getByAltText(/第一張作品.*第 1 張/));
  expect(await screen.findByText("照片載入失敗")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "下一張照片" }));
  const selectedCredit = document.querySelector<HTMLElement>("[data-photo-credit='work-two']");
  expect(selectedCredit).toHaveTextContent("作者乙");
  expect(within(selectedCredit!).getByRole("link", { name: "來源" })).toHaveAttribute("href", response.detail.photos[1]!.sourceUrl);
  expect(within(selectedCredit!).getByRole("link", { name: "授權" })).toHaveAttribute("href", response.detail.photos[1]!.licenseUrl);

  fireEvent.click(screen.getByRole("button", { name: /完整照片資訊/ }));
  await waitFor(() => expect(document.querySelector("[data-photo-viewer='work-two']")).toBeInTheDocument());
  expect(document.querySelector("[data-photo-viewer='work-two'] img")).toHaveAttribute("src", response.detail.photos[1]!.imageUrl);
  expect(document.querySelector("[data-photo-metadata='work-two']")).toHaveTextContent("作者乙");
  expect(document.querySelector("[data-photo-metadata='work-two']")).toHaveTextContent("CC0 1.0");
  expect(document.querySelector("[data-photo-metadata='work-two']")).toHaveTextContent("預覽以 CSS 裁切；原始檔未修改。");
});

it("keeps an image failure that fires before React flushes the gallery's effects", async () => {
  // Dispatch the native error in the MutationObserver microtask right after the gallery commits,
  // before React's passive effects run (a fast-failing image in a real browser behaves the same).
  const observer = new MutationObserver(() => {
    const image = document.querySelector<HTMLImageElement>('img[alt*="第一張作品"]');
    if (image && image.dataset.raced !== "1") {
      image.dataset.raced = "1";
      image.dispatchEvent(new Event("error"));
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    render(<PlaceDetailContent tripId={tripId} reference={{ kind: "trip-place", id: referenceId }} date="2026-10-21" request={request} />);
    expect(await screen.findByText("照片載入失敗")).toBeInTheDocument();
  } finally {
    observer.disconnect();
  }
});

it("uses the Google fallback with required attribution and recovers from an image failure", async () => {
  const providerPlaceId = "ChIJGooglePhoto123";
  const photoFingerprint = "a1b2c3d4e5f60708";
  const googleResponse: PlaceDetailResponse = {
    detail: {
      ...response.detail,
      photos: [],
      googlePhoto: {
        source: "google",
        id: `google:${providerPlaceId}:${photoFingerprint}`,
        thumbnailUrl: `/api/trips/${tripId}/google-place-photos/${providerPlaceId}?photo=${photoFingerprint}&maxWidth=192`,
        imageUrl: `/api/trips/${tripId}/google-place-photos/${providerPlaceId}?photo=${photoFingerprint}&maxWidth=1024`,
        width: 1200,
        height: 800,
        authors: [{ displayName: "攝影者甲", uri: "https://maps.google.com/contrib/example" }],
        googleMapsUri: "https://maps.google.com/?cid=123",
      },
    },
  };
  const googleRequest: PlaceDetailRequest = async <T,>(_path: string, init?: PlaceDetailRequestOptions) =>
    (init?.parse ? init.parse(googleResponse) : googleResponse) as T;

  render(<PlaceDetailContent tripId={tripId} reference={{ kind: "trip-place", id: referenceId }} request={googleRequest} />);
  const image = await screen.findByAltText("測試景點的照片");
  expect(image).toHaveAttribute("src", googleResponse.detail.googlePhoto!.imageUrl);
  expect(screen.getByText("Google Maps", { exact: true })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /^攝影者甲$/ })).toHaveAttribute("href", "https://maps.google.com/contrib/example");
  expect(screen.getByRole("link", { name: /^在 Google Maps 查看$/ })).toHaveAttribute("href", "https://maps.google.com/?cid=123");

  fireEvent.error(image);
  expect(await screen.findByText("照片載入失敗", { exact: true })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^重新載入照片$/ }));
  expect(screen.getByAltText("測試景點的照片")).toHaveAttribute("src", googleResponse.detail.googlePhoto!.imageUrl);
});

it("shows a calm explicit empty state when neither curated nor Google photos exist", async () => {
  const emptyResponse: PlaceDetailResponse = {
    detail: { ...response.detail, photos: [], googlePhoto: null },
  };
  const emptyRequest: PlaceDetailRequest = async <T,>(_path: string, init?: PlaceDetailRequestOptions) =>
    (init?.parse ? init.parse(emptyResponse) : emptyResponse) as T;

  render(<PlaceDetailContent tripId={tripId} reference={{ kind: "trip-place", id: referenceId }} request={emptyRequest} />);
  await screen.findByText("此地點目前沒有照片", { exact: true });
  expect(document.querySelector(".place-gallery__empty svg")).not.toBeInTheDocument();
});

it("offers a 44px-class retry action that repeats a failed detail request", async () => {
  let attempts = 0;
  const retryingRequest: PlaceDetailRequest = async <T,>(_path: string, init?: PlaceDetailRequestOptions) => {
    attempts += 1;
    if (attempts === 1) throw new Error("upstream unavailable");
    return (init?.parse ? init.parse(response) : response) as T;
  };

  render(<PlaceDetailContent tripId={tripId} reference={{ kind: "trip-place", id: referenceId }} request={retryingRequest} />);
  await screen.findByText("目前無法取得景點詳情。行程、投票與既有備註不受影響，可以稍後再試。");
  const retry = screen.getByRole("button", { name: /^重試$/ });
  expect(retry).toHaveClass("place-detail__retry");
  fireEvent.click(retry);
  await screen.findByText("這是有來源的完整介紹。");
  expect(attempts).toBe(2);
});
