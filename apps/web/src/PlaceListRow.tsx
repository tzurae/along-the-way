import type { ReactNode } from "react";

import { PlaceThumbnail, type PlaceDisplayPhoto } from "./PlaceThumbnail";
import "./list-place-card.css";

export interface PlaceListRowProps {
  variant: "wishlist" | "proposal";
  name: string;
  typeLabel: string;
  stateLabel?: string;
  secondary?: ReactNode;
  status?: ReactNode;
  evidence?: ReactNode;
  caution?: ReactNode;
  cautionAction?: ReactNode;
  photo: PlaceDisplayPhoto | null | undefined;
  photoCount: number;
  loadingPhoto?: boolean;
  voteAction?: ReactNode;
  rowActions?: ReactNode;
  /** The 「⋯」 menu: row-level actions that are not about reading the detail (移除、更改日期). */
  menu?: ReactNode;
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

export function PlaceListRow({
  variant,
  name,
  typeLabel,
  stateLabel,
  secondary,
  status,
  evidence,
  caution,
  cautionAction,
  photo,
  photoCount,
  loadingPhoto = false,
  voteAction,
  rowActions,
  menu,
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
}: PlaceListRowProps) {
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
    `list-place-row--${variant}`,
    `list-place-row--${state}`,
    scheduled ? "list-place-row--scheduled" : "",
    changed ? "list-place-row--changed" : "",
  ].filter(Boolean).join(" ");

  return (
    <article
      className={`list-place-row ${stateClassName}`}
      data-place-list-row=""
      aria-label={ariaLabel}
      aria-current={current ? "true" : undefined}
      onClick={(event) => {
        // The vote area may be a read-only tally (a span, not a button) when voting is unavailable;
        // clicking it must never open the detail.
        if (!onActivate || (event.target instanceof Element
          && event.target.closest("button, a, input, label, textarea, select, .list-place-row__vote, .list-place-row__actions, .list-place-row__aside"))) return;
        onActivate();
      }}
      {...dataProps}
    >
      {selectionControl ? <div className="list-place-row__selection">{selectionControl}</div> : null}
      <button
        type="button"
        className="list-place-row__media"
        aria-label={openLabel}
        onClick={onOpen}
        {...(selecting ? openDataProps : {})}
      >
        <PlaceThumbnail photo={photo} photoCount={photoCount} loading={loadingPhoto} />
      </button>
      <div className="list-place-row__body">
        <div className="list-place-row__heading">
          {selecting
            ? <span className="list-place-row__title" title={name}>{name}</span>
            : <button type="button" className="list-place-row__title" title={name} aria-label={openLabel} onClick={onOpen} {...openDataProps}>{name}</button>}
          <span className="list-place-row__type">{typeLabel}</span>
          {stateLabel ? <span className="list-place-row__state">{stateLabel}</span> : null}
        </div>
        {secondary ? <div className="list-place-row__secondary">{secondary}</div> : null}
        {status ? <div className="list-place-row__status list-place-row__status--mobile">{status}</div> : null}
        {evidence ? <div className="list-place-row__evidence">{evidence}</div> : null}
        {caution ? <div className="list-place-row__caution"><span className="list-place-row__caution-text">{caution}</span>{cautionAction}</div> : null}
      </div>
      {variant === "proposal" && (voteAction || rowActions) ? (
        <footer className="list-place-row__actions">
          {voteAction ? <div className="list-place-row__vote">{voteAction}</div> : null}
          {rowActions ? <div className="list-place-row__row-actions">{rowActions}</div> : null}
        </footer>
      ) : null}
      {variant === "wishlist" && (status || voteAction || menu) ? (
        <aside className="list-place-row__aside">
          {status ? <div className="list-place-row__status list-place-row__status--desktop">{status}</div> : null}
          {voteAction ? <div className="list-place-row__vote">{voteAction}</div> : null}
          {menu}
        </aside>
      ) : null}
    </article>
  );
}
