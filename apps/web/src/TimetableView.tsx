import type {
  DayLegDto,
  DayTimetableDto,
  DayTimetableRowDto,
  TripPlanReason,
} from "@along-the-way/contracts/day-plans";

export const reasonLabels: Record<TripPlanReason, string> = {
  closed_that_day: "Closed that day",
  temporarily_closed: "Temporarily closed",
  permanently_closed: "Permanently closed",
  closes_too_early: "Closes before the visit can end",
  not_enough_time: "Not enough time",
  travel_unknown: "Travel time unknown",
  no_location: "No map location",
  cannot_return_to_lodging: "Can't get back to the lodging in time",
  closed_all_trip_days: "Closed on every trip day",
  no_day_fits: "No day has room for it",
};

export const loadLabels: Record<DayTimetableDto["load"]["level"], string> = {
  relaxed: "Relaxed",
  balanced: "Balanced",
  packed: "Packed",
};

export function clock(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function span(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${rest} min` : rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function legSummary(leg: DayLegDto) {
  if (leg.durationMinutes === null) return "Travel time unavailable";
  // A fixed item without a map location gets an assumed allowance instead of a route.
  if (leg.mode === null) return `About ${leg.durationMinutes} min (estimate; no map location)`;
  if (leg.mode === "walking") {
    // Walking is only chosen past 15 minutes when no train time is known.
    return `Walk ${leg.durationMinutes} min${leg.transitMinutes === null && leg.durationMinutes > 15 ? " · train time unavailable" : ""}`;
  }
  const walk = leg.walkingMinutes === null ? "" : ` · walking ${leg.walkingMinutes} min`;
  return `Train ${leg.durationMinutes} min${leg.estimated ? " (average)" : ""}${walk}`;
}

export function TimetableRow({ row }: { row: DayTimetableRowDto }) {
  const travel = row.kind !== "start" && row.travel
    ? <p className="text-sm text-muted-foreground">↓ {legSummary(row.travel)}</p>
    : null;
  switch (row.kind) {
    case "start":
      return (
        <li className="grid grid-cols-[6.5rem_1fr] gap-x-3">
          <span className="font-mono font-bold">{clock(row.departMinute)}</span>
          <span className="font-semibold">Leave {row.name}</span>
        </li>
      );
    case "visit":
      return (
        <li className="grid grid-cols-[6.5rem_1fr] gap-x-3" data-trip-place-id={row.tripPlaceId}>
          <span />
          <div>
            {travel}
            {row.waitMinutes > 0 ? (
              <p className="text-sm text-muted-foreground">Arrive {clock(row.arriveMinute)} · wait {row.waitMinutes} min for opening</p>
            ) : null}
          </div>
          <span className="font-mono font-bold">{clock(row.startMinute)}–{clock(row.endMinute)}</span>
          <div>
            <p className="font-semibold">{row.name}</p>
            <p className="text-sm text-muted-foreground">
              Stay {row.stayMinutes} min{row.stayEstimated ? " (estimate)" : ""}
              {" · "}
              {row.hours === "listed" ? "Open then per Google · check last entry yourself" : "Opening hours unknown"}
            </p>
          </div>
        </li>
      );
    case "fixed":
      return (
        <li className="grid grid-cols-[6.5rem_1fr] gap-x-3" data-item-id={row.itemId}>
          <span />
          <div>{travel}</div>
          <span className="font-mono font-bold">
            {row.startsBeforeDay ? "…" : clock(row.startMinute)}–{row.endsAfterDay ? "…" : clock(row.endMinute)}
          </span>
          <div className="rounded-lg border border-accent/40 px-2 py-1">
            <p className="font-semibold">{row.title}</p>
            <p className="text-sm text-muted-foreground">
              Fixed time, not moved{row.bufferMinutes > 0 ? ` · arrive ${row.bufferMinutes} min early` : ""}
            </p>
          </div>
        </li>
      );
    case "return":
      return (
        <li className="grid grid-cols-[6.5rem_1fr] gap-x-3">
          <span />
          <div>{travel}</div>
          <span className="font-mono font-bold">{clock(row.arriveMinute)}</span>
          <span className="font-semibold">Back at {row.name}</span>
        </li>
      );
  }
}
