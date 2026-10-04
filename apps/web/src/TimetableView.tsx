import type {
  DayLegDto,
  DayTimetableDto,
  DayTimetableRowDto,
  TripPlanReason,
} from "@along-the-way/contracts/day-plans";

import { useI18n, type Messages } from "./i18n";

export function reasonLabel(reason: TripPlanReason, t: Messages["timetable"]) {
  switch (reason) {
    case "closed_that_day":
      return t.closedThatDay;
    case "temporarily_closed":
      return t.temporarilyClosed;
    case "permanently_closed":
      return t.permanentlyClosed;
    case "closes_too_early":
      return t.closesTooEarly;
    case "not_enough_time":
      return t.notEnoughTime;
    case "travel_unknown":
      return t.travelUnknown;
    case "no_location":
      return t.noLocation;
    case "cannot_return_to_lodging":
      return t.cannotReturnToLodging;
    case "closed_all_trip_days":
      return t.closedAllTripDays;
    case "no_day_fits":
      return t.noDayFits;
  }
}

export function loadLabel(level: DayTimetableDto["load"]["level"], t: Messages["timetable"]) {
  switch (level) {
    case "relaxed":
      return t.relaxed;
    case "balanced":
      return t.balanced;
    case "packed":
      return t.packed;
  }
}

export function clock(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function span(minutes: number, t: Messages["timetable"]) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? t.minutes(rest) : rest === 0 ? t.hours(hours) : t.hoursAndMinutes(hours, rest);
}

function legSummary(leg: DayLegDto, t: Messages["timetable"]) {
  if (leg.durationMinutes === null) return t.travelTimeUnavailable;
  // A fixed item without a map location gets an assumed allowance instead of a route.
  if (leg.mode === null) return t.estimatedTravelWithoutLocation(leg.durationMinutes);
  if (leg.mode === "walking") {
    // Walking is only chosen past 15 minutes when no train time is known.
    const unavailable = leg.transitMinutes === null && leg.durationMinutes > 15
      ? `・${t.trainTimeUnavailable}`
      : "";
    return `${t.walk(leg.durationMinutes)}${unavailable}`;
  }
  const walk = leg.walkingMinutes === null ? "" : `・${t.walkingTime(leg.walkingMinutes)}`;
  const average = leg.estimated ? `（${t.average}）` : "";
  return `${t.train(leg.durationMinutes)}${average}${walk}`;
}

export function TimetableRow({ row }: { row: DayTimetableRowDto }) {
  const { t } = useI18n();
  const travel = row.kind !== "start" && row.travel
    ? <p className="text-sm text-muted-foreground">↓ {legSummary(row.travel, t.timetable)}</p>
    : null;
  switch (row.kind) {
    case "start":
      return (
        <li className="grid grid-cols-[6.5rem_1fr] gap-x-3">
          <span className="font-mono font-bold">{clock(row.departMinute)}</span>
          <span className="font-semibold">{t.timetable.leave(row.name)}</span>
        </li>
      );
    case "visit":
      return (
        <li className="grid grid-cols-[6.5rem_1fr] gap-x-3" data-trip-place-id={row.tripPlaceId}>
          <span />
          <div>
            {travel}
            {row.waitMinutes > 0 ? (
              <p className="text-sm text-muted-foreground">
                {t.timetable.arriveAndWaitForOpening(clock(row.arriveMinute), row.waitMinutes)}
              </p>
            ) : null}
          </div>
          <span className="font-mono font-bold">{clock(row.startMinute)}–{clock(row.endMinute)}</span>
          <div>
            <p className="font-semibold">{row.name}</p>
            <p className="text-sm text-muted-foreground">
              {t.timetable.stay(row.stayMinutes)}
              {row.stayEstimated ? `（${t.timetable.estimate}）` : ""}
              {"・"}
              {row.hours === "listed" ? t.timetable.openAccordingToGoogle : t.timetable.openingHoursUnknown}
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
              {t.timetable.fixedTimeNotMoved}
              {row.bufferMinutes > 0
                ? `・${t.timetable.arriveEarly(
                    row.bufferMinutes,
                    row.bufferEstimated ? t.timetable.estimate : t.timetable.confirmed,
                  )}`
                : ""}
              {row.afterBufferMinutes > 0 ? `・${t.timetable.entryAndLuggageAfter(row.afterBufferMinutes)}` : ""}
            </p>
          </div>
        </li>
      );
    case "luggage":
      return (
        <li className="grid grid-cols-[6.5rem_1fr] gap-x-3">
          <span />
          <div>{travel}</div>
          <span className="font-mono font-bold">
            {row.arriveMinute === null || row.leaveMinute === null
              ? t.timetable.timeUnknown
              : `${clock(row.arriveMinute)}–${clock(row.leaveMinute)}`}
          </span>
          <span className="font-semibold">
            {row.action === "drop"
              ? t.timetable.leaveLuggageAt(row.name)
              : t.timetable.collectLuggageAt(row.name)}
          </span>
        </li>
      );
    case "return":
      return (
        <li className="grid grid-cols-[6.5rem_1fr] gap-x-3">
          <span />
          <div>{travel}</div>
          <span className="font-mono font-bold">{clock(row.arriveMinute)}</span>
          <span className="font-semibold">{t.timetable.backAt(row.name)}</span>
        </li>
      );
  }
}

/** Where the day starts and ends, in one sentence. */
export function describeStartAndEnd(timetable: DayTimetableDto, t: Messages["timetable"]) {
  const { startsAt, endsAt } = timetable;
  if (startsAt && endsAt) {
    return startsAt.placeId === endsAt.placeId
      ? t.startsAndEndsAt(startsAt.name)
      : t.startsAtAndEndsAt(startsAt.name, endsAt.name);
  }
  if (startsAt) return t.startsAtWithoutLodging(startsAt.name);
  if (endsAt) return t.startsAtArrivalAndEndsAt(endsAt.name);
  return t.noLodging;
}
