import { ArrowUpRight, LoaderCircle, MapPin } from "lucide-react";
import type { NearbyActivitiesResponse, NearbyActivityDto } from "@along-the-way/contracts/trip-places";

import { safeExternalUrl } from "./external-url";
import { googleMapsSearchUrl } from "./google-maps";
import { useI18n, type Messages } from "./i18n";

/** One 附近活動 sheet: the stop it was opened from and the single request behind it. */
export type NearbyActivitiesState = {
  dayId: string;
  date: string;
  stopTripPlaceId: string;
  stopName: string;
  /** Focus returns here when the sheet closes. */
  triggerKey: string;
  phase: "loading" | "ready" | "error";
  response: NearbyActivitiesResponse | null;
  error: "quota" | "unavailable" | null;
};

/** 「今天 18:00–21:30」 only from times a source stated; otherwise the honest fallback. */
function activityTime(activity: NearbyActivityDto, todayDate: string | null, copy: Messages["today"]["nearbyActivities"]) {
  if (activity.startsAt) {
    const date = activity.startsAt.slice(0, 10);
    const day = date === todayDate ? copy.today : `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
    return `${day} ${activity.startsAt.slice(11, 16)}${activity.endsAt ? `–${activity.endsAt.slice(11, 16)}` : ""}`;
  }
  return activity.timeText ?? (activity.kind === "experience" ? copy.ongoing : copy.timeUnknown);
}

export function NearbyActivitiesContent({ state, timeZone, todayDate, retry }: {
  state: NearbyActivitiesState;
  timeZone: string | null;
  /** Today's date in the trip's time zone while the trip is under way; otherwise null. */
  todayDate: string | null;
  retry(): void;
}) {
  const { t, locale } = useI18n();
  const copy = t.today.nearbyActivities;
  if (state.phase === "loading") {
    return <div className="today-activities">
      <p className="today-activities__loading" role="status">
        <LoaderCircle className="animate-spin motion-reduce:animate-none" size={16} aria-hidden="true" />{copy.loading}
      </p>
      <ul className="today-activities__list" aria-hidden="true">
        {Array.from({ length: 3 }, (_, index) => <li className="today-activity today-activity--skeleton" key={index}>
          <span className="place-list-skeleton__block today-activity__skeleton-title" />
          <span className="place-list-skeleton__block today-activity__skeleton-meta" />
          <span className="place-list-skeleton__block today-activity__skeleton-line" />
        </li>)}
      </ul>
    </div>;
  }
  if (state.phase === "error" || !state.response) {
    return <div className="today-activities__state" role="alert">
      <p>{state.error === "quota" ? copy.quota : copy.unavailable}</p>
      {state.error === "quota" ? null : <button type="button" onClick={retry}>{copy.retry}</button>}
    </div>;
  }
  const { activities, fetchedAt, date } = state.response;
  const fetchedTime = new Intl.DateTimeFormat(locale, {
    timeZone: timeZone ?? "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(fetchedAt));
  return <div className="today-activities">
    {activities.length === 0
      ? <p className="today-activities__state" role="status">{date === todayDate ? copy.empty : copy.emptyOtherDay}</p>
      : <ul className="today-activities__list">
        {activities.map((activity, index) => {
          const source = safeExternalUrl(activity.sourceUrl);
          const meters = activity.straightLineMeters;
          return <li className="today-activity" key={`${index}:${activity.sourceUrl}:${activity.title}`}>
            <h3 className="today-activity__title">{activity.title}</h3>
            <p className="today-activity__meta">
              <span>{activityTime(activity, todayDate, copy)}</span>
              {meters === null ? null : <span>{copy.distance(meters < 1_000
                ? `${new Intl.NumberFormat(locale).format(meters)} m`
                : `${(meters / 1_000).toFixed(1)} km`)}</span>}
            </p>
            {activity.description ? <p className="today-activity__description">{activity.description}</p> : null}
            <div className="today-activity__links">
              {source ? <a className="today-activity__link" href={source} target="_blank" rel="noopener noreferrer">
                <span className="today-activity__source">{copy.source(activity.sourceTitle ?? new URL(source).hostname)}</span>
                <ArrowUpRight size={14} aria-hidden="true" />
                <span className="sr-only">{t.today.leavesApp}</span>
              </a> : null}
              <a
                className="today-activity__link today-activity__link--secondary"
                href={googleMapsSearchUrl(activity.title, activity)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <MapPin size={14} aria-hidden="true" />{copy.maps}<span className="sr-only">{t.today.leavesApp}</span>
              </a>
            </div>
          </li>;
        })}
      </ul>}
    <p className="today-activities__footer">{copy.footer(fetchedTime)}</p>
  </div>;
}
