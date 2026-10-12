import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, ExternalLink, Maximize2, X } from "lucide-react";

import {
  parsePlaceDetailResponse,
  type GooglePlacePhotoDto,
  type PlaceDetailBlockDto,
  type PlaceDetailDto,
  type PlaceDetailReference,
  type PlaceDetailResponse,
  type PlaceDetailSourceDto,
  type PlacePhotoDto,
} from "@along-the-way/contracts/place-details";
import { ApiRequestError } from "./api-error";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "./components/ui/dialog";
import { useI18n, type Locale, type Messages } from "./i18n";
import type { PlaceDetailRequest, PlaceDisplayPhoto } from "./PlaceThumbnail";
import { safeExternalUrl } from "./external-url";
import "./place-detail.css";


function formatDateOnly(value: string, locale: Locale) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!parts) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function formatInstant(value: string, locale: Locale) {
  const instant = new Date(value);
  return Number.isFinite(instant.valueOf())
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(instant)
    : value;
}

function formatDateOrInstant(value: string, locale: Locale) {
  return value.length === 10 ? formatDateOnly(value, locale) : formatInstant(value, locale);
}

function sourceValidity(source: PlaceDetailSourceDto, locale: Locale, t: Messages["placeDetail"]) {
  if (source.validFrom && source.validUntil) {
    return t.validRange(formatDateOnly(source.validFrom, locale), formatDateOnly(source.validUntil, locale));
  }
  if (source.validFrom) return t.validFrom(formatDateOnly(source.validFrom, locale));
  if (source.validUntil) return t.validUntil(formatDateOnly(source.validUntil, locale));
  return t.validityUnknown;
}

function FactNotices({ block }: { block: PlaceDetailBlockDto }) {
  const { t } = useI18n();
  const notices = [
    block.certainty === "unknown" ? t.placeDetail.unknownNotice : null,
    block.certainty === "conflicted" ? t.placeDetail.conflictNotice : null,
    block.needsRecheck ? t.placeDetail.recheckNotice : null,
  ].filter((notice): notice is string => notice !== null);
  if (notices.length === 0) return null;
  return (
    <span className="place-detail__notices">
      {notices.map((notice) => (
        <span key={notice} className="place-detail__notice">
          <CircleAlert aria-hidden="true" className="size-3.5" />{notice}
        </span>
      ))}
    </span>
  );
}

function BlockSources({ block, sources }: { block: PlaceDetailBlockDto; sources: Map<string, PlaceDetailSourceDto> }) {
  const { locale, t } = useI18n();
  const matching = block.sourceIds.flatMap((id) => {
    const source = sources.get(id);
    return source ? [source] : [];
  });
  if (matching.length === 0) return null;
  return (
    <span className="place-detail__block-sources">
      {t.placeDetail.sourceForBlock}：{matching.map((source, index) => {
        const href = safeExternalUrl(source.url);
        return (
          <span key={source.id}>
            {index > 0 ? "、" : ""}
            {href ? <a href={href} target="_blank" rel="noreferrer" aria-label={t.placeDetail.openSource(source.title)}>{source.title}</a> : source.title}
            {`（${t.placeDetail.checkedLabel(formatInstant(source.checkedAt, locale))}）`}
          </span>
        );
      })}
    </span>
  );
}

function DetailBlock({ block, sources }: { block: PlaceDetailBlockDto; sources: Map<string, PlaceDetailSourceDto> }) {
  const content = (
    <>
      <span className="whitespace-pre-wrap break-words">{block.text}</span>
      <FactNotices block={block} />
      <BlockSources block={block} sources={sources} />
    </>
  );
  return block.style === "bullet"
    ? <li>{content}</li>
    : <div>{content}</div>;
}

function PhotoMetadata({ photo }: { photo: PlacePhotoDto }) {
  const { locale, t } = useI18n();
  const authorUrl = safeExternalUrl(photo.authorUrl);
  const sourceUrl = safeExternalUrl(photo.sourceUrl);
  const fileSourceUrl = safeExternalUrl(photo.fileSourceUrl);
  const licenseUrl = safeExternalUrl(photo.licenseUrl);
  const verificationUrl = safeExternalUrl(photo.verificationUrl);
  return (
    <dl className="grid min-w-0 gap-3 text-sm leading-6 @sm:grid-cols-[8rem_minmax(0,1fr)]" data-photo-metadata={photo.id}>
      <dt className="font-bold">{t.placeDetail.workTitle}</dt><dd className="break-words">{photo.title}</dd>
      <dt className="font-bold">{t.placeDetail.description}</dt><dd className="whitespace-pre-wrap break-words">{photo.description}</dd>
      <dt className="font-bold">{t.placeDetail.author}</dt><dd className="break-words">{authorUrl ? <a className="underline underline-offset-2" href={authorUrl} target="_blank" rel="noreferrer">{photo.author}</a> : photo.author}</dd>
      <dt className="font-bold">{t.placeDetail.source}</dt><dd className="break-words">{sourceUrl ? <a className="place-detail__inline-link underline underline-offset-2" href={sourceUrl} target="_blank" rel="noreferrer">{photo.creditText}<ExternalLink aria-hidden="true" className="size-3.5" /></a> : photo.creditText}</dd>
      <dt className="font-bold">{t.placeDetail.fileSource}</dt><dd className="break-all">{fileSourceUrl ? <a className="underline underline-offset-2" href={fileSourceUrl} target="_blank" rel="noreferrer">{fileSourceUrl}</a> : photo.fileSourceUrl}</dd>
      <dt className="font-bold">{t.placeDetail.suppliedBy}</dt><dd className="break-words">{photo.sourceName}</dd>
      <dt className="font-bold">{t.placeDetail.license}</dt><dd className="break-words">{licenseUrl ? <a className="underline underline-offset-2" href={licenseUrl} target="_blank" rel="noreferrer">{photo.licenseName}</a> : photo.licenseName}</dd>
      <dt className="font-bold">{t.placeDetail.capturedAt}</dt><dd>{photo.capturedAt ? formatDateOrInstant(photo.capturedAt, locale) : t.placeDetail.unknownNotice}</dd>
      <dt className="font-bold">{t.placeDetail.checkedAt}</dt><dd>{formatInstant(photo.checkedAt, locale)}</dd>
      <dt className="font-bold">{t.placeDetail.verification}</dt><dd className="break-all">{verificationUrl ? <a className="underline underline-offset-2" href={verificationUrl} target="_blank" rel="noreferrer">{verificationUrl}</a> : photo.verificationUrl}</dd>
      <dt className="font-bold">{t.placeDetail.locationEvidence}</dt><dd className="whitespace-pre-wrap break-words">{photo.locationEvidence}</dd>
      <dt className="font-bold">{t.placeDetail.changes}</dt><dd className="whitespace-pre-wrap break-words">{photo.changes}</dd>
      <dt className="font-bold">{t.placeDetail.dimensions}</dt><dd className="tabular-nums">{photo.originalWidth} × {photo.originalHeight} px</dd>
      {photo.notices.length ? <><dt className="font-bold">{t.placeDetail.notices}</dt><dd><ul className="list-disc pl-5">{photo.notices.map((notice) => <li key={notice} className="break-words">{notice}</li>)}</ul></dd></> : null}
    </dl>
  );
}

function PhotoViewer({ photo, failed, open, onOpenChange }: { photo: PlacePhotoDto; failed: boolean; open: boolean; onOpenChange(open: boolean): void }) {
  const { t } = useI18n();
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const [failedPhotoKey, setFailedPhotoKey] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const photoKey = `${photo.id}\u0000${photo.imageUrl}`;
  const unavailable = failed || failedPhotoKey === photoKey;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="place-photo-viewer translate-x-0 translate-y-0"
        aria-label={t.placeDetail.viewerTitle}
        data-photo-viewer={photo.id}
        initialFocus={titleRef}
        showCloseButton={false}
      >
        <div className="place-photo-viewer__head">
          <DialogTitle ref={titleRef} tabIndex={-1} className="place-photo-viewer__title">{photo.title}</DialogTitle>
        </div>
        <div className="place-photo-viewer__layout">
          <div className="place-photo-viewer__image-frame">
            {unavailable ? (
              <div className="place-photo-viewer__unavailable">
                <p>{t.placeDetail.photoUnavailable}</p>
                {!failed ? <button type="button" className="place-photo-retry" onClick={() => { setFailedPhotoKey(null); setRevision((current) => current + 1); }}>{t.placeDetail.reloadPhoto}</button> : null}
              </div>
            ) : (
              <img
                key={`${photoKey}:${revision}`}
                className="place-photo-viewer__image"
                src={photo.imageUrl}
                width={photo.width}
                height={photo.height}
                alt={photo.description || photo.title}
                decoding="async"
                onError={() => setFailedPhotoKey(photoKey)}
              />
            )}
          </div>
          <div className="place-photo-viewer__metadata">
            <PhotoMetadata photo={photo} />
          </div>
        </div>
        <button type="button" className="place-photo-viewer__close" aria-label={t.app.close} onClick={() => onOpenChange(false)}><X aria-hidden="true" className="size-5" /></button>
      </DialogContent>
    </Dialog>
  );
}

function GoogleGalleryCredit({ photo }: { photo: GooglePlacePhotoDto }) {
  const maps = safeExternalUrl(photo.googleMapsUri);
  return (
    <div className="place-gallery__google-credit">
      <span className="place-gallery__google-byline">
        <strong>Google Maps</strong>
        {photo.authors.length ? <span>照片：{photo.authors.map((author, index) => {
          const uri = safeExternalUrl(author.uri);
          return <span key={`${author.displayName}:${index}`}>{index > 0 ? "、" : ""}{uri ? <a href={uri} target="_blank" rel="noreferrer">{author.displayName}</a> : author.displayName}</span>;
        })}</span> : null}
      </span>
      {maps ? <a className="place-gallery__google-maps" href={maps} target="_blank" rel="noreferrer">在 Google Maps 查看</a> : null}
    </div>
  );
}

function Gallery({ identity, placeName, photos }: { identity: string; placeName: string; photos: PlaceDisplayPhoto[] }) {
  const { t } = useI18n();
  const trackRef = useRef<HTMLDivElement>(null);
  const fingerprint = photos.map((photo) => `${photo.id}\u0000${photo.imageUrl}`).join("\u0001");
  const [selection, setSelection] = useState<{ identity: string; photoId: string | null }>({ identity, photoId: photos[0]?.id ?? null });
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const [reloadRevision, setReloadRevision] = useState(0);
  const [viewerOpen, setViewerOpen] = useState(false);

  // Reset per-photo state only when the photo set really changes, during render. A mount-time
  // effect would run after commit and erase an image error that fired before effects flushed.
  const resetKey = `${identity}\u0002${fingerprint}`;
  const [appliedResetKey, setAppliedResetKey] = useState(resetKey);
  if (appliedResetKey !== resetKey) {
    setAppliedResetKey(resetKey);
    setSelection(selection.identity === identity && photos.some((photo) => photo.id === selection.photoId)
      ? selection
      : { identity, photoId: photos[0]?.id ?? null });
    setFailed(new Set());
    setReloadRevision(0);
    setViewerOpen(false);
  }

  useEffect(() => {
    if (trackRef.current) trackRef.current.scrollLeft = 0;
  }, [resetKey]);

  if (photos.length === 0) {
    return <div className="place-gallery__empty" data-place-gallery="empty">{t.placeDetail.noPhoto}</div>;
  }
  const selectedIndex = Math.max(0, photos.findIndex((photo) => photo.id === selection.photoId));
  const selected = photos[selectedIndex]!;
  const selectedKey = `${selected.id}\u0000${selected.imageUrl}`;
  const selectedFailed = failed.has(selectedKey);
  const sourceHref = selected.source === "curated" ? safeExternalUrl(selected.sourceUrl) : null;
  const licenseHref = selected.source === "curated" ? safeExternalUrl(selected.licenseUrl) : null;

  function choose(index: number, scroll: boolean) {
    const bounded = Math.max(0, Math.min(photos.length - 1, index));
    setSelection({ identity, photoId: photos[bounded]!.id });
    if (scroll && trackRef.current) {
      const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      trackRef.current.scrollTo({ left: bounded * trackRef.current.clientWidth, behavior: reduced ? "auto" : "smooth" });
    }
  }

  function retryPhoto(photoKey: string) {
    setFailed((current) => {
      const next = new Set(current);
      next.delete(photoKey);
      return next;
    });
    setReloadRevision((current) => current + 1);
  }

  return (
    <figure className="place-gallery" data-place-gallery={identity}>
      <div
        ref={trackRef}
        className="place-gallery__track"
        onScroll={(event) => {
          const width = event.currentTarget.clientWidth;
          if (width > 0) choose(Math.round(event.currentTarget.scrollLeft / width), false);
        }}
      >
        {photos.map((photo, index) => {
          const photoKey = `${photo.id}\u0000${photo.imageUrl}`;
          const imageFailed = failed.has(photoKey);
          const image = (
            <img
              key={`${photoKey}:${reloadRevision}`}
              className="place-gallery__image"
              src={photo.imageUrl}
              width={photo.width}
              height={photo.height}
              alt={photo.source === "curated"
                ? t.placeDetail.photoAlt(photo.title, index + 1, photos.length)
                : t.placeDetail.googlePhotoAlt(placeName)}
              decoding="async"
              onError={() => setFailed((current) => new Set(current).add(photoKey))}
            />
          );
          return (
            <div key={photoKey} className="place-gallery__slide" data-photo-slide={photo.id}>
              {imageFailed ? (
                <div className="place-gallery__unavailable">
                  <p>{t.placeDetail.photoUnavailable}</p>
                  <button type="button" className="place-photo-retry" onClick={() => retryPhoto(photoKey)}>{t.placeDetail.reloadPhoto}</button>
                </div>
              ) : photo.source === "curated" ? (
                <button type="button" className="place-gallery__image-button" tabIndex={index === selectedIndex ? 0 : -1} aria-label={t.placeDetail.openPhoto(photo.title)} onClick={() => { choose(index, false); setViewerOpen(true); }}>
                  {image}
                  <span className="place-gallery__enlarge"><Maximize2 aria-hidden="true" className="size-4" />{t.placeDetail.photoInformation}</span>
                </button>
              ) : image}
            </div>
          );
        })}
      </div>
      <div className="place-gallery__controls">
        {photos.length > 1 ? <button type="button" className="place-gallery__control" disabled={selectedIndex === 0} aria-label={t.placeDetail.previousPhoto} onClick={() => choose(selectedIndex - 1, true)}><ChevronLeft aria-hidden="true" className="size-5" /></button> : null}
        <span className="place-gallery__count" aria-live="polite">{t.placeDetail.photoCount(selectedIndex + 1, photos.length)}</span>
        {photos.length > 1 ? <button type="button" className="place-gallery__control" disabled={selectedIndex === photos.length - 1} aria-label={t.placeDetail.nextPhoto} onClick={() => choose(selectedIndex + 1, true)}><ChevronRight aria-hidden="true" className="size-5" /></button> : null}
      </div>
      {selected.source === "google" ? (
        <figcaption className="place-gallery__caption place-gallery__caption--google" data-photo-credit={selected.id}>
          <GoogleGalleryCredit photo={selected} />
        </figcaption>
      ) : (
        <figcaption className="place-gallery__caption" data-photo-credit={selected.id}>
          <p className="place-gallery__credit">{selected.creditText}</p>
          <p className="place-gallery__links">
            <span>歷史照片，非即時景色</span>
            <span aria-hidden="true">·</span>
            {sourceHref ? <a href={sourceHref} target="_blank" rel="noreferrer">來源</a> : <span>{selected.sourceName}</span>}
            <span aria-hidden="true">·</span>
            {licenseHref ? <a href={licenseHref} title={selected.licenseName} target="_blank" rel="noreferrer">{t.placeDetail.license}</a> : <span>{selected.licenseName}</span>}
          </p>
          <button type="button" className="place-gallery__open" aria-label={t.placeDetail.photoInformationFor(selected.title)} onClick={() => setViewerOpen(true)}>{t.placeDetail.photoInformation}</button>
        </figcaption>
      )}
      {selected.source === "curated" ? <PhotoViewer photo={selected} failed={selectedFailed} open={viewerOpen} onOpenChange={setViewerOpen} /> : null}
    </figure>
  );
}

function DetailArticle({ detail, collapsible }: { detail: PlaceDetailDto; collapsible: boolean }) {
  const { locale, t } = useI18n();
  const sources = useMemo(() => new Map(detail.sources.map((source) => [source.id, source])), [detail.sources]);
  const article = (
    <div className="place-detail__article">
      {detail.asOfDate ? <p className="place-detail__date">{t.placeDetail.contentForDate(formatDateOnly(detail.asOfDate, locale))}</p> : null}
      {detail.sections.length ? detail.sections.map((section) => (
        <section key={section.kind} className="place-detail__section" data-place-detail-section={section.kind}>
          <h3>{section.title}</h3>
          <div className="place-detail__blocks">
            {section.blocks.map((block, index) => block.style === "bullet"
              ? <ul key={`${index}:${block.text}`}><DetailBlock block={block} sources={sources} /></ul>
              : <DetailBlock key={`${index}:${block.text}`} block={block} sources={sources} />)}
          </div>
        </section>
      )) : <p className="place-detail__empty">{t.placeDetail.empty}</p>}
      {detail.sources.length ? (
        <section className="place-detail__sources" aria-label={t.placeDetail.sourceLabel}>
          <h3>{t.placeDetail.sourceLabel}</h3>
          <ul>
            {detail.sources.map((source) => {
              const href = safeExternalUrl(source.url);
              return (
                <li key={source.id} className="place-detail__source">
                  <p>{href ? <a className="place-detail__inline-link" href={href} target="_blank" rel="noreferrer">{source.title}<ExternalLink aria-hidden="true" className="size-3.5" /></a> : source.title}</p>
                  <p className="place-detail__source-meta">{t.placeDetail.checkedLabel(formatInstant(source.checkedAt, locale))}{source.publishedAt ? `・${t.placeDetail.publishedLabel(formatDateOrInstant(source.publishedAt, locale))}` : ""}</p>
                  <p className="place-detail__source-meta">{sourceValidity(source, locale, t.placeDetail)}{source.expiresAt ? `・${t.placeDetail.expiresAt(formatInstant(source.expiresAt, locale))}` : `・${t.placeDetail.referenceNotice}`}</p>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
  return collapsible ? (
    <details className="place-detail__disclosure">
      <summary><ChevronRight aria-hidden="true" className="size-4" />{t.placeDetail.moreInformation}</summary>
      {article}
    </details>
  ) : article;
}

export function PlaceDetailContent({ tripId, reference, date, request, interlude, collapsible = false }: {
  tripId: string;
  reference: PlaceDetailReference;
  date?: string | null;
  request: PlaceDetailRequest;
  interlude?: ReactNode;
  collapsible?: boolean;
}) {
  const { t } = useI18n();
  const identity = `${reference.kind}:${reference.id}`;
  const [state, setState] = useState<{ identity: string; loading: boolean; detail: PlaceDetailDto | null; error: unknown }>({ identity, loading: true, detail: null, error: null });
  const [requestRevision, setRequestRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ identity, loading: true, detail: null, error: null });
    const query = new URLSearchParams({ kind: reference.kind, id: reference.id });
    if (date) query.set("date", date);
    void request<PlaceDetailResponse>(`/api/trips/${encodeURIComponent(tripId)}/place-details?${query}`, {
      signal: controller.signal,
      parse: parsePlaceDetailResponse,
    }).then((response) => {
      if (controller.signal.aborted) return;
      if (response.detail.reference.kind !== reference.kind || response.detail.reference.id !== reference.id) {
        throw new Error("Place detail response did not match the requested reference");
      }
      setState({ identity, loading: false, detail: response.detail, error: null });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      setState({ identity, loading: false, detail: null, error });
    });
    return () => controller.abort();
  }, [date, identity, reference.id, reference.kind, request, requestRevision, tripId]);

  const loading = state.identity !== identity || state.loading;
  const detail = !loading && !state.error ? state.detail : null;
  const errorMessage = !loading && state.error
    ? !navigator.onLine
      ? t.placeDetail.offlineUnavailable
      : state.error instanceof ApiRequestError && [401, 403, 404].includes(state.error.status ?? 0)
        ? t.placeDetail.accessDenied
        : t.placeDetail.unavailable
    : null;

  return (
    <div className="place-detail-content" data-place-detail-content={detail ? `${detail.reference.kind}:${detail.reference.id}` : undefined}>
      {loading ? <p className="place-detail__loading" role="status">{t.placeDetail.loading}</p> : null}
      {errorMessage ? (
        <div className="place-detail__error" role="alert">
          <p>{errorMessage}</p>
          <button type="button" className="place-detail__retry" onClick={() => setRequestRevision((current) => current + 1)}>{t.placeDetail.retry}</button>
        </div>
      ) : null}
      {detail ? <Gallery
        identity={`${detail.reference.kind}:${detail.reference.id}`}
        placeName={detail.name}
        photos={detail.photos.length ? detail.photos : detail.googlePhoto ? [detail.googlePhoto] : []}
      /> : null}
      {interlude}
      {detail ? <DetailArticle detail={detail} collapsible={collapsible} /> : null}
    </div>
  );
}
