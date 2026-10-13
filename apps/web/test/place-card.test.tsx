// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { GooglePlacePhotoDto } from "@along-the-way/contracts/place-details";

import { PlaceCard } from "../src/PlaceCard";

afterEach(cleanup);

const photo: GooglePlacePhotoDto = {
  source: "google",
  index: 0,
  id: "google:place:0:fingerprint",
  thumbnailUrl: "/thumbnail",
  imageUrl: "/image",
  width: 1200,
  height: 800,
  authors: [],
  googleMapsUri: null,
};

it("renders one canonical place-card anatomy with ordered named slots", () => {
  const onOpen = vi.fn();
  const { container } = render(
    <PlaceCard
      name="清水寺"
      typeLabel="活動或景點"
      location="京都府京都市東山區"
      description={<span>想看秋季夜間點燈</span>}
      status={<span>尚未排程</span>}
      photo={photo}
      photoCount={1}
      loadingPhoto={false}
      photoCredit={<span>照片來源</span>}
      voteAction={<button type="button">想去</button>}
      ownerActions={<button type="button">排入行程</button>}
      wishlistAction={<button type="button">加入口袋名單</button>}
      selectionControl={<button type="button" role="checkbox" aria-checked="false">選擇</button>}
      onOpen={onOpen}
      openLabel="查看 清水寺 的詳情"
      dataAttribute={{ name: "wishlist-place", value: "清水寺" }}
    />,
  );

  const card = container.querySelector<HTMLElement>("[data-place-card]")!;
  expect(card).toHaveAttribute("data-wishlist-place", "清水寺");
  expect([...card.children].map((child) => child.className)).toEqual([
    "place-card__selection",
    "place-card__media",
    "place-card__body",
  ]);
  const body = card.querySelector<HTMLElement>(".place-card__body")!;
  expect([...body.children].map((child) => child.className)).toEqual([
    "place-card__heading",
    "place-card__identity",
    "place-card__description",
    "place-card__status",
    "place-card__credit",
    "place-card__actions",
  ]);
  const identity = body.querySelector(".place-card__identity")!;
  expect([...identity.children].map((child) => child.className)).toEqual([
    "place-card__type",
    "place-card__location",
  ]);
  expect([...body.querySelector(".place-card__actions")!.children].map((child) => child.className)).toEqual([
    "place-card__vote",
    "place-card__owner-actions",
    "place-card__wishlist-action",
  ]);
  expect(card.querySelectorAll(".pd-vote-control")).toHaveLength(0);

  fireEvent.click(screen.getByRole("button", { name: "查看 清水寺 的詳情" }));
  expect(onOpen).toHaveBeenCalledOnce();
});
