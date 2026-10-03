import { Temporal } from "@js-temporal/polyfill";

import type { ZonedEndpointInput } from "@along-the-way/contracts/trip-skeleton";
import { AppError } from "../private-trips/private-trip-module";

export interface ResolvedEndpoint extends ZonedEndpointInput {
  instant: string;
  utcOffset: string;
  utcOffsetMinutes: number;
}

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const UTC_OFFSET = /^[+-](?:0\d|1[0-4]):[0-5]\d$/;
const NANOSECONDS_PER_MINUTE = 60_000_000_000n;
// Temporal instants are limited to ±10^8 days from the epoch.
const MAX_EPOCH_NANOSECONDS = 8_640_000_000_000_000_000_000n;

/**
 * Whether start + duration ends on a local date, in the start's zone, within
 * [firstDate, lastDate]: the same rule explicit end endpoints obey. A time zone
 * transition can move the local date backward, so dates are compared, not instants.
 */
export function durationEndsWithinDates(
  start: ResolvedEndpoint,
  durationMinutes: number,
  firstDate: string,
  lastDate: string,
) {
  // Integer nanoseconds avoid Temporal.Duration overflow for any safe integer.
  const end = Temporal.Instant.from(start.instant).epochNanoseconds
    + BigInt(durationMinutes) * NANOSECONDS_PER_MINUTE;
  if (end > MAX_EPOCH_NANOSECONDS) return false;
  const endDate = Temporal.Instant.fromEpochNanoseconds(end)
    .toZonedDateTimeISO(start.timeZone)
    .toPlainDate();
  return Temporal.PlainDate.compare(endDate, firstDate) >= 0
    && Temporal.PlainDate.compare(endDate, lastDate) <= 0;
}

export function canonicalNamedTimeZone(value: string) {
  const supplied = value.trim();
  if (
    !supplied ||
    supplied.toUpperCase() === "Z" ||
    supplied.startsWith("+") ||
    supplied.startsWith("-")
  ) {
    return null;
  }
  try {
    const canonical = new Intl.DateTimeFormat("en-US", {
      timeZone: supplied,
    }).resolvedOptions().timeZone;
    if (
      !canonical ||
      canonical.toUpperCase() === "Z" ||
      canonical.startsWith("+") ||
      canonical.startsWith("-")
    ) {
      return null;
    }
    return canonical;
  } catch {
    return null;
  }
}

export function resolveEndpoint(input: ZonedEndpointInput): ResolvedEndpoint {
  if (!LOCAL_DATE_TIME.test(input.localDateTime)) {
    throw new AppError(
      "invalid_local_time",
      "Local date and time must use YYYY-MM-DDTHH:mm",
    );
  }
  const timeZone = canonicalNamedTimeZone(input.timeZone);
  if (!timeZone) {
    throw new AppError("validation_error", "A named IANA time zone is required");
  }

  let local: Temporal.PlainDateTime;
  let earlier: Temporal.ZonedDateTime;
  let later: Temporal.ZonedDateTime;
  try {
    local = Temporal.PlainDateTime.from(input.localDateTime);
    earlier = local.toZonedDateTime(timeZone, { disambiguation: "earlier" });
    later = local.toZonedDateTime(timeZone, { disambiguation: "later" });
  } catch {
    throw new AppError("invalid_local_time", "The local date, time, or time zone is invalid");
  }

  if (
    !earlier.toPlainDateTime().equals(local) ||
    !later.toPlainDateTime().equals(local)
  ) {
    throw new AppError(
      "invalid_local_time",
      "That local time does not exist in the selected time zone",
    );
  }

  const ambiguous = earlier.epochNanoseconds !== later.epochNanoseconds;
  let selected = earlier;
  if (ambiguous) {
    const requestedOffset = input.utcOffset?.trim() ?? "";
    if (!UTC_OFFSET.test(requestedOffset)) {
      throw new AppError(
        "ambiguous_local_time",
        "That local time occurs twice; choose its UTC offset",
      );
    }
    if (later.offset === requestedOffset) selected = later;
    else if (earlier.offset !== requestedOffset) {
      throw new AppError(
        "ambiguous_local_time",
        "The UTC offset does not match either occurrence of that local time",
      );
    }
  } else if (input.utcOffset && input.utcOffset !== earlier.offset) {
    throw new AppError(
      "invalid_local_time",
      "The UTC offset does not match the selected local time",
    );
  }

  return {
    ...input,
    timeZone: selected.timeZoneId,
    utcOffset: selected.offset,
    utcOffsetMinutes: Math.trunc(selected.offsetNanoseconds / 60_000_000_000),
    instant: selected.toInstant().toString(),
  };
}
