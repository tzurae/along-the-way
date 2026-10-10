import { useCallback, useEffect, useRef, useState } from "react";
import { parseTripChangeNotification } from "@along-the-way/contracts/private-trips";
import { ApiRequestError } from "./api-error";

function retryAfterMilliseconds(error: unknown) {
  if (!(error instanceof ApiRequestError)) return undefined;
  const retryable = error as ApiRequestError & {
    readonly retryAfter?: string | number;
    readonly retryAfterSeconds?: number;
  };
  if (typeof retryable.retryAfterSeconds === "number" && Number.isFinite(retryable.retryAfterSeconds)) {
    return Math.max(0, retryable.retryAfterSeconds * 1_000);
  }
  if (typeof retryable.retryAfter === "number" && Number.isFinite(retryable.retryAfter)) {
    return Math.max(0, retryable.retryAfter * 1_000);
  }
  if (typeof retryable.retryAfter !== "string") return undefined;
  const seconds = Number(retryable.retryAfter);
  if (retryable.retryAfter.trim() !== "" && Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(retryable.retryAfter);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function useTripLiveUpdates({ tripId, request, onChanged, onRevoked }: {
  tripId: string | undefined;
  request<T>(url: string, options?: RequestInit): Promise<T>;
  onChanged(): Promise<void>;
  onRevoked(): void;
}) {
  const callbacks = useRef({ onChanged, onRevoked });
  callbacks.current = { onChanged, onRevoked };
  const [connected, setConnected] = useState(false);
  const projectionRetry = useRef<((failedTripId: string, error?: unknown) => void) | null>(null);
  const retryReadModels = useCallback((failedTripId: string, error?: unknown) => projectionRetry.current?.(failedTripId, error), []);
  useEffect(() => {
    if (!tripId) { setConnected(false); return; }
    let stopped = false;
    let source: EventSource | null = null;
    let reconnect: number | undefined;
    let projectionTimer: number | undefined;
    let projectionRetryAt = 0;
    let projectionBackoff = 1_000;
    let projectionDirty = false;
    let projectionFailed = false;
    let projectionFailureGeneration = 0;
    let backoff = 1_000;
    let version = 0;
    let lastEventId: string | null = null;
    let checking = false;
    let live = false;
    const controller = new AbortController();

    function setProjectionTimer(delay: number) {
      projectionRetryAt = Date.now() + delay;
      projectionTimer = window.setTimeout(() => {
        projectionTimer = undefined;
        projectionRetryAt = 0;
        if (checking) {
          scheduleProjectionRetry();
          return;
        }
        void check();
      }, delay);
    }

    function scheduleProjectionRetry(error?: unknown) {
      if (stopped) return;
      const retryAfter = retryAfterMilliseconds(error);
      if (projectionTimer !== undefined) {
        if (retryAfter === undefined) return;
        const requestedRetryAt = Date.now() + retryAfter;
        if (requestedRetryAt <= projectionRetryAt) return;
        window.clearTimeout(projectionTimer);
        setProjectionTimer(Math.max(0, requestedRetryAt - Date.now()));
        return;
      }
      const delay = Math.max(projectionBackoff, retryAfter ?? 0);
      setProjectionTimer(delay);
      projectionBackoff = Math.min(projectionBackoff * 2, 30_000);
    }

    projectionRetry.current = (failedTripId, error) => {
      if (stopped || failedTripId !== tripId) return;
      projectionDirty = true;
      projectionFailed = true;
      projectionFailureGeneration += 1;
      scheduleProjectionRetry(error);
    };

    async function check() {
      if (stopped || !navigator.onLine) return;
      if (checking || projectionTimer !== undefined) {
        projectionDirty = true;
        return;
      }
      checking = true;
      try {
        do {
          projectionDirty = false;
          const current = await request<{ tripVersion: number; lastEventId: string | null }>(`/api/trips/${tripId}/version`, { signal: controller.signal, cache: "no-store" });
          if (stopped) return;
          if (Number.isSafeInteger(current.tripVersion) && (current.tripVersion > version || projectionFailed)) {
            const failureGeneration = projectionFailureGeneration;
            await callbacks.current.onChanged();
            if (stopped) return;
            if (failureGeneration !== projectionFailureGeneration || projectionTimer !== undefined) break;
            projectionFailed = false;
            projectionBackoff = 1_000;
            if (current.tripVersion >= version) {
              version = current.tripVersion;
              lastEventId = current.lastEventId;
            }
          }
        } while (projectionDirty && !projectionFailed && projectionTimer === undefined && !stopped);
      } catch (error) {
        if (!stopped && error instanceof ApiRequestError && ["unauthenticated", "trip_not_found", "forbidden"].includes(error.code)) {
          stopped = true;
          source?.close();
          window.clearTimeout(reconnect);
          window.clearTimeout(projectionTimer);
          setConnected(false);
          callbacks.current.onRevoked();
        }
        else if (!stopped) {
          projectionDirty = true;
          projectionFailed = true;
          scheduleProjectionRetry(error);
        }
        // Reading and ordinary saves remain available when only the live path fails.
      } finally { checking = false; }
    }

    function connect() {
      if (stopped || !navigator.onLine) return;
      source?.close();
      source = new EventSource(`/api/trips/${tripId}/events${lastEventId ? `?after=${encodeURIComponent(lastEventId)}` : ""}`);
      source.onopen = () => { live = true; setConnected(true); void check(); };
      source.addEventListener("change", (event) => {
        try {
          parseTripChangeNotification(JSON.parse((event as MessageEvent<string>).data));
          backoff = 1_000;
          projectionDirty = true;
          void check();
        } catch { /* Ignore malformed hints; focus and fallback still read the authoritative version. */ }
      });
      source.onerror = () => {
        source?.close();
        live = false;
        setConnected(false);
        void check();
        if (!stopped) {
          reconnect = window.setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 30_000);
        }
      };
    }
    function regain() {
      if (document.visibilityState === "hidden") return;
      void check();
      if (!live && navigator.onLine && !stopped) { window.clearTimeout(reconnect); connect(); }
    }
    function offline() { source?.close(); live = false; setConnected(false); window.clearTimeout(reconnect); }
    void check().then(() => { if (!stopped) connect(); });
    const fallback = window.setInterval(() => { if (!live) void check(); }, 60_000);
    window.addEventListener("focus", regain);
    window.addEventListener("online", regain);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", regain);
    return () => {
      stopped = true; projectionRetry.current = null;
      controller.abort(); source?.close(); window.clearTimeout(reconnect); window.clearTimeout(projectionTimer); window.clearInterval(fallback);
      window.removeEventListener("focus", regain); window.removeEventListener("online", regain); window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", regain);
    };
  }, [tripId, request]);
  return { connected, retryReadModels };
}
