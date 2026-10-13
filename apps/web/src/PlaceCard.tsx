import type { ReactNode } from "react";

import { PlaceThumbnail, type PlaceDisplayPhoto } from "./PlaceThumbnail";
import "./list-place-card.css";

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
  /** Selection-mode state only; scheduling facts are independent flags below. */
  state?: "default" | "selecting" | "selectable" | "selected";
  /** The place is on a day of the itinerary (keeps its tint in every mode). */
  scheduled?: boolean;
  /** Just changed by a scheduling action (plays the settle animation once). */
  changed?: boolean;
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
  scheduled = false,
  changed = false,
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
  const selecting = state !== "default";
  const stateClassName = [
    `list-place-card--${state}`,
    scheduled ? "list-place-card--scheduled" : "",
    changed ? "list-place-card--changed" : "",
  ].filter(Boolean).join(" ");

  return (
    <article
      className={`list-place-card ${stateClassName}`}
      data-place-card=""
      aria-label={ariaLabel}
      aria-current={current ? "true" : undefined}
      onClick={(event) => {
        if (!onActivate || (event.target instanceof Element && event.target.closest("button, a, input, label, textarea, select"))) return;
        onActivate();
      }}
      {...dataProps}
    >
      {selectionControl ? <div className="list-place-card__selection">{selectionControl}</div> : null}
      <div className="list-place-card__media">
        <PlaceThumbnail photo={photo} photoCount={photoCount} loading={loadingPhoto} />
      </div>
      <div className="list-place-card__body">
        <div className="list-place-card__heading">
          {selecting
            ? <span className="list-place-card__title">{name}</span>
            : <button type="button" className="list-place-card__title" aria-label={openLabel} onClick={onOpen} {...openDataProps}>{name}</button>}
        </div>
        <div className="list-place-card__identity">
          <span className="list-place-card__type">{typeLabel}</span>
          <div className="list-place-card__location">{location}</div>
        </div>
        <div className="list-place-card__description">{description}</div>
        {status ? <div className="list-place-card__status">{status}</div> : null}
        {photo && photoCredit ? <div className="list-place-card__credit">{photoCredit}</div> : null}
        <footer className="list-place-card__actions">
          {voteAction ? <div className="list-place-card__vote">{voteAction}</div> : null}
          {ownerActions ? <div className="list-place-card__owner-actions">{ownerActions}</div> : null}
          {wishlistAction ? <div className="list-place-card__wishlist-action">{wishlistAction}</div> : null}
        </footer>
      </div>
    </article>
  );
}
