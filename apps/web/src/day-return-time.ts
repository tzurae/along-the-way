import type { DayRouteDto, DayRouteStopDto } from "@along-the-way/contracts/day-plans";

export interface DayReturnEstimate {
  /** Local minutes after the day's midnight. */
  departMinute: number;
  /** Local minutes after the day's midnight; 1440 or more is after midnight. */
  finishMinute: number;
  endsAtLodging: boolean;
  stayEstimated: boolean;
  moveEstimated: boolean;
  /** A leg between two known points has neither transit minutes nor a straight-line estimate. */
  missingLegs: boolean;
}

/**
 * When this order gets back to the night's lodging (or leaves its last stop without one):
 * start + fixed items + every stay + every leg. A leg uses transit minutes already in the
 * dialog when present, otherwise the server's straight-line estimate. Null when the API sent
 * no timing (older server) or the day has no stops.
 */
export function estimateDayReturn(route: DayRouteDto): DayReturnEstimate | null {
  if (route.dayStartMinute === null || route.fixedMinutes === null || route.stops.length === 0) return null;
  let finishMinute = route.dayStartMinute + route.fixedMinutes;
  let stayEstimated = false;
  let moveEstimated = false;
  let missingLegs = false;
  const addLeg = (transitMinutes: number | null, estimatedMinutes: number | null) => {
    if (transitMinutes !== null) finishMinute += transitMinutes;
    else if (estimatedMinutes !== null) {
      finishMinute += estimatedMinutes;
      moveEstimated = true;
    } else missingLegs = true;
  };
  route.stops.forEach((stop, index) => {
    if (index > 0 || route.startsAt) addLeg(stop.minutesFromPrevious, stop.estimatedMoveMinutesFromPrevious);
    const stay = stop.stayMinutes ?? 0;
    finishMinute += stay;
    if (stay > 0 && stop.stayEstimated) stayEstimated = true;
  });
  if (route.endsAt) addLeg(route.minutesToEnd, route.estimatedMoveMinutesToEnd);
  return {
    departMinute: route.dayStartMinute,
    finishMinute,
    endsAtLodging: route.endsAt !== null,
    stayEstimated,
    moveEstimated,
    missingLegs,
  };
}

function clock(minute: number) {
  const inDay = minute % 1440;
  return `${String(Math.floor(inDay / 60)).padStart(2, "0")}:${String(inDay % 60).padStart(2, "0")}`;
}

/** 「09:00 出門・約 21:30 回到住宿（停留、移動是估計）」 */
export function dayReturnLine(estimate: DayReturnEstimate) {
  const daysLater = Math.floor(estimate.finishMinute / 1440);
  const finish = daysLater === 0 ? clock(estimate.finishMinute)
    : daysLater === 1 ? `隔天 ${clock(estimate.finishMinute)}`
      : `${daysLater} 天後 ${clock(estimate.finishMinute)}`;
  const estimated = estimate.stayEstimated && estimate.moveEstimated ? "（停留、移動是估計）"
    : estimate.stayEstimated ? "（停留時間是估計）"
      : estimate.moveEstimated ? "（移動是估計）" : "";
  return {
    line: `${clock(estimate.departMinute)} 出門・約 ${finish} ${estimate.endsAtLodging ? "回到住宿" : "結束最後一站"}`,
    note: `${estimated}${estimate.missingLegs ? "（部分路段無法估計）" : ""}`,
  };
}

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
