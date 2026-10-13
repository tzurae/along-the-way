import { useEffect, useMemo, useState } from "react";

import {
  parsePlacePreviewResponse,
  type GooglePlacePhotoDto,
  type PlaceDetailReferenceKind,
  type PlacePhotoDto,
  type PlacePreviewDto,
  type PlacePreviewResponse,
} from "@along-the-way/contracts/place-details";
import { safeExternalUrl } from "./external-url";
import "./place-detail.css";

export interface PlaceDetailRequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}

export type PlaceDetailRequest = <T>(path: string, init?: PlaceDetailRequestOptions) => Promise<T>;

export type PlaceDisplayPhoto = PlacePhotoDto | GooglePlacePhotoDto;

export type PlacePreviewValue = Pick<PlacePreviewDto, "photo" | "photoCount">;

interface PreviewState {
  loading: boolean;
  previews: Map<string, PlacePreviewValue>;
}

export function usePlacePreviews({
  tripId,
  kind,
  ids,
  request,
  enabled = true,
}: {
  tripId: string;
  kind: PlaceDetailReferenceKind;
  ids: string[];
  request?: PlaceDetailRequest;
  enabled?: boolean;
}) {
  const stableIds = useMemo(() => [...new Set(ids)].sort(), [ids.join("\u0000")]);
  const key = stableIds.join("\u0000");
  const [state, setState] = useState<PreviewState>(() => ({ loading: Boolean(enabled && request && stableIds.length), previews: new Map() }));

  useEffect(() => {
    if (!enabled || !request || stableIds.length === 0) {
      setState({ loading: false, previews: new Map() });
      return;
    }
    const controller = new AbortController();
    setState({ loading: true, previews: new Map() });
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
    void Promise.all(batches.map(loadBatch)).then((responses) => {
      if (controller.signal.aborted) return;
      const previews = new Map<string, PlacePreviewValue>();
      for (const response of responses) {
        if (!response) continue;
        for (const preview of response.previews) {
          if (preview.reference.kind === kind && requestedIds.has(preview.reference.id)) {
            previews.set(preview.reference.id, { photo: preview.photo, photoCount: preview.photoCount });
          }
        }
      }
      setState({ loading: false, previews });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      setState({ loading: false, previews: new Map() });
    });
    return () => controller.abort();
  }, [enabled, key, kind, request, stableIds, tripId]);

  return state;
}

export interface PlaceThumbnailProps {
  photo: PlaceDisplayPhoto | null | undefined;
  photoCount?: PlacePreviewDto["photoCount"];
  loading?: boolean;
}

export function PlaceThumbnail({ photo, photoCount = photo ? 1 : 0, loading = false }: PlaceThumbnailProps) {
  const photoKey = photo ? `${photo.id}\u0000${photo.thumbnailUrl}` : null;
  const [failure, setFailure] = useState({ photoKey, failed: false });
  if (failure.photoKey !== photoKey) {
    setFailure({ photoKey, failed: false });
  }
  const failed = failure.photoKey === photoKey && failure.failed;

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
      {!loading && (!photo || failed) ? <span className="place-thumbnail__empty" /> : null}
    </span>
  );
}

export function PlacePhotoCredit({ photo }: { photo: PlaceDisplayPhoto | null | undefined }) {
  if (!photo) return null;
  if (photo.source === "google") {
    const maps = safeExternalUrl(photo.googleMapsUri);
    return (
      <small className="place-photo-credit place-photo-credit--google">
        <span className="place-photo-credit__text"><strong>Google Maps</strong>{photo.authors.length ? <span>・照片：{photo.authors.map((author, index) => {
          const uri = safeExternalUrl(author.uri);
          return <span key={`${author.displayName}:${index}`}>{index > 0 ? "、" : ""}{uri ? <a href={uri} target="_blank" rel="noreferrer">{author.displayName}</a> : author.displayName}</span>;
        })}</span> : null}</span>
        {maps ? <span className="place-photo-credit__links"><a href={maps} target="_blank" rel="noreferrer">在 Google Maps 查看</a></span> : null}
      </small>
    );
  }
  const source = safeExternalUrl(photo.sourceUrl);
  const license = safeExternalUrl(photo.licenseUrl);
  return <small className="place-photo-credit"><span className="place-photo-credit__text">{photo.creditText}</span><span className="place-photo-credit__links">{source ? <a href={source} target="_blank" rel="noreferrer">來源</a> : null}{license ? <a href={license} target="_blank" rel="noreferrer">授權</a> : null}<span>縮圖預覽（裁切）</span></span></small>;
}
