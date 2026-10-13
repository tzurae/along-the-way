import type { ReactNode } from "react";

import { PlaceThumbnail, type PlaceDisplayPhoto } from "./PlaceThumbnail";
import "./place-card.css";

export interface PlaceCardProps {
  name: string;
  typeLabel: string;
  location: string;
  description: ReactNode;
  status?: ReactNode;
  photo: PlaceDisplayPhoto | null | undefined;
  photoCount: number;
  loadingPhoto?: boolean;
  photoCredit?: ReactNode;
  voteAction?: ReactNode;
  ownerActions?: ReactNode;
  wishlistAction?: ReactNode;
  selectionControl?: ReactNode;
  ariaLabel?: string;
  current?: boolean;
  state?: "default" | "selecting" | "selectable" | "selected" | "scheduled" | "changed";
  onOpen(): void;
  onActivate?(): void;
  openLabel: string;
  openDataAttribute?: {
    name: "place-detail-trigger" | "proposal-detail-trigger";
    value: string;
  };
  dataAttribute: {
    name: "wishlist-place" | "discovery-proposal";
    value: string;
  };
}

export function PlaceCard({
  name,
  typeLabel,
  location,
  description,
  status,
  photo,
  photoCount,
  loadingPhoto = false,
  photoCredit,
  voteAction,
  ownerActions,
  wishlistAction,
  selectionControl,
  ariaLabel,
  current = false,
  state = "default",
  onOpen,
  onActivate,
  openLabel,
  openDataAttribute,
  dataAttribute,
}: PlaceCardProps) {
  const dataProps = dataAttribute.name === "wishlist-place"
    ? { "data-wishlist-place": dataAttribute.value }
    : { "data-discovery-proposal": dataAttribute.value };
  const openDataProps = openDataAttribute?.name === "place-detail-trigger"
    ? { "data-place-detail-trigger": openDataAttribute.value }
    : openDataAttribute
      ? { "data-proposal-detail-trigger": openDataAttribute.value }
      : {};

  return (
    <article
      className={`place-card place-card--${state}`}
      data-place-card=""
      aria-label={ariaLabel}
      aria-current={current ? "true" : undefined}
      onClick={(event) => {
        if (!onActivate || (event.target instanceof Element && event.target.closest("button, a, input, label, textarea, select"))) return;
        onActivate();
      }}
      {...dataProps}
    >
      {selectionControl ? <div className="place-card__selection">{selectionControl}</div> : null}
      <div className="place-card__media">
        <PlaceThumbnail photo={photo} photoCount={photoCount} loading={loadingPhoto} />
      </div>
      <div className="place-card__body">
        <div className="place-card__heading">
          <button type="button" className="place-card__title" aria-label={openLabel} onClick={onOpen} {...openDataProps}>{name}</button>
        </div>
        <div className="place-card__identity">
          <span className="place-card__type">{typeLabel}</span>
          <div className="place-card__location">{location}</div>
        </div>
        <div className="place-card__description">{description}</div>
        {status ? <div className="place-card__status">{status}</div> : null}
        {photo && photoCredit ? <div className="place-card__credit">{photoCredit}</div> : null}
        <footer className="place-card__actions">
          {voteAction ? <div className="place-card__vote">{voteAction}</div> : null}
          {ownerActions ? <div className="place-card__owner-actions">{ownerActions}</div> : null}
          {wishlistAction ? <div className="place-card__wishlist-action">{wishlistAction}</div> : null}
        </footer>
      </div>
    </article>
  );
}
