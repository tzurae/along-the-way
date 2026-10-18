import { useEffect, useState } from "react";
import { Youtube } from "lucide-react";

import {
  parsePlaceGuideResponse,
  type PlaceGuideDto,
  type PlaceGuideResponse,
} from "@along-the-way/contracts/place-details";
import { useI18n } from "./i18n";
import type { PlaceDetailRequest } from "./PlaceThumbnail";
import "./list-place-card.css";

const POLL_INTERVAL_MS = 4_000;
const MAX_POLL_ATTEMPTS = 3;

type GuidePhase = "loading" | "ready" | "empty";
export interface TodayPlaceGuideReference {
  kind: "trip-place" | "itinerary-place";
  id: string;
}


interface GuideState {
  identity: string;
  phase: GuidePhase;
  guide: PlaceGuideDto | null;
}

function GuideList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="today-place-guide__group">
      <h4>{title}</h4>
      <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </section>
  );
}

export function TodayPlaceGuide({ tripId, reference, placeName, request }: {
  tripId: string;
  reference: TodayPlaceGuideReference;
  placeName: string;
  request: PlaceDetailRequest;
}) {
  const { t } = useI18n();
  const identity = `${reference.kind}:${reference.id}`;
  const [state, setState] = useState<GuideState>({ identity, phase: "loading", guide: null });

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ kind: reference.kind, id: reference.id });
    const path = `/api/trips/${encodeURIComponent(tripId)}/place-guide?${query}`;
    let pollTimer: number | null = null;
    let pollAttempts = 0;
    setState({ identity, phase: "loading", guide: null });

    async function loadGuide() {
      try {
        const response = await request<PlaceGuideResponse>(path, {
          signal: controller.signal,
          cache: "no-store",
          parse: parsePlaceGuideResponse,
        });
        if (controller.signal.aborted) return;
        if (response.guide.status === "ready") {
          setState({ identity, phase: "ready", guide: response.guide });
          return;
        }
        if (response.guide.status === "no_sources" || pollAttempts >= MAX_POLL_ATTEMPTS) {
          setState({ identity, phase: "empty", guide: null });
          return;
        }
        pollAttempts += 1;
        pollTimer = window.setTimeout(() => void loadGuide(), POLL_INTERVAL_MS);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setState({ identity, phase: "empty", guide: null });
      }
    }

    void loadGuide();
    return () => {
      controller.abort();
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [identity, reference.id, reference.kind, request, tripId]);

  const phase = state.identity === identity ? state.phase : "loading";
  const guide = phase === "ready" ? state.guide : null;
  const youtubeHref = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${placeName} 必去`)}`;

  return (
    <section className="today-place-guide" aria-labelledby="today-place-guide-title">
      <div className="today-place-guide__heading">
        <h3 id="today-place-guide-title">{t.today.guide.title}</h3>
        <span className="today-place-guide__ai-label">{t.today.guide.aiLabel}</span>
      </div>
      {phase === "loading" ? (
        <>
          <p className="sr-only" role="status">{t.today.guide.loading}</p>
          <div className="today-place-guide__skeleton" aria-hidden="true">
            <span className="place-list-skeleton__block today-place-guide__skeleton-line" />
            <span className="place-list-skeleton__block today-place-guide__skeleton-line" />
            <span className="place-list-skeleton__block today-place-guide__skeleton-line" />
          </div>
        </>
      ) : null}
      {guide ? (
        <div className="today-place-guide__content">
          {guide.history ? (
            <section className="today-place-guide__group">
              <h4>{t.today.guide.history}</h4>
              <p>{guide.history}</p>
            </section>
          ) : null}
          <GuideList title={t.today.guide.see} items={guide.see} />
          <GuideList title={t.today.guide.do} items={guide.do} />
          <GuideList title={t.today.guide.eat} items={guide.eat} />
          {guide.sources.length > 0 ? (
            <p className="today-place-guide__sources">
              {t.today.guide.sources}
              {guide.sources.map((source, index) => (
                <span key={source.url}>{index > 0 ? "、" : ""}<a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></span>
              ))}
            </p>
          ) : null}
        </div>
      ) : null}
      {phase === "empty" ? <p className="today-place-guide__empty">{t.today.guide.unavailable}</p> : null}
      <a className="today-place-guide__youtube" href={youtubeHref} target="_blank" rel="noreferrer">
        <Youtube aria-hidden="true" className="size-4" />
        {t.today.guide.youtube}
      </a>
    </section>
  );
}
