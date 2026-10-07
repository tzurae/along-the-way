import { useCallback, useEffect, useRef, useState } from "react";
import { parseTripChangeNotification } from "@along-the-way/contracts/private-trips";
import { ApiRequestError } from "./api-error";

export function useTripLiveUpdates({ tripId, request, onChanged, onRevoked }: {
  tripId: string | undefined;
  request<T>(url: string, options?: RequestInit): Promise<T>;
  onChanged(): Promise<void>;
  onRevoked(): void;
}) {
  const callbacks = useRef({ onChanged, onRevoked });
  callbacks.current = { onChanged, onRevoked };
  const [connected, setConnected] = useState(false);
  const projectionRetry = useRef<((failedTripId: string) => void) | null>(null);
  const retryReadModels = useCallback((failedTripId: string) => projectionRetry.current?.(failedTripId), []);
  useEffect(() => {
    if (!tripId) { setConnected(false); return; }
    let stopped = false;
    let source: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let projectionTimer: ReturnType<typeof setTimeout> | undefined;
    let projectionBackoff = 1_000;
    let projectionDirty = false;
    let backoff = 1_000;
    let version = 0;
    let lastEventId: string | null = null;
    let checking = false;
    let pending = false;
    let live = false;
    const controller = new AbortController();
    function scheduleProjectionRetry() {
      if (stopped || projectionTimer !== undefined) return;
      projectionTimer = setTimeout(() => { projectionTimer = undefined; void check(); }, projectionBackoff);
      projectionBackoff = Math.min(projectionBackoff * 2, 30_000);
    }
    projectionRetry.current = (failedTripId) => {
      if (stopped || failedTripId !== tripId) return;
      projectionDirty = true;
      scheduleProjectionRetry();
    };

    async function check() {
      if (stopped || !navigator.onLine) return;
      if (checking) { pending = true; return; }
      checking = true;
      try {
        do {
          pending = false;
          const current = await request<{ tripVersion: number; lastEventId: string | null }>(`/api/trips/${tripId}/version`, { signal: controller.signal, cache: "no-store" });
          if (stopped) return;
          if (Number.isSafeInteger(current.tripVersion) && (current.tripVersion > version || projectionDirty)) {
            const retrying = projectionDirty;
            projectionDirty = false;
            await callbacks.current.onChanged();
            if (stopped) return;
            if (!retrying) projectionBackoff = 1_000;
            if (current.tripVersion >= version) {
              version = current.tripVersion;
              // This is a notification cursor, not a projection acknowledgement.
              // Failed child reads explicitly retry even at the same version.
              lastEventId = current.lastEventId;
            }
          }
        } while (pending && !stopped);
      } catch (error) {
        if (!stopped && error instanceof ApiRequestError && ["unauthenticated", "trip_not_found", "forbidden"].includes(error.code)) {
          stopped = true;
          source?.close();
          clearTimeout(reconnect);
          clearTimeout(projectionTimer);
          setConnected(false);
          callbacks.current.onRevoked();
        }
        else if (!stopped) {
          projectionDirty = true;
          scheduleProjectionRetry();
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
          void check();
        } catch { /* Ignore malformed hints; focus and fallback still read the authoritative version. */ }
      });
      source.onerror = () => {
        source?.close();
        live = false;
        setConnected(false);
        void check();
        if (!stopped) {
          reconnect = setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 30_000);
        }
      };
    }
    function regain() {
      if (document.visibilityState === "hidden") return;
      void check();
      if (!live && navigator.onLine && !stopped) { clearTimeout(reconnect); connect(); }
    }
    function offline() { source?.close(); live = false; setConnected(false); clearTimeout(reconnect); }
    void check().then(() => { if (!stopped) connect(); });
    const fallback = setInterval(() => { if (!live) void check(); }, 60_000);
    window.addEventListener("focus", regain);
    window.addEventListener("online", regain);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", regain);
    return () => {
      stopped = true; projectionRetry.current = null;
      controller.abort(); source?.close(); clearTimeout(reconnect); clearTimeout(projectionTimer); clearInterval(fallback);
      window.removeEventListener("focus", regain); window.removeEventListener("online", regain); window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", regain);
    };
  }, [tripId, request]);
  return { connected, retryReadModels };
}
