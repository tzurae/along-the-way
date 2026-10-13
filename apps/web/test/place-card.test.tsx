// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { GooglePlacePhotoDto } from "@along-the-way/contracts/place-details";

import { PlaceCard } from "../src/PlaceCard";
import { VoteControl } from "../src/VoteControl";

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
  const onActivate = vi.fn();
  const onVoteChange = vi.fn();
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
      voteAction={(
        <VoteControl
          name="清水寺"
          voters={[]}
          voteCount={0}
          ownVote={false}
          votingAvailable
          disabled={false}
          compact
          onChange={onVoteChange}
        />
      )}
      ownerActions={<button type="button">排入行程</button>}
      wishlistAction={<a href="#wishlist">加入口袋名單</a>}
      selectionControl={<button type="button" role="checkbox" aria-checked="false">選擇</button>}
      onOpen={onOpen}
      onActivate={onActivate}
      openLabel="查看 清水寺 的詳情"
      dataAttribute={{ name: "wishlist-place", value: "清水寺" }}
    />,
  );

  const card = container.querySelector<HTMLElement>("[data-place-card]")!;
  expect(card).toHaveAttribute("data-wishlist-place", "清水寺");
  expect([...card.children].map((child) => child.className)).toEqual([
    "list-place-card__selection",
    "list-place-card__media",
    "list-place-card__body",
  ]);
  const body = card.querySelector<HTMLElement>(".list-place-card__body")!;
  expect([...body.children].map((child) => child.className)).toEqual([
    "list-place-card__heading",
    "list-place-card__identity",
    "list-place-card__description",
    "list-place-card__status",
    "list-place-card__credit",
    "list-place-card__actions",
  ]);
  const identity = body.querySelector(".list-place-card__identity")!;
  expect([...identity.children].map((child) => child.className)).toEqual([
    "list-place-card__type",
    "list-place-card__location",
  ]);
  expect([...body.querySelector(".list-place-card__actions")!.children].map((child) => child.className)).toEqual([
    "list-place-card__vote",
    "list-place-card__owner-actions",
    "list-place-card__wishlist-action",
  ]);
  expect(card.querySelectorAll(".pd-vote-control")).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "查看 清水寺 的詳情" }));
  expect(onOpen).toHaveBeenCalledOnce();
  expect(onActivate).not.toHaveBeenCalled();

  fireEvent.click(card.querySelector(".list-place-card__location")!);
  expect(onActivate).toHaveBeenCalledOnce();

  fireEvent.click(screen.getByRole("button", { name: /^想去，/ }));
  fireEvent.click(screen.getByRole("button", { name: "排入行程" }));
  fireEvent.click(screen.getByRole("link", { name: "加入口袋名單" }));
  expect(onVoteChange).toHaveBeenCalledOnce();
  expect(onActivate).toHaveBeenCalledOnce();
});

it("routes title clicks through card selection instead of opening details in selection mode", () => {
  const onOpen = vi.fn();
  const onActivate = vi.fn();
  const { container } = render(
    <PlaceCard
      name="清水寺"
      typeLabel="活動或景點"
      location="京都府京都市東山區"
      description="想看秋季夜間點燈"
      photo={null}
      photoCount={0}
      state="selectable"
      selectionControl={<button type="button" role="checkbox" aria-checked="false">選擇</button>}
      onOpen={onOpen}
      onActivate={onActivate}
      openLabel="查看 清水寺 的詳情"
      dataAttribute={{ name: "wishlist-place", value: "清水寺" }}
    />,
  );

  expect(screen.queryByRole("button", { name: "查看 清水寺 的詳情" })).not.toBeInTheDocument();
  fireEvent.click(container.querySelector(".list-place-card__title")!);
  expect(onActivate).toHaveBeenCalledOnce();
  expect(onOpen).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("checkbox", { name: "選擇" }));
  expect(onActivate).toHaveBeenCalledOnce();
});

it("keeps scheduled feedback independent of selection mode and never invents it for an unscheduled change", () => {
  const base = {
    name: "東福寺", typeLabel: "活動或景點", location: "京都市東山區", description: "看紅葉",
    photo: null, photoCount: 0, onOpen: vi.fn(), openLabel: "查看 東福寺 的詳情",
    dataAttribute: { name: "wishlist-place", value: "東福寺" },
  } as const;
  const { container, rerender } = render(<PlaceCard {...base} state="selecting" scheduled />);
  const card = () => container.querySelector<HTMLElement>("[data-place-card]")!;
  // An already-scheduled card keeps its scheduled tint while the owner is selecting other places.
  expect(card()).toHaveClass("list-place-card--selecting", "list-place-card--scheduled");
  // Removing a date highlights the card as changed, but it is no longer scheduled.
  rerender(<PlaceCard {...base} changed scheduled={false} />);
  expect(card()).toHaveClass("list-place-card--changed");
  expect(card()).not.toHaveClass("list-place-card--scheduled");
});
