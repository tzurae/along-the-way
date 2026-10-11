import { useEffect, useMemo, useState } from "react";
import { ImageOff } from "lucide-react";

import {
  parsePlacePreviewResponse,
  type PlaceDetailReferenceKind,
  type PlacePhotoDto,
  type PlacePreviewResponse,
} from "@along-the-way/contracts/place-details";
import { useI18n } from "./i18n";
import { safeExternalUrl } from "./external-url";
import "./place-detail.css";

export interface PlaceDetailRequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}

export type PlaceDetailRequest = <T>(path: string, init?: PlaceDetailRequestOptions) => Promise<T>;

interface PreviewState {
  loading: boolean;
  photos: Map<string, PlacePhotoDto | null>;
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
  const [state, setState] = useState<PreviewState>(() => ({ loading: Boolean(enabled && request && stableIds.length), photos: new Map() }));

  useEffect(() => {
    if (!enabled || !request || stableIds.length === 0) {
      setState({ loading: false, photos: new Map() });
      return;
    }
    const controller = new AbortController();
    setState({ loading: true, photos: new Map() });
    const requestedIds = new Set(stableIds);
    const batches = Array.from({ length: Math.ceil(stableIds.length / 100) }, (_, index) => stableIds.slice(index * 100, index * 100 + 100));
    void Promise.all(batches.map((batch) => {
      const query = new URLSearchParams({ kind, ids: batch.join(",") });
      return request<PlacePreviewResponse>(`/api/trips/${encodeURIComponent(tripId)}/place-previews?${query}`, {
        signal: controller.signal,
        parse: parsePlacePreviewResponse,
      });
    })).then((responses) => {
      if (controller.signal.aborted) return;
      const photos = new Map<string, PlacePhotoDto | null>();
      for (const response of responses) {
        for (const preview of response.previews) {
          if (preview.reference.kind === kind && requestedIds.has(preview.reference.id)) {
            photos.set(preview.reference.id, preview.photo);
          }
        }
      }
      setState({ loading: false, photos });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      setState({ loading: false, photos: new Map() });
    });
    return () => controller.abort();
  }, [enabled, key, kind, request, stableIds, tripId]);

  return state;
}

export function PlaceThumbnail({ photo, loading = false }: { photo: PlacePhotoDto | null | undefined; loading?: boolean }) {
  const { t } = useI18n();
  const [failedPhotoId, setFailedPhotoId] = useState<string | null>(null);
  const failed = photo !== null && photo !== undefined && failedPhotoId === photo.id;
  const unavailable = failed || photo === undefined;

  return (
    <span
      className="place-thumbnail"
      aria-hidden="true"
      data-place-thumbnail={photo?.id ?? (loading ? "loading" : photo === null ? "empty" : "unavailable")}
    >
      {loading ? <span className="place-thumbnail__loading" /> : null}
      {!loading && photo && !failed ? (
        <img
          className="place-thumbnail__image"
          src={photo.thumbnailUrl}
          width={72}
          height={72}
          alt=""
          loading="lazy"
          onError={() => setFailedPhotoId(photo.id)}
        />
      ) : null}
      {!loading && (!photo || failed) ? (
        <span className="place-thumbnail__empty" title={unavailable ? t.placeDetail.photoUnavailable : t.placeDetail.noPhoto}>
          <ImageOff aria-hidden="true" className="size-5" />
          <span>{unavailable ? t.placeDetail.photoUnavailable : t.placeDetail.noPhoto}</span>
        </span>
      ) : null}
    </span>
  );
}

export function PlacePhotoCredit({ photo }: { photo: PlacePhotoDto | null | undefined }) {
  if (!photo) return null;
  const source = safeExternalUrl(photo.sourceUrl);
  const license = safeExternalUrl(photo.licenseUrl);
  return <small className="place-photo-credit"><span className="place-photo-credit__text">{photo.creditText}</span><span className="place-photo-credit__links">{source ? <a href={source} target="_blank" rel="noreferrer">來源</a> : null}{license ? <a href={license} target="_blank" rel="noreferrer">授權</a> : null}<span>縮圖預覽（裁切）</span></span></small>;
}
