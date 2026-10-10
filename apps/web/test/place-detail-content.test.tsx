// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PlaceDetailResponse, PlacePhotoDto } from "@along-the-way/contracts/place-details";
import { PlaceDetailContent } from "../src/PlaceDetailContent";
import type { PlaceDetailRequest } from "../src/PlaceThumbnail";

const tripId = "11111111-1111-4111-8111-111111111111";
const referenceId = "22222222-2222-4222-8222-222222222222";

function photo(id: string, title: string, author: string, licenseName: string): PlacePhotoDto {
  const query = `kind=trip-place&id=${referenceId}`;
  const imageHash = (id === "work-one" ? "a" : "c").repeat(64);
  const thumbnailHash = (id === "work-one" ? "b" : "d").repeat(64);
  return {
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
  expect(screen.getByText("照片暫時無法載入")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "下一張照片" }));
  expect(document.querySelector("[data-photo-credit='work-two']")).toHaveTextContent("作者乙");
  expect(document.querySelector("[data-photo-credit='work-two']")).toHaveTextContent("CC0 1.0");

  fireEvent.click(screen.getByRole("button", { name: /完整照片資訊/ }));
  await waitFor(() => expect(document.querySelector("[data-photo-viewer='work-two']")).toBeInTheDocument());
  expect(document.querySelector("[data-photo-viewer='work-two'] img")).toHaveAttribute("src", response.detail.photos[1]!.imageUrl);
  expect(document.querySelector("[data-photo-metadata='work-two']")).toHaveTextContent("作者乙");
  expect(document.querySelector("[data-photo-metadata='work-two']")).toHaveTextContent("CC0 1.0");
  expect(document.querySelector("[data-photo-metadata='work-two']")).toHaveTextContent("預覽以 CSS 裁切；原始檔未修改。");
});
