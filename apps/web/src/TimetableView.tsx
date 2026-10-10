import type {
  DayLegDto,
  DayTimetableDto,
  DayTimetableRowDto,
  TripPlanReason,
} from "@along-the-way/contracts/day-plans";
import { Clock3, Lock, MapPin, Route } from "lucide-react";

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
  const travel = row.kind !== "start" ? row.travel : null;
  const travelLabel = travel ? legSummary(travel, t.timetable) : null;
  const travelUnavailable = travel?.durationMinutes === null;

  switch (row.kind) {
    case "start":
      return (
        <li className="route-stop route-stop-start">
          <time className="route-stop-time">{clock(row.departMinute)}</time>
          <span className="route-stop-track" aria-hidden="true" />
          <div className="route-stop-content">
            <div className="route-stop-title">
              <strong>{t.timetable.leave(row.name)}</strong>
              <span className="route-fixed-note"><Route /> {t.timetable.confirmed}</span>
            </div>
          </div>
        </li>
      );
    case "visit":
      return (
        <li
          className={`route-stop${travelUnavailable ? " route-stop-unknown" : ""}`}
          data-trip-place-id={row.tripPlaceId}
        >
          <time className="route-stop-time">{clock(row.startMinute)}</time>
          <span className="route-stop-track" aria-hidden="true" />
          <div className="route-stop-content">
            <div className="route-stop-title">
              <strong>{row.name}</strong>
              {row.hours === "listed" ? (
                <span className="route-fixed-note"><Clock3 /> {t.timetable.confirmed}</span>
              ) : null}
            </div>
            <div className="route-stop-meta">
              <span>{clock(row.startMinute)}–{clock(row.endMinute)}</span>
              <span>
                {t.timetable.stay(row.stayMinutes)}
                {row.stayEstimated ? `（${t.timetable.estimate}）` : ""}
              </span>
              {travelLabel ? <span>{travelLabel}</span> : null}
            </div>
            {row.waitMinutes > 0 ? (
              <p className="route-stop-reason">
                <Clock3 />
                {t.timetable.arriveAndWaitForOpening(clock(row.arriveMinute), row.waitMinutes)}
              </p>
            ) : null}
            {row.hours === "unknown" ? (
              <p className="route-stop-evidence">{t.timetable.openingHoursUnknown}</p>
            ) : null}
          </div>
        </li>
      );
    case "fixed":
      return (
        <li
          className={`route-stop route-stop-fixed${travelUnavailable ? " route-stop-unknown" : ""}`}
          data-item-id={row.itemId}
        >
          <time className="route-stop-time">
            {row.startsBeforeDay ? "…" : clock(row.startMinute)}
          </time>
          <span className="route-stop-track" aria-hidden="true" />
          <div className="route-stop-content">
            <div className="route-stop-title">
              <strong>{row.title}</strong>
              <span className="route-fixed-note"><Lock /> {t.timetable.fixedTimeNotMoved}</span>
            </div>
            <div className="route-stop-meta">
              <span>
                {row.startsBeforeDay ? "…" : clock(row.startMinute)}
                –
                {row.endsAfterDay ? "…" : clock(row.endMinute)}
              </span>
              {travelLabel ? <span>{travelLabel}</span> : null}
            </div>
            {row.bufferMinutes > 0 ? (
              <p className="route-stop-evidence">
                {t.timetable.arriveEarly(
                  row.bufferMinutes,
                  row.bufferEstimated ? t.timetable.estimate : t.timetable.confirmed,
                )}
              </p>
            ) : null}
            {row.afterBufferMinutes > 0 ? (
              <p className="route-stop-evidence">{t.timetable.entryAndLuggageAfter(row.afterBufferMinutes)}</p>
            ) : null}
          </div>
        </li>
      );
    case "luggage":
      return (
        <li className={`route-stop route-stop-fixed${travelUnavailable ? " route-stop-unknown" : ""}`}>
          <time className="route-stop-time">
            {row.arriveMinute === null ? "—" : clock(row.arriveMinute)}
          </time>
          <span className="route-stop-track" aria-hidden="true" />
          <div className="route-stop-content">
            <div className="route-stop-title">
              <strong>
                {row.action === "drop"
                  ? t.timetable.leaveLuggageAt(row.name)
                  : t.timetable.collectLuggageAt(row.name)}
              </strong>
              <span className="route-fixed-note"><MapPin /> {t.timetable.fixedTimeNotMoved}</span>
            </div>
            <div className="route-stop-meta">
              <span>
                {row.arriveMinute === null || row.leaveMinute === null
                  ? t.timetable.timeUnknown
                  : `${clock(row.arriveMinute)}–${clock(row.leaveMinute)}`}
              </span>
              {travelLabel ? <span>{travelLabel}</span> : null}
            </div>
          </div>
        </li>
      );
    case "return":
      return (
        <li className={`route-stop route-stop-fixed${travelUnavailable ? " route-stop-unknown" : ""}`}>
          <time className="route-stop-time">{clock(row.arriveMinute)}</time>
          <span className="route-stop-track" aria-hidden="true" />
          <div className="route-stop-content">
            <div className="route-stop-title">
              <strong>{t.timetable.backAt(row.name)}</strong>
              <span className="route-fixed-note"><MapPin /> {t.timetable.confirmed}</span>
            </div>
            {travelLabel ? <div className="route-stop-meta"><span>{travelLabel}</span></div> : null}
          </div>
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
