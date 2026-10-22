import type { DiscoveryNearInput } from "@along-the-way/contracts/discovery";

/** Owner decision 2026-10-22: a coarse fix within 8 s; one up to 10 minutes old is fine. */
const POSITION_OPTIONS: PositionOptions = { enableHighAccuracy: false, timeout: 8_000, maximumAge: 600_000 };
/**
 * The browser's timeout starts only after permission is granted, so a permission prompt left open
 * would otherwise hold 調查 indefinitely; past this the request goes without a position.
 */
const GIVE_UP_MS = 8_500;

/**
 * The phone's position rounded to 3 decimals (about 100 m) for one 調查 request, or null when it
 * is unavailable, denied, or slow; the server then falls back to tonight's lodging. Never stored
 * or logged here.
 */
export function currentNear(): Promise<DiscoveryNearInput | null> {
  if (!window.isSecureContext || !navigator.geolocation) return Promise.resolve(null);
  // Executor form, not Promise.withResolvers: phones on iOS before 17.4 lack it and the web bundle has no polyfill.
  return new Promise((resolve) => {
    const giveUp = window.setTimeout(() => resolve(null), GIVE_UP_MS);
    const settle = (near: DiscoveryNearInput | null) => {
      window.clearTimeout(giveUp);
      resolve(near);
    };
    try {
      navigator.geolocation.getCurrentPosition(({ coords }) => {
        const latitude = Math.round(coords.latitude * 1_000) / 1_000;
        const longitude = Math.round(coords.longitude * 1_000) / 1_000;
        settle(Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null);
      }, () => settle(null), POSITION_OPTIONS);
    } catch {
      settle(null);
    }
  });
}
