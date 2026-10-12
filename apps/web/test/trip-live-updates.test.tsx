// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useTripLiveUpdates } from "../src/useTripLiveUpdates";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  vi.stubGlobal("EventSource", class extends EventTarget {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close() {}
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("retries a failed projection immediately when the window regains focus", async () => {
  const requestCalls = vi.fn();
  const request = async <T,>(_url: string, _options?: RequestInit): Promise<T> => {
    requestCalls();
    return { tripVersion: 1, lastEventId: "event-1" } as T;
  };
  const onChanged = vi.fn()
    .mockRejectedValueOnce(new Error("temporary projection failure"))
    .mockResolvedValue(undefined);

  function Harness() {
    useTripLiveUpdates({
      tripId: "trip-1",
      request,
      onChanged,
      onRevoked: vi.fn(),
    });
    return null;
  }

  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(requestCalls).toHaveBeenCalledTimes(1);
  expect(onChanged).toHaveBeenCalledTimes(1);

  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(requestCalls).toHaveBeenCalledTimes(2);
  expect(onChanged).toHaveBeenCalledTimes(2);
});

it("checks the authoritative version every 60 seconds while SSE remains connected", async () => {
  let sourceInstance: { onopen: (() => void) | null } | null = null;
  vi.stubGlobal("EventSource", class extends EventTarget {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      super();
      sourceInstance = this;
    }
    close() {}
  });
  const requestCalls = vi.fn();
  const request = async <T,>(_url: string, _options?: RequestInit): Promise<T> => {
    requestCalls();
    return { tripVersion: 1, lastEventId: "event-1" } as T;
  };

  function Harness() {
    useTripLiveUpdates({
      tripId: "trip-1",
      request,
      onChanged: async () => {},
      onRevoked: vi.fn(),
    });
    return null;
  }

  await act(async () => {
    root.render(<Harness />);
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    sourceInstance?.onopen?.();
    await Promise.resolve();
    await Promise.resolve();
  });
  const beforeFallback = requestCalls.mock.calls.length;

  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });

  expect(requestCalls).toHaveBeenCalledTimes(beforeFallback + 1);
});
