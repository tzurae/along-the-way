import { useCallback, useEffect, useRef, useState } from "react";

import { parseDiscoveryJobResponse, type DiscoveryJobDto } from "@along-the-way/contracts/discovery";
import type { PlaceDetailRequest } from "./PlaceThumbnail";

const VISIBLE_POLL_MS = 2_500;
const HIDDEN_POLL_MS = 12_000;

export function discoveryJobActive(job: DiscoveryJobDto | null) {
  return job?.status === "queued" || job?.status === "running";
}

/**
 * The list is ready once the save stage finished; photos keep loading after that and do not hold
 * the result back. A failed job is also a result: the member should see why.
 */
export function discoveryJobResultReady(job: DiscoveryJobDto | null) {
  return job !== null && (job.status === "failed" || job.status === "succeeded" || job.stages.save.state === "done");
}

export type DiscoveryJobBadge =
  | { kind: "running" }
  | { kind: "done"; count: number }
  | { kind: "failed" };

export interface DiscoveryJobState {
  job: DiscoveryJobDto | null;
  /** What the 地點/幫我找 navigation shows; null when there is nothing to report. */
  badge: DiscoveryJobBadge | null;
  /** Called by the 幫我找 page after it queued a job, so polling starts without waiting. */
  track(job: DiscoveryJobDto | null): void;
}

/**
 * Follows the trip's newest 調查 job at the trip-shell level, so leaving 幫我找 does not stop it.
 * Polls `jobs/latest` only while a job is queued or running (faster while the tab is visible), and
 * announces the result the first time it becomes ready while this page watched it.
 */
export function useDiscoveryJob({ tripId, request, viewing, onResult }: {
  tripId: string | undefined;
  request: PlaceDetailRequest;
  /** The member is looking at 幫我找 right now. */
  viewing: boolean;
  /** Fired once per job when its result becomes ready during this session. */
  onResult(job: DiscoveryJobDto): void;
}): DiscoveryJobState {
  const [job, setJob] = useState<DiscoveryJobDto | null>(null);
  const [seenJobId, setSeenJobId] = useState<string | null>(null);
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  const announced = useRef(new Set<string>());
  const generation = useRef(0);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  // Effects key on the trip, not on the request function's identity, so a new `request` never
  // wipes the job, the badge, or what the member already saw.
  const requestRef = useRef(request);
  requestRef.current = request;

  const accept = useCallback((next: DiscoveryJobDto | null, observedWhileActive: boolean) => {
    setJob(next);
    if (next && observedWhileActive && discoveryJobResultReady(next) && !announced.current.has(next.id)) {
      announced.current.add(next.id);
      onResultRef.current(next);
    }
  }, []);

  // Trip switch: forget the previous trip's job, then read this trip's newest one so a reload or
  // another device picks up a run in progress.
  useEffect(() => {
    const current = ++generation.current;
    setJob(null);
    setSeenJobId(null);
    if (!tripId) return;
    void requestRef.current<unknown>(`/api/trips/${tripId}/discovery/jobs/latest`)
      .then((value) => {
        if (current !== generation.current) return;
        const latest = parseDiscoveryJobResponse(value).job;
        // A job that was still running when the page opened is announced when it finishes.
        if (latest && !discoveryJobResultReady(latest)) announced.current.delete(latest.id);
        else if (latest) announced.current.add(latest.id);
        setJob(latest);
      })
      .catch(() => undefined);
  }, [tripId]);

  useEffect(() => {
    const changed = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);

  const active = discoveryJobActive(job);
  const jobId = job?.id ?? null;
  useEffect(() => {
    if (!tripId || !active) return;
    const current = generation.current;
    let stopped = false;
    let inFlight = false;
    let timer: number | null = null;
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => void poll(), document.hidden ? HIDDEN_POLL_MS : VISIBLE_POLL_MS);
    };
    // One chain only: a poll in flight schedules the next one when it settles.
    const poll = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        const latest = parseDiscoveryJobResponse(
          await requestRef.current<unknown>(`/api/trips/${tripId}/discovery/jobs/latest`),
        ).job;
        if (stopped || current !== generation.current) return;
        accept(latest, true);
      } catch {
        // A failed poll keeps the last known state; the next poll tries again.
      } finally {
        inFlight = false;
      }
      if (!stopped) schedule();
    };
    schedule();
    // Coming back to the tab checks right away instead of waiting out the slow background delay.
    const wake = () => {
      if (document.hidden || stopped || inFlight) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      void poll();
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [accept, active, jobId, tripId]);

  const ready = discoveryJobResultReady(job);
  // Seeing 幫我找 with the result on screen counts as seen.
  useEffect(() => {
    if (viewing && !hidden && job && ready) setSeenJobId(job.id);
  }, [hidden, job, ready, viewing]);
  // A seen job is acknowledged on the server once it finished (photos included), even if the
  // member already left 幫我找, so the badge does not come back on reload or another device.
  useEffect(() => {
    if (!job || !tripId || seenJobId !== job.id || discoveryJobActive(job) || job.acknowledged) return;
    const current = generation.current;
    void requestRef.current<unknown>(`/api/trips/${tripId}/discovery/jobs/${job.id}/ack`, { method: "POST" })
      .then((value) => {
        if (current === generation.current) setJob(parseDiscoveryJobResponse(value).job ?? { ...job, acknowledged: true });
      })
      .catch(() => undefined);
  }, [job, seenJobId, tripId]);

  const track = useCallback((next: DiscoveryJobDto | null) => {
    if (next && !discoveryJobResultReady(next)) announced.current.delete(next.id);
    setJob(next);
  }, []);

  const unseen = job !== null && ready && !job.acknowledged && seenJobId !== job.id;
  const badge: DiscoveryJobBadge | null = !job
    ? null
    : !ready ? { kind: "running" }
      : !unseen ? null
        : job.status === "failed" ? { kind: "failed" }
          : { kind: "done", count: job.addedCount ?? 0 };

  return { job, badge, track };
}

/** Tab title while 調查 runs, and its result while the tab is in the background. */
export function useDiscoveryJobTitle(
  badge: DiscoveryJobBadge | null,
  tripName: string | undefined,
  copy: { titleRunning(trip: string): string; titleDone(count: number, trip: string): string; titleFailed(trip: string): string },
) {
  /** The title before this hook replaced it; null while the hook is not overriding. */
  const savedTitle = useRef<string | null>(null);
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const changed = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  const kind = badge?.kind ?? null;
  const count = badge?.kind === "done" ? badge.count : 0;
  useEffect(() => {
    const override = !tripName || !kind ? null
      : kind === "running" ? copy.titleRunning(tripName)
        // A finished result only replaces the title while the tab is in the background.
        : !hidden ? null
          : kind === "failed" ? copy.titleFailed(tripName)
            : copy.titleDone(count, tripName);
    if (override === null) {
      if (savedTitle.current !== null) document.title = savedTitle.current;
      savedTitle.current = null;
      return;
    }
    savedTitle.current ??= document.title;
    document.title = override;
  }, [copy, count, hidden, kind, tripName]);
  useEffect(() => () => {
    if (savedTitle.current !== null) document.title = savedTitle.current;
  }, []);
}
