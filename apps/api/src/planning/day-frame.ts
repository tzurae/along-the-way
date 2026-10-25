import { Temporal } from "@js-temporal/polyfill";
import type { DayTimelineAnchor, DayTimelineFrame, DayTimelinePoint } from "@along-the-way/contracts/day-timeline";

import { comparePlannerIds, computePlanningWindow, DEPARTURE_BUFFER_MINUTES, hasPlannerCoordinates } from "./day-load";
import type { PlannerDaySnapshot, PlannerEndpoint } from "./planner-model";

function point(endpoint: PlannerEndpoint): DayTimelinePoint {
  const located = hasPlannerCoordinates(endpoint.coordinates);
  return { id: endpoint.id, latitude: located ? endpoint.coordinates!.latitude : null, longitude: located ? endpoint.coordinates!.longitude : null };
}

/**
 * The day's timeline frame (f5 §1.1), shared by the day dialog and whole-trip drafts. The one
 * time-zone conversion happens here: every minute is local, after the day's midnight.
 * `names` labels fixed items and points for a client that has no itinerary of its own.
 */
export function buildDayFrame(day: PlannerDaySnapshot, names: ReadonlyMap<string, string> = new Map()): DayTimelineFrame {
  const window = computePlanningWindow(day, day.caps);
  const date = Temporal.PlainDate.from(day.date);
  const local = (epochMinute: number) => {
    const instant = Temporal.Instant.fromEpochMilliseconds(Math.round(epochMinute * 60_000)).toZonedDateTimeISO(day.timeZone);
    return date.until(instant.toPlainDate()).days * 1440 + instant.hour * 60 + instant.minute;
  };
  const windowStartMinute = local(window.windowStartMinute);
  const windowEndMinute = window.windowMinutes === 0 ? windowStartMinute : Math.max(windowStartMinute, local(window.windowEndMinute));
  // An unresolved item has no usable end (f5 §1.1, j1 #7): the day is untimed and such items are left out.
  const anchors: DayTimelineAnchor[] = day.anchors
    .filter((anchor) => Number.isFinite(anchor.localStartMinute) && Number.isFinite(anchor.localEndMinute))
    .map((anchor) => ({ id: anchor.id, itemType: anchor.itemType, startMinute: anchor.localStartMinute,
      endMinute: Math.max(anchor.localStartMinute, anchor.localEndMinute), start: point(anchor.start), end: point(anchor.end) }))
    .sort((left, right) => left.startMinute - right.startMinute || comparePlannerIds(left.id, right.id));
  // The fixed item the window opens after: of those starting earlier, the one ending last.
  const opening = anchors.filter((anchor) => anchor.startMinute < windowStartMinute)
    .sort((left, right) => right.endMinute - left.endMinute || right.startMinute - left.startMinute || comparePlannerIds(left.id, right.id))[0];
  const closing = anchors.find((anchor) => (anchor.itemType === "flight" || anchor.itemType === "transport")
    && anchor.startMinute >= windowEndMinute);
  const labels: Record<string, string> = {};
  const label = (id: string) => {
    const name = names.get(id);
    if (name !== undefined) labels[id] = name;
  };
  for (const anchor of anchors) {
    label(anchor.id);
    label(anchor.start.id);
    label(anchor.end.id);
  }
  if (day.previousLodging) label(day.previousLodging.id);
  if (day.nightLodging) label(day.nightLodging.id);
  return {
    windowStartMinute,
    windowEndMinute,
    origin: opening ? { kind: "anchor", anchor: opening }
      : day.previousLodging ? { kind: "lodging", point: point(day.previousLodging) } : null,
    anchors: anchors.filter((anchor) => anchor.startMinute >= windowStartMinute && anchor.startMinute < windowEndMinute),
    terminal: closing
      ? { kind: "anchor", anchor: closing, arriveByMinute: closing.itemType === "flight" ? closing.startMinute - DEPARTURE_BUFFER_MINUTES : null }
      : day.nightLodging ? { kind: "lodging", point: point(day.nightLodging) } : null,
    unresolved: day.unresolvedItemIds.length > 0,
    move: { detourFactor: day.caps.detourFactor, speedKmh: day.caps.speedKmh, perLegMinutes: day.caps.perLegMinutes },
    names: labels,
  };
}
