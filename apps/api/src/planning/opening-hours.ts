/** A point in a place's local week; `date` (YYYY-MM-DD) is present only for the next seven days. */
export interface OpeningPoint {
  day: number;
  hour: number;
  minute: number;
  date: string | null;
}

/** Open from `open` until `close`; a missing close means open around the clock. */
export interface OpeningPeriod {
  open: OpeningPoint;
  close: OpeningPoint | null;
}

export type BusinessStatus = "operational" | "closed_temporarily" | "closed_permanently" | "future_opening";

/** Opening hours as the provider reports them, in the place's local time. Never stored. */
export interface PlaceOpeningHours {
  businessStatus: BusinessStatus | null;
  /** The usual week; null when the provider has no hours, empty when the place never opens. */
  regular: OpeningPeriod[] | null;
  /** The coming seven days with dates, including holiday changes; null when not reported. */
  current: OpeningPeriod[] | null;
}

export interface PlaceHoursLookup {
  openingHours(providerPlaceId: string): Promise<PlaceOpeningHours>;
}

export type ClosedReason = "closed_that_day" | "temporarily_closed" | "permanently_closed";

/** Opening on one local date, in minutes from midnight. */
export type DayHours =
  | { status: "open"; intervals: Array<[number, number]> }
  | { status: "closed"; reason: ClosedReason }
  | { status: "unknown" };

const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;
/** Google returns dated hours for the seven days starting on the place's current date. */
const CURRENT_DAYS = 7;

function minutes(point: OpeningPoint) {
  return point.hour * 60 + point.minute;
}

function weekday(date: string) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Sorted, merged parts of `ranges` inside one day, as minutes from its midnight. */
function withinDay(ranges: Array<[number, number]>) {
  const clipped = ranges
    .map(([start, end]): [number, number] => [Math.max(0, start), Math.min(DAY_MINUTES, end)])
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const interval of clipped) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}

/**
 * Dated periods as ranges relative to `date`'s midnight. A period may span several
 * midnights; Google reports "always open" as an opening without a close.
 */
function datedRanges(periods: OpeningPeriod[], date: string) {
  return withinDay(periods.flatMap((period): Array<[number, number]> => {
    if (!period.close) return [[0, DAY_MINUTES]];
    if (period.open.date === null || period.close.date === null) return [];
    return [[
      daysBetween(date, period.open.date) * DAY_MINUTES + minutes(period.open),
      daysBetween(date, period.close.date) * DAY_MINUTES + minutes(period.close),
    ]];
  }));
}

/** Weekly periods as ranges relative to `date`'s midnight, counting the week from Sunday. */
function weeklyRanges(periods: OpeningPeriod[], date: string) {
  const dayStart = weekday(date) * DAY_MINUTES;
  return withinDay(periods.flatMap((period): Array<[number, number]> => {
    if (!period.close) return [[0, DAY_MINUTES]];
    const open = period.open.day * DAY_MINUTES + minutes(period.open);
    let close = period.close.day * DAY_MINUTES + minutes(period.close);
    // A period closing on an earlier weekday, or at its own opening time, runs into next week.
    if (close <= open) close += WEEK_MINUTES;
    // Last week's copy covers the start of this week for periods that wrap around Sunday.
    return [0, -WEEK_MINUTES].map((shift): [number, number] => [open + shift - dayStart, close + shift - dayStart]);
  }));
}

function dayHours(open: Array<[number, number]>): DayHours {
  return open.length ? { status: "open", intervals: open } : { status: "closed", reason: "closed_that_day" };
}

/**
 * When the place is open on a local date (YYYY-MM-DD). `today` is the place's current
 * date: the seven days from it use the dated hours, which include holidays.
 */
export function hoursOn(hours: PlaceOpeningHours | null, date: string, today: string): DayHours {
  if (!hours) return { status: "unknown" };
  if (hours.businessStatus === "closed_permanently") return { status: "closed", reason: "permanently_closed" };
  if (hours.businessStatus === "closed_temporarily") return { status: "closed", reason: "temporarily_closed" };
  const ahead = daysBetween(today, date);
  const current = hours.current;
  if (current !== null && ahead >= 0 && ahead < CURRENT_DAYS) {
    // Empty dated hours mean the place does not open this week, e.g. while closed for works.
    if (current.length === 0) return { status: "closed", reason: "temporarily_closed" };
    const dated = current.every((period) => period.open.date !== null && (period.close === null || period.close.date !== null));
    if (dated) return dayHours(datedRanges(current, date));
  }
  if (hours.regular === null) return { status: "unknown" };
  if (hours.regular.length === 0) return { status: "closed", reason: "temporarily_closed" };
  return dayHours(weeklyRanges(hours.regular, date));
}
