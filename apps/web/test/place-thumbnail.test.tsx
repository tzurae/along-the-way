// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { GooglePlacePhotoDto, PlacePreviewResponse } from "@along-the-way/contracts/place-details";
import {
  PlacePhotoCredit,
  PlaceThumbnail,
  usePlacePreviews,
  type PlaceDetailRequest,
  type PlaceDetailRequestOptions,
} from "../src/PlaceThumbnail";

const tripId = "11111111-1111-4111-8111-111111111111";
const providerPlaceId = "ChIJGooglePhoto123";
const photoFingerprint = "a1b2c3d4e5f60708";

function googlePhoto(overrides: Partial<GooglePlacePhotoDto> = {}): GooglePlacePhotoDto {
  return {
    source: "google",
    id: `google:${providerPlaceId}:${photoFingerprint}`,
    thumbnailUrl: `/api/trips/${tripId}/google-place-photos/${providerPlaceId}?photo=${photoFingerprint}&maxWidth=192`,
    imageUrl: `/api/trips/${tripId}/google-place-photos/${providerPlaceId}?photo=${photoFingerprint}&maxWidth=1024`,
    width: 1200,
    height: 800,
    authors: [{ displayName: "攝影者甲", uri: "https://maps.google.com/contrib/example" }],
    googleMapsUri: "https://maps.google.com/?cid=123",
    ...overrides,
  };
}

afterEach(cleanup);

it("renders a calm, wordless placeholder when no photo exists", () => {
  const { container } = render(<PlaceThumbnail photo={null} />);
  expect(container.querySelector('[data-place-thumbnail="empty"]')).toBeInTheDocument();
  expect(container.querySelector("img")).not.toBeInTheDocument();
  expect(container.querySelector("svg")).not.toBeInTheDocument();
  expect(container.querySelector(".place-thumbnail__empty")?.textContent).toBe("");
});

it("renders a reserved lazy Google thumbnail and policy attribution", () => {
  const photo = googlePhoto();
  const { container } = render(<><PlaceThumbnail photo={photo} /><PlacePhotoCredit photo={photo} /></>);
  const image = container.querySelector("img");
  expect(image).toHaveAttribute("src", photo.thumbnailUrl);
  expect(image).toHaveAttribute("width", "1200");
  expect(image).toHaveAttribute("height", "800");
  expect(image).toHaveAttribute("loading", "lazy");
  expect(image).toHaveAttribute("decoding", "async");
  expect(image).toHaveAttribute("alt", "");
  expect(screen.getByText("Google Maps", { exact: true })).toBeInTheDocument();
  expect(container.querySelector(".place-photo-credit--google")).toHaveTextContent("Google Maps・照片：攝影者甲");
  expect(screen.getByRole("link", { name: /^攝影者甲$/ })).toHaveAttribute("href", "https://maps.google.com/contrib/example");
  expect(screen.getByRole("link", { name: /^在 Google Maps 查看$/ })).toHaveAttribute("href", "https://maps.google.com/?cid=123");
});

it("keeps image failure local and resets it when the photo URL changes", async () => {
  const first = googlePhoto();
  const secondProviderPlaceId = "ChIJGooglePhoto456";
  const second = googlePhoto({
    id: `google:${secondProviderPlaceId}:${photoFingerprint}`,
    thumbnailUrl: `/api/trips/${tripId}/google-place-photos/${secondProviderPlaceId}?photo=${photoFingerprint}&maxWidth=192`,
    imageUrl: `/api/trips/${tripId}/google-place-photos/${secondProviderPlaceId}?photo=${photoFingerprint}&maxWidth=1024`,
  });
  const { container, rerender } = render(<PlaceThumbnail photo={first} />);
  fireEvent.error(container.querySelector("img")!);
  expect(container.querySelector("img")).not.toBeInTheDocument();
  expect(container.querySelector(".place-thumbnail__empty")).toBeInTheDocument();

  rerender(<PlaceThumbnail photo={second} />);
  await waitFor(() => expect(container.querySelector("img")).toHaveAttribute("src", second.thumbnailUrl));
});

it("retries one failed preview batch without erasing another batch's photos", async () => {
  const ids = Array.from({ length: 101 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
  const calls: string[][] = [];
  const request: PlaceDetailRequest = async <T,>(path: string, init?: PlaceDetailRequestOptions) => {
    const batch = new URL(path, "https://example.test").searchParams.get("ids")!.split(",");
    calls.push(batch);
    if (batch.includes(ids[0]!)) throw new Error("first batch unavailable");
    const raw: PlacePreviewResponse = {
      previews: [{ reference: { kind: "trip-place", id: ids[100]! }, photo: googlePhoto() }],
    };
    return (init?.parse ? init.parse(raw) : raw) as T;
  };

  function Harness() {
    const previews = usePlacePreviews({ tripId, kind: "trip-place", ids, request });
    return <>
      <PlaceThumbnail photo={previews.photos.get(ids[0]!)} loading={previews.loading} />
      <PlaceThumbnail photo={previews.photos.get(ids[100]!)} loading={previews.loading} />
    </>;
  }

  const { container } = render(<Harness />);
  await waitFor(() => expect(container.querySelector(`[data-place-thumbnail="${googlePhoto().id}"] img`)).toBeInTheDocument());
  expect(container.querySelector('[data-place-thumbnail="unavailable"]')).toBeInTheDocument();
  expect(calls.filter((batch) => batch.includes(ids[0]!))).toHaveLength(2);
  expect(calls.filter((batch) => batch.includes(ids[100]!))).toHaveLength(1);
});
