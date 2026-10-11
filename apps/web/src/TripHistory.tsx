import { useEffect, useRef, useState } from "react";
import { parseTripHistoryResponse, type TripHistoryEvent } from "@along-the-way/contracts/private-trips";
import { Button } from "@/components/ui/button";
import { useI18n } from "./i18n";

const HISTORY_BATCH_SIZE = 10;


export function TripHistory({ tripId, revision, active, request }: {
  tripId: string; revision: number; active: boolean;
  request<T>(url: string, options?: RequestInit): Promise<T>;
}) {
  const { t, locale } = useI18n();
  const [events, setEvents] = useState<TripHistoryEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(HISTORY_BATCH_SIZE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const needsRecovery = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const current = ++generation.current;
    needsRecovery.current = true;
    setVisibleCount(HISTORY_BATCH_SIZE);
    setBusy(true);
    void request(`/api/trips/${tripId}/history`).then((value) => {
      if (current !== generation.current) return;
      const page = parseTripHistoryResponse(value);
      needsRecovery.current = false;
      setEvents(page.events); setNextCursor(page.nextCursor); setError("");
    }).catch((reason) => {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : t.collaboration.historyError);
    }).finally(() => { if (current === generation.current) setBusy(false); });
    return () => { generation.current += 1; };
  }, [tripId, revision, request, retry, t.collaboration.historyError]);

  // The notification cursor can advance before this projection read settles.
  // Recover the visible history directly on focus when its latest read is still unresolved or failed.
  useEffect(() => {
    const recover = () => {
      if (activeRef.current && document.visibilityState !== "hidden" && needsRecovery.current) {
        setRetry((value) => value + 1);
      }
    };
    window.addEventListener("focus", recover);
    return () => window.removeEventListener("focus", recover);
  }, []);

  async function more() {
    if (busy) return;
    if (visibleCount < events.length) {
      setVisibleCount((current) => Math.min(current + HISTORY_BATCH_SIZE, events.length));
      return;
    }
    if (!nextCursor) return;
    const current = generation.current;
    setBusy(true);
    try {
      const page = parseTripHistoryResponse(await request(`/api/trips/${tripId}/history?before=${encodeURIComponent(nextCursor)}`));
      if (current !== generation.current) return;
      setEvents((previous) => [...previous, ...page.events.filter((event) => !previous.some((entry) => entry.id === event.id))]);
      setNextCursor(page.nextCursor); setError("");
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : t.collaboration.historyError);
    } finally { if (current === generation.current) setBusy(false); }
  }
  return <section className="trip-skeleton-shell" aria-labelledby="trip-history-heading">
    <h3 id="trip-history-heading" className="section-heading">{t.collaboration.history}</h3>
    {!events.length && !busy && !error ? <p>{t.collaboration.noHistory}</p> : null}
    <ol className="activity-list">{events.slice(0, visibleCount).map((event) => <li key={event.id} className="[overflow-wrap:anywhere]">
      <p className="font-semibold">{t.tripSkeleton.events[event.eventType] ?? t.collaboration.savedChange}</p>
      <p className="text-sm">{event.actorDisplayName ?? event.actorEmail} · <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString(locale)}</time></p>
      <p className="text-sm text-muted-foreground">{t.collaboration.target}：{t.collaboration.targets[event.targetType] ?? t.collaboration.savedChange}{event.targetName ? ` · ${event.targetName}` : ""}</p>
      {event.reappliedFromVersion !== null ? <p className="text-sm">{t.collaboration.reapplied(event.reappliedFromVersion)}</p> : null}
    </li>)}</ol>
    {error ? <p role="alert">{error} <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>{t.collaboration.retry}</Button></p> : null}
    {busy ? <p role="status">{t.collaboration.loading}</p> : null}
    {visibleCount < events.length || nextCursor ? <Button variant="outline" disabled={busy} onClick={() => void more()}>{t.collaboration.loadMore}</Button> : null}
  </section>;
}
