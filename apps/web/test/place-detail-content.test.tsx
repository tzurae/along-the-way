// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GooglePlacePhotoDto, PlaceDetailResponse, PlacePhotoDto } from "@along-the-way/contracts/place-details";
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

function googlePhoto(index: 0 | 1 | 2, author: string): GooglePlacePhotoDto {
  const providerPlaceId = "ChIJGooglePhoto123";
  const fingerprint = String(index + 1).repeat(16);
  const capability = `resource=photo-resource-${index}&maxWidth=`;
  const suffix = `&exp=1791676799&sig=${"A".repeat(43)}`;
  return {
    source: "google",
    index,
    id: `google:${providerPlaceId}:${index}:${fingerprint}`,
    thumbnailUrl: `/api/trips/${tripId}/google-place-photos/${providerPlaceId}?index=${index}&photo=${fingerprint}&${capability}192${suffix}`,
    imageUrl: `/api/trips/${tripId}/google-place-photos/${providerPlaceId}?index=${index}&photo=${fingerprint}&${capability}1024${suffix}`,
    width: 1200,
    height: 800,
    authors: [{ displayName: author, uri: `https://maps.google.com/contrib/${index}` }],
    googleMapsUri: `https://maps.google.com/?cid=${index}`,
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
    googlePhotos: [],
    photosUnavailable: false,
    commonsPhotoReportable: false,
  },
};

const request: PlaceDetailRequest = async <T,>(_path: string, init?: RequestInit & { parse?: (value: unknown) => unknown }) => {
  return (init?.parse ? init.parse(response) : response) as T;
};

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

it("activates Google slides on demand and keeps selection, failure, and per-photo credit aligned", async () => {
  let observerRoot: Element | Document | null | undefined;
  let observerCallback: IntersectionObserverCallback | undefined;
  const observedSlides: Element[] = [];
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      observerCallback = callback;
      observerRoot = options?.root;
    }
    observe(target: Element) { observedSlides.push(target); }
    disconnect() {}
  });
  const googlePhotos = [
    googlePhoto(0, "攝影者甲"),
    googlePhoto(1, "攝影者乙"),
    googlePhoto(2, "攝影者丙"),
  ];
  const googleResponse: PlaceDetailResponse = {
    detail: {
      ...response.detail,
      photos: [],
      googlePhotos,
    },
  };
  const googleRequest: PlaceDetailRequest = async <T,>(_path: string, init?: PlaceDetailRequestOptions) =>
    (init?.parse ? init.parse(googleResponse) : googleResponse) as T;

  render(<PlaceDetailContent tripId={tripId} reference={{ kind: "trip-place", id: referenceId }} request={googleRequest} />);
  const first = await screen.findByAltText("測試景點的照片，第 1 張，共 3 張");
  const slides = Array.from(document.querySelectorAll<HTMLElement>("[data-photo-slide]"));
  expect(first).toHaveAttribute("src", googlePhotos[0]!.imageUrl);
  expect(slides).toHaveLength(3);
  expect(slides[1]!.querySelector("img")).not.toBeInTheDocument();
  expect(slides[2]!.querySelector("img")).not.toBeInTheDocument();
  expect(observerRoot).toBe(document.querySelector(".place-gallery__track"));
  expect(observedSlides).toEqual(slides.slice(1));
  expect(screen.getByText("1／3")).toBeInTheDocument();
  expect(document.querySelector(`[data-photo-credit="${googlePhotos[0]!.id}"]`)).toHaveTextContent("Google Maps・照片：攝影者甲");

  act(() => observerCallback?.([
    { isIntersecting: true, intersectionRatio: 0, target: slides[1]! } as unknown as IntersectionObserverEntry,
  ], {} as IntersectionObserver));
  expect(slides[1]!.querySelector("img")).not.toBeInTheDocument();

  act(() => observerCallback?.([
    { isIntersecting: true, intersectionRatio: 0.6, target: slides[1]! } as unknown as IntersectionObserverEntry,
  ], {} as IntersectionObserver));
  const second = await screen.findByAltText("測試景點的照片，第 2 張，共 3 張");
  expect(second).toHaveAttribute("src", googlePhotos[1]!.imageUrl);
  expect(screen.getByText("1／3")).toBeInTheDocument();
  expect(slides[2]!.querySelector("img")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "下一張照片" }));
  expect(screen.getByText("2／3")).toBeInTheDocument();
  expect(document.querySelector(`[data-photo-credit="${googlePhotos[1]!.id}"]`)).toHaveTextContent("Google Maps・照片：攝影者乙");
  expect(slides[2]!.querySelector("img")).not.toBeInTheDocument();

  fireEvent.error(second);
  expect(await screen.findByText("照片載入失敗", { exact: true })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^重新載入照片$/ }));
  expect(screen.getByAltText("測試景點的照片，第 2 張，共 3 張")).toHaveAttribute("src", googlePhotos[1]!.imageUrl);

  fireEvent.click(screen.getByRole("button", { name: "下一張照片" }));
  expect(await screen.findByAltText("測試景點的照片，第 3 張，共 3 張")).toHaveAttribute("src", googlePhotos[2]!.imageUrl);
  expect(screen.getByText("3／3")).toBeInTheDocument();
  expect(document.querySelector(`[data-photo-credit="${googlePhotos[2]!.id}"]`)).toHaveTextContent("Google Maps・照片：攝影者丙");
});

it("shows a calm explicit empty state when neither curated nor Google photos exist", async () => {
  const emptyResponse: PlaceDetailResponse = {
    detail: { ...response.detail, photos: [], googlePhotos: [] },
  };
  const emptyRequest: PlaceDetailRequest = async <T,>(_path: string, init?: PlaceDetailRequestOptions) =>
    (init?.parse ? init.parse(emptyResponse) : emptyResponse) as T;

  render(<PlaceDetailContent tripId={tripId} reference={{ kind: "trip-place", id: referenceId }} request={emptyRequest} />);
  await screen.findByText("此地點目前沒有照片", { exact: true });
  expect(document.querySelector(".place-gallery__empty svg")).not.toBeInTheDocument();
});

it("distinguishes a temporary photo outage from a place with no photos", async () => {
  const unavailableResponse: PlaceDetailResponse = {
    detail: { ...response.detail, photos: [], googlePhotos: [], photosUnavailable: true },
  };
  const unavailableRequest: PlaceDetailRequest = async <T,>(_path: string, init?: PlaceDetailRequestOptions) =>
    (init?.parse ? init.parse(unavailableResponse) : unavailableResponse) as T;

  render(<PlaceDetailContent tripId={tripId} reference={{ kind: "trip-place", id: referenceId }} request={unavailableRequest} />);
  await screen.findByText("照片暫時無法載入", { exact: true });
  expect(screen.queryByText("此地點目前沒有照片", { exact: true })).not.toBeInTheDocument();
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
