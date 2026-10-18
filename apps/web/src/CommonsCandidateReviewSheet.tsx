import { useEffect, useState } from "react";
import { Check, ImageIcon, RotateCcw, X } from "lucide-react";

import {
  parsePlaceDetailResponse,
  type CommonsCandidateDecisionInput,
  type CommonsCandidateDecisionResponse,
  type CommonsCandidateDto,
  type GooglePlacePhotoDto,
  type PlaceDetailDto,
  type PlaceDetailResponse,
  type PlacePhotoDto,
} from "@along-the-way/contracts/place-details";
import { ApiRequestError } from "./api-error";
import { safeExternalUrl } from "./external-url";
import { useI18n } from "./i18n";
import { PlaceDetailSheet } from "./PlaceDetailSheet";
import "./commons-candidate-review.css";

interface RequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}

type Decision = CommonsCandidateDecisionInput["decision"];
type Resolution = Decision | "skip";

interface CommonsCandidateReviewSheetProps {
  open: boolean;
  tripId: string;
  candidates: CommonsCandidateDto[];
  request<T>(url: string, options?: RequestOptions): Promise<T>;
  onClose(): void;
  onCandidateResolved(candidate: CommonsCandidateDto, resolution: Resolution): void;
  onConfirmed(candidate: CommonsCandidateDto): void;
  refreshCandidates(invalidateInFlight?: boolean): Promise<void>;
}

function CandidatePhoto({ candidate }: { candidate: CommonsCandidateDto }) {
  const { t: { tripPlaces: { commonsCandidates: text } } } = useI18n();
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const photo = candidate.photo;

  function retry() {
    setLoaded(false);
    setFailed(false);
    setThumbnailFailed(false);
    setRevision((current) => current + 1);
  }

  return (
    <div
      className={`commons-candidate-photo${!loaded && !failed ? " commons-candidate-photo--loading" : ""}`}
      aria-busy={!loaded && !failed || undefined}
    >
      {!loaded && !failed && !thumbnailFailed ? (
        <img
          key={`thumbnail:${revision}`}
          className="commons-candidate-photo__blur"
          src={photo.thumbnailUrl}
          alt=""
          aria-hidden="true"
          onError={() => setThumbnailFailed(true)}
        />
      ) : null}
      {!failed ? (
        <img
          key={`image:${revision}`}
          className="commons-candidate-photo__image"
          src={photo.imageUrl}
          width={photo.width}
          height={photo.height}
          alt={text.photoAlt(candidate.label)}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="commons-candidate-photo__error" role="alert">
          <ImageIcon aria-hidden="true" />
          <p>{text.photoUnavailable}</p>
          <button type="button" onClick={retry}>
            <RotateCcw aria-hidden="true" />
            {text.retryPhoto}
          </button>
        </div>
      )}
    </div>
  );
}

function GoogleComparisonPhoto({ photo, placeName }: { photo: GooglePlacePhotoDto; placeName: string }) {
  const { t: { tripPlaces: { commonsCandidates: text } } } = useI18n();
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  function retry() {
    setLoaded(false);
    setFailed(false);
    setRevision((current) => current + 1);
  }

  return (
    <>
      <div
        className={`commons-candidate-photo${!loaded && !failed ? " commons-candidate-photo--loading" : ""}`}
        aria-busy={!loaded && !failed || undefined}
      >
        {!failed ? (
          <img
            key={`google-image:${revision}`}
            className="commons-candidate-photo__image"
            src={photo.imageUrl}
            width={photo.width}
            height={photo.height}
            alt={text.googlePhotoAlt(placeName)}
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="commons-candidate-photo__error" role="alert">
            <ImageIcon aria-hidden="true" />
            <p>{text.comparisonPhotoUnavailable}</p>
            <button type="button" onClick={retry}>
              <RotateCcw aria-hidden="true" />
              {text.retryPhoto}
            </button>
          </div>
        )}
      </div>
      <p className="commons-candidate-google-credit">
        <strong>{text.googleCredit}</strong>
        {photo.authors.length ? <span>・{text.googlePhotoBy}{photo.authors.map((author, index) => {
          const href = safeExternalUrl(author.uri);
          return <span key={`${author.displayName}:${index}`}>{index > 0 ? "、" : ""}{href ? <a href={href} target="_blank" rel="noreferrer">{author.displayName}</a> : author.displayName}</span>;
        })}</span> : null}
      </p>
    </>
  );
}

function Attribution({ photo }: { photo: PlacePhotoDto }) {
  const { t: { tripPlaces: { commonsCandidates: text } } } = useI18n();
  const authorHref = safeExternalUrl(photo.authorUrl);
  const licenseHref = safeExternalUrl(photo.licenseUrl);
  const sourceHref = safeExternalUrl(photo.sourceUrl);

  return (
    <dl className="commons-candidate-attribution">
      <div>
        <dt>{text.author}</dt>
        <dd>{authorHref ? <a href={authorHref} target="_blank" rel="noreferrer">{photo.author}</a> : photo.author}</dd>
      </div>
      <div>
        <dt>{text.license}</dt>
        <dd>{licenseHref ? <a href={licenseHref} target="_blank" rel="noreferrer">{photo.licenseName}</a> : photo.licenseName}</dd>
      </div>
      <div>
        <dt>{text.source}</dt>
        <dd>{sourceHref ? <a href={sourceHref} target="_blank" rel="noreferrer">{photo.sourceName}</a> : photo.sourceName}</dd>
      </div>
    </dl>
  );
}

export function CommonsCandidateReviewSheet({
  open,
  tripId,
  candidates,
  request,
  onClose,
  onCandidateResolved,
  onConfirmed,
  refreshCandidates,
}: CommonsCandidateReviewSheetProps) {
  const { t: { tripPlaces: { commonsCandidates: text, placeType } } } = useI18n();
  const candidate = candidates[0] ?? null;
  const candidateTripPlaceId = candidate?.tripPlaceId ?? null;
  const [progressTotal, setProgressTotal] = useState(0);
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState("");
  const [retryDecision, setRetryDecision] = useState<Decision | null>(null);
  const [comparisonRevision, setComparisonRevision] = useState(0);
  const [placeDetailState, setPlaceDetailState] = useState<{
    tripPlaceId: string;
    loading: boolean;
    detail: PlaceDetailDto | null;
    error: boolean;
  }>({ tripPlaceId: "", loading: false, detail: null, error: false });

  useEffect(() => {
    if (!open || !candidateTripPlaceId) return;
    const controller = new AbortController();
    const tripPlaceId = candidateTripPlaceId;
    setPlaceDetailState({ tripPlaceId, loading: true, detail: null, error: false });
    const query = new URLSearchParams({ kind: "trip-place", id: tripPlaceId });
    void request<PlaceDetailResponse>(
      `/api/trips/${encodeURIComponent(tripId)}/place-details?${query}`,
      { signal: controller.signal, cache: "no-cache", parse: parsePlaceDetailResponse },
    ).then((response) => {
      if (response.detail.reference.kind !== "trip-place" || response.detail.reference.id !== tripPlaceId) {
        throw new Error("Place detail response did not match the candidate trip place");
      }
      if (controller.signal.aborted) return;
      setPlaceDetailState({ tripPlaceId, loading: false, detail: response.detail, error: false });
    }).catch((reason: unknown) => {
      if (controller.signal.aborted || (reason instanceof DOMException && reason.name === "AbortError")) return;
      setPlaceDetailState({ tripPlaceId, loading: false, detail: null, error: true });
    });
    return () => controller.abort();
  }, [candidateTripPlaceId, comparisonRevision, open, request, tripId]);

  useEffect(() => {
    if (candidates.length > progressTotal) setProgressTotal(candidates.length);
  }, [candidates.length, progressTotal]);

  useEffect(() => {
    setError("");
    setRetryDecision(null);
  }, [candidate?.id]);

  useEffect(() => {
    if (open) void refreshCandidates().catch(() => undefined);
  }, [open, refreshCandidates]);

  useEffect(() => {
    if (open && !candidate && busy === null) onClose();
  }, [busy, candidate, onClose, open]);

  useEffect(() => {
    if (!open) setProgressTotal(0);
  }, [open]);

  if (!candidate) return null;

  const total = Math.max(progressTotal, candidates.length);
  const current = Math.max(1, total - candidates.length + 1);
  const distance = candidate.distanceMeters === null ? null : text.distance(candidate.distanceMeters);
  const comparedDetail = placeDetailState.tripPlaceId === candidate.tripPlaceId ? placeDetailState.detail : null;
  const comparisonLoading = placeDetailState.tripPlaceId !== candidate.tripPlaceId || placeDetailState.loading;
  const comparisonError = placeDetailState.tripPlaceId === candidate.tripPlaceId && placeDetailState.error;
  const googlePhoto = comparedDetail?.googlePhotos[0] ?? null;
  const candidateTypes = candidate.instanceOf.map((type) => type.label).join("、");

  async function decide(decision: Decision) {
    if (busy || !candidate) return;
    setBusy(decision);
    setError("");
    setRetryDecision(decision);
    const selected = candidate;
    const payload: CommonsCandidateDecisionInput = { decision };
    try {
      await request<CommonsCandidateDecisionResponse>(
        `/api/trips/${encodeURIComponent(tripId)}/commons-candidates/${encodeURIComponent(selected.id)}/decision`,
        { method: "POST", body: JSON.stringify(payload) },
      );
      onCandidateResolved(selected, decision);
      if (decision === "confirm") onConfirmed(selected);
      await refreshCandidates(true).catch(() => undefined);
    } catch (reason) {
      if (reason instanceof ApiRequestError
        && (reason.status === 409 || reason.code === "candidate_already_decided")) {
        onCandidateResolved(selected, "skip");
        await refreshCandidates(true).catch(() => undefined);
      } else {
        setError(text.decisionError);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <PlaceDetailSheet
      open={open}
      appearance="comparison"
      title={text.title}
      description={<span className="commons-candidate-progress" aria-live="polite">{text.progress(current, total)}</span>}
      onClose={onClose}
      footer={(
        <div className="commons-candidate-actions">
          {error ? (
            <div className="commons-candidate-actions__error" role="alert">
              <p>{error}</p>
              <button type="button" disabled={busy !== null} onClick={() => { if (retryDecision) void decide(retryDecision); }}>
                <RotateCcw aria-hidden="true" />
                {text.retry}
              </button>
            </div>
          ) : null}
          <p className="sr-only" role="status" aria-live="polite">{busy ? text.saving : ""}</p>
          <div className="commons-candidate-actions__buttons">
            <button type="button" className="commons-candidate-reject" disabled={busy !== null} onClick={() => void decide("reject")}>
              <X aria-hidden="true" />
              {text.reject}
            </button>
            <button type="button" className="commons-candidate-confirm" disabled={busy !== null} onClick={() => void decide("confirm")}>
              <Check aria-hidden="true" />
              {text.confirm}
            </button>
          </div>
        </div>
      )}
    >
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {text.title}，{candidate.placeName}，{text.progress(current, total)}
      </p>
      <div className="commons-candidate-review" data-candidate-id={candidate.id}>
        <div className="commons-candidate-comparison">
          <section className="commons-candidate-panel" aria-labelledby={`commons-place-${candidate.id}`}>
            <header className="commons-candidate-panel__header">
              <span className="commons-candidate-panel__label">{text.yourPlace}</span>
              <h3 id={`commons-place-${candidate.id}`}>{candidate.placeName}</h3>
              <p>{placeType[candidate.placeType]}</p>
            </header>
            {comparisonLoading ? (
              <div className="commons-candidate-comparison-state" role="status" aria-live="polite">
                <ImageIcon aria-hidden="true" />
                <p>{text.loadingComparison}</p>
              </div>
            ) : comparisonError ? (
              <div className="commons-candidate-comparison-state" role="alert">
                <ImageIcon aria-hidden="true" />
                <p>{text.comparisonLoadError}</p>
                <button type="button" onClick={() => setComparisonRevision((currentRevision) => currentRevision + 1)}>
                  <RotateCcw aria-hidden="true" />
                  {text.retryComparison}
                </button>
              </div>
            ) : googlePhoto && !comparedDetail?.photosUnavailable ? (
              <GoogleComparisonPhoto key={`${candidate.tripPlaceId}:${googlePhoto.id}`} photo={googlePhoto} placeName={candidate.placeName} />
            ) : (
              <div className="commons-candidate-comparison-state">
                <ImageIcon aria-hidden="true" />
                <p>{text.comparisonPhotoUnavailable}</p>
              </div>
            )}
          </section>
          <section className="commons-candidate-panel" aria-labelledby={`commons-candidate-${candidate.id}`}>
            <header className="commons-candidate-panel__header">
              <span className="commons-candidate-panel__label">{text.candidate}</span>
              <h3 id={`commons-candidate-${candidate.id}`}>{candidate.label}</h3>
              <p>{text.candidateType}：{candidateTypes || text.candidateTypeUnavailable}</p>
            </header>
            <CandidatePhoto key={candidate.id} candidate={candidate} />
            <div className="commons-candidate-identity" aria-label={text.candidateDetails}>
              <span>{candidate.wikidataId}</span>
              {candidate.description ? <p>{candidate.description}</p> : null}
              {distance ? <p className="commons-candidate-distance">{distance}</p> : null}
            </div>
            <Attribution photo={candidate.photo} />
          </section>
        </div>
      </div>
    </PlaceDetailSheet>
  );
}
