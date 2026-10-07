import { Temporal } from "@js-temporal/polyfill";
import type { TimelineDayDto, TripSkeletonDto } from "./trip-skeleton";

/** The located lodging slept in that night, not a generated planning suggestion. */
export function lodgingForNight(skeleton: TripSkeletonDto, date: string) {
  for (const item of skeleton.items) {
    if (item.type !== "lodging") continue;
    const start = item.endpoints.find((endpoint) => endpoint.role === "start");
    const end = item.endpoints.find((endpoint) => endpoint.role === "end");
    if (!start || !end || start.localDateTime.slice(0, 10) > date || end.localDateTime.slice(0, 10) <= date) continue;
    const place = skeleton.places.find((entry) => entry.id === start.placeId);
    if (place?.latitude == null || place.longitude == null) continue;
    return { place, timeZone: start.timeZone };
  }
  return null;
}

/** Shared precedence for a day's local clock. The caller supplies its explicit fallback. */
export function resolveDayTimeZone(
  skeleton: TripSkeletonDto,
  day: TimelineDayDto,
  stops: readonly { timeZone: string | null }[],
  fallback: string | null,
): string | null {
  const night = lodgingForNight(skeleton, day.date);
  const morning = lodgingForNight(skeleton, Temporal.PlainDate.from(day.date).subtract({ days: 1 }).toString());
  return (night ?? morning)?.timeZone
    ?? stops.find((stop) => stop.timeZone)?.timeZone
    ?? day.entries.flatMap((entry) => skeleton.items.find((item) => item.id === entry.itemId)?.endpoints ?? [])[0]?.timeZone
    ?? fallback;
}
