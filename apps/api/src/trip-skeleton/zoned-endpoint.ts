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
