export interface TripSummaryDto {
  slug: string;
  title: string;
  destination: string;
  startDate: string;
  endDate: string;
  travelerCount: number;
  dayCount: number;
  nextDecision: string | null;
  updatedAt: string;
}

export interface TripSummaryResponse {
  trip: TripSummaryDto;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new Error("Invalid trip summary response");
}

function requiredString(value: unknown) {
  return typeof value === "string" ? value : invalidResponse();
}

function requiredCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : invalidResponse();
}

function requiredDateOnly(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : invalidResponse();
}

export function parseTripSummaryResponse(value: unknown): TripSummaryResponse {
  if (!isRecord(value) || !isRecord(value.trip)) {
    return invalidResponse();
  }

  const trip = value.trip;
  const nextDecision = trip.nextDecision;
  if (nextDecision !== null && typeof nextDecision !== "string") {
    return invalidResponse();
  }

  return {
    trip: {
      slug: requiredString(trip.slug),
      title: requiredString(trip.title),
      destination: requiredString(trip.destination),
      startDate: requiredDateOnly(trip.startDate),
      endDate: requiredDateOnly(trip.endDate),
      travelerCount: requiredCount(trip.travelerCount),
      dayCount: requiredCount(trip.dayCount),
      nextDecision,
      updatedAt: requiredString(trip.updatedAt),
    },
  };
}
