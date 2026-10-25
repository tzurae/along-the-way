import type { DayRouteStopDto } from "@along-the-way/contracts/day-plans";

/** 「1 小時 30 分」 */
export function durationText(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} 分`;
  return rest === 0 ? `${hours} 小時` : `${hours} 小時 ${rest} 分`;
}

/** 「停留約 1 小時 30 分」, 「約」 only when estimated; null for transfer points (stations, airports) and older APIs. */
export function stayText(stop: DayRouteStopDto) {
  if (stop.stayMinutes === null || stop.stayMinutes === 0) return null;
  return `停留${stop.stayEstimated ? "約" : ""} ${durationText(stop.stayMinutes)}`;
}
