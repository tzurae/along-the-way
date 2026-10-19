import { useEffect, useMemo, useState } from "react";
import {
  BedDouble,
  Coffee,
  ImageOff,
  Images,
  Landmark,
  MapPin,
  Plane,
  ShoppingBag,
  Ticket,
  TrainFront,
  Trees,
  Utensils,
  type LucideIcon,
} from "lucide-react";

import {
  parsePlacePreviewResponse,
  type GooglePlacePhotoDto,
  type PlaceDetailReferenceKind,
  type PlacePhotoDto,
  type PlacePreviewDto,
  type PlacePreviewResponse,
} from "@along-the-way/contracts/place-details";
import type { PlaceType } from "@along-the-way/contracts/trip-skeleton";
import { useI18n } from "./i18n";
import { safeExternalUrl } from "./external-url";
import "./place-media.css";

export interface PlaceDetailRequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}

export type PlaceDetailRequest = <T>(path: string, init?: PlaceDetailRequestOptions) => Promise<T>;

export type PlaceDisplayPhoto = PlacePhotoDto | GooglePlacePhotoDto;

export type PlacePreviewValue = Pick<PlacePreviewDto, "photo" | "photoCount">;

const PLACE_TYPE_ICONS: Record<PlaceType, LucideIcon> = {
  activity: Ticket,
  worship: Landmark,
  museum: Images,
  nature: Trees,
  restaurant: Utensils,
  cafe: Coffee,
  shopping: ShoppingBag,
  lodging: BedDouble,
  station: TrainFront,
  airport: Plane,
  other: MapPin,
};

interface PreviewState {
  loading: boolean;
  /** True while photos are still expected from the server's background search (see waitForPhotosUntil). */
  waiting: boolean;
  previews: Map<string, PlacePreviewValue>;
}

/** Re-check interval while waiting for background photos; one batched request per tick. */
const PHOTO_WAIT_POLL_MS = 5_000;

export function usePlacePreviews({
  tripId,
  kind,
  ids,
  request,
  enabled = true,
  waitForPhotosUntil = null,
}: {
  tripId: string;
  kind: PlaceDetailReferenceKind;
  ids: string[];
  request?: PlaceDetailRequest;
  enabled?: boolean;
  /**
   * Epoch ms. Until then, places without a photo are re-checked every 5 s (one batched request)
   * because the server is still finding their Commons photos in the background.
   */
  waitForPhotosUntil?: number | null;
}) {
  const stableIds = useMemo(() => [...new Set(ids)].sort(), [ids.join("\u0000")]);
  const key = stableIds.join("\u0000");
  const [state, setState] = useState<PreviewState>(() => ({ loading: Boolean(enabled && request && stableIds.length), waiting: false, previews: new Map() }));

  useEffect(() => {
    if (!enabled || !request || stableIds.length === 0) {
      setState({ loading: false, waiting: false, previews: new Map() });
      return;
    }
    const controller = new AbortController();
    let timer: number | undefined;
    setState({ loading: true, waiting: false, previews: new Map() });
    const requestedIds = new Set(stableIds);
    const batches = Array.from({ length: Math.ceil(stableIds.length / 100) }, (_, index) => stableIds.slice(index * 100, index * 100 + 100));
    async function loadBatch(batch: string[]): Promise<PlacePreviewResponse | null> {
      const query = new URLSearchParams({ kind, ids: batch.join(",") });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await request!<PlacePreviewResponse>(`/api/trips/${encodeURIComponent(tripId)}/place-previews?${query}`, {
            signal: controller.signal,
            parse: parsePlacePreviewResponse,
          });
        } catch (error) {
          if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
          if (attempt === 1) return null;
        }
      }
      return null;
    }
    async function load(previous: Map<string, PlacePreviewValue>) {
      const responses = await Promise.all(batches.map(loadBatch));
      if (controller.signal.aborted) return;
      // A failed refresh keeps what was already shown instead of blanking found photos.
      const previews = new Map(previous);
      for (const response of responses) {
        if (!response) continue;
        for (const preview of response.previews) {
          if (preview.reference.kind === kind && requestedIds.has(preview.reference.id)) {
            previews.set(preview.reference.id, { photo: preview.photo, photoCount: preview.photoCount });
          }
        }
      }
      const missing = stableIds.some((id) => !previews.get(id)?.photo);
      const keepWaiting = missing && waitForPhotosUntil !== null && Date.now() + PHOTO_WAIT_POLL_MS <= waitForPhotosUntil;
      setState({ loading: false, waiting: keepWaiting, previews });
      if (keepWaiting) {
        timer = window.setTimeout(() => {
          void load(previews).catch(() => { if (!controller.signal.aborted) setState((current) => ({ ...current, waiting: false })); });
        }, PHOTO_WAIT_POLL_MS);
      }
    }
    void load(new Map()).catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      setState({ loading: false, waiting: false, previews: new Map() });
    });
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [enabled, key, kind, request, stableIds, tripId, waitForPhotosUntil]);

  return state;
}

export interface PlaceThumbnailProps {
  photo: PlaceDisplayPhoto | null | undefined;
  photoCount?: PlacePreviewDto["photoCount"];
  loading?: boolean;
  placeType?: PlaceType;
}

export function PlaceThumbnail({ photo, photoCount = photo ? 1 : 0, loading = false, placeType }: PlaceThumbnailProps) {
  const photoKey = photo ? `${photo.id}\u0000${photo.thumbnailUrl}` : null;
  const [failure, setFailure] = useState({ photoKey, failed: false });
  if (failure.photoKey !== photoKey) {
    setFailure({ photoKey, failed: false });
  }
  const failed = failure.photoKey === photoKey && failure.failed;
  const { t } = useI18n();
  const noPhoto = photo === null;
  const EmptyIcon = noPhoto && placeType ? PLACE_TYPE_ICONS[placeType] : ImageOff;

  return (
    <span
      className="place-thumbnail"
      data-place-thumbnail={photo?.id ?? (loading ? "loading" : photo === null ? "empty" : "unavailable")}
    >
      {loading ? <span className="place-thumbnail__loading" /> : null}
      {!loading && photo && !failed ? (
        <img
          className="place-thumbnail__image"
          src={photo.thumbnailUrl}
          width={photo.width}
          height={photo.height}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailure({ photoKey, failed: true })}
        />
      ) : null}
      {!loading && photo && photoCount > 1 ? (
        <span className="place-thumbnail__count" role="img" aria-label={`共 ${photoCount} 張照片`}>
          <span aria-hidden="true">+{photoCount - 1}</span>
        </span>
      ) : null}
      {!loading && (!photo || failed) ? (
        // `null` means the place has no photo; `undefined` or a broken image means it failed to load.
        <span
          className={`place-thumbnail__empty${noPhoto ? " place-thumbnail__empty--type" : ""}`}
          role="img"
          aria-label={noPhoto ? t.placeDetail.noPhotoShort : t.placeDetail.photoUnavailable}
        >
          <EmptyIcon aria-hidden="true" className="place-thumbnail__empty-icon" />
          {!noPhoto ? <span aria-hidden="true">{t.placeDetail.photoUnavailableShort}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

function compactLicenseLabel(licenseUrl: string, fallback: string) {
  try {
    const url = new URL(licenseUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:")
      || (url.hostname !== "creativecommons.org" && !url.hostname.endsWith(".creativecommons.org"))) {
      return fallback;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "publicdomain" && segments[1] === "zero" && segments[2]) {
      return `CC0 ${segments[2]}`;
    }
    if (segments[0] === "licenses" && segments[2]) {
      if (segments[1] === "by") return `CC BY ${segments[2]}`;
      if (segments[1] === "by-sa") return `CC BY-SA ${segments[2]}`;
    }
  } catch {
    // Preserve the supplied name when the source URL is not parseable.
  }
  return fallback;
}

export function PlacePhotoCredit({ photo }: { photo: PlaceDisplayPhoto | null | undefined }) {
  if (!photo) return null;
  if (photo.source === "google") {
    return <small className="place-photo-credit"><span className="place-photo-credit__text"><strong>Google Maps</strong>{photo.authors.length ? <>・{photo.authors.map((author, index) => {
      const href = safeExternalUrl(author.uri);
      return <span key={`${author.displayName}:${index}`}>{index > 0 ? "、" : ""}{href ? <a className="place-photo-credit__link" href={href} target="_blank" rel="noreferrer">{author.displayName}</a> : author.displayName}</span>;
    })}</> : ""}</span></small>;
  }
  const authorHref = safeExternalUrl(photo.authorUrl);
  const licenseHref = safeExternalUrl(photo.licenseUrl);
  const license = compactLicenseLabel(photo.licenseUrl, photo.licenseName);
  const author = displayPhotoAuthor(photo.author);
  return <small className="place-photo-credit"><span className="place-photo-credit__text">{authorHref ? <a className="place-photo-credit__link" href={authorHref} target="_blank" rel="noreferrer">{author}</a> : author}・{licenseHref ? <a className="place-photo-credit__link" href={licenseHref} target="_blank" rel="noreferrer">{license}</a> : license}</span></small>;
}

/**
 * Commons fills its Artist field with "No machine-readable author provided. Name~commonswiki
 * assumed (based on copyright claims)." when an uploader skips the author template. The license
 * still needs the author named, so show just that name (or Wikimedia Commons when there is none).
 */
export function displayPhotoAuthor(author: string) {
  const assumed = /^No machine-readable author provided\.\s*(.+?)\s+assumed\b/i.exec(author.trim());
  const name = (assumed ? assumed[1]! : author).replace(/~commonswiki\b/gi, "").trim();
  return name || "Wikimedia Commons";
}
