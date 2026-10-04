import { isRecord } from "./type-guards";

export type PlaceType =
  | "airport"
  | "station"
  | "lodging"
  | "restaurant"
  | "activity"
  | "other";

export type PlaceLocationStatus =
  | "complete"
  | "coordinates_missing"
  | "timezone_missing";

export interface PlaceDto {
  id: string;
  tripId: string;
  name: string;
  type: PlaceType;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  timeZone: string | null;
  sourceUrl: string | null;
  notes: string | null;
  locationStatus: PlaceLocationStatus;
  version: number;
}

export interface CreatePlaceInput {
  name: string;
  type: PlaceType;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  timeZone?: string | null;
  sourceUrl?: string | null;
  notes?: string | null;
}

export interface UpdatePlaceInput extends CreatePlaceInput {
  expectedVersion: number;
}

export type ItineraryItemType =
  | "flight"
  | "lodging"
  | "transport"
  | "reservation"
  | "meal"
  | "activity"
  | "free-time";

export interface MoneyDto {
  amountMinor: number;
  currency: string;
}

export type EndpointRole = "start" | "end";

export interface ZonedEndpointDto {
  role: EndpointRole;
  /** Null only for a flight or transport endpoint outside the trip's country stops. */
  countryStopId: string | null;
  placeId: string;
  localDateTime: string;
  timeZone: string;
  utcOffset: string;
  instant: string;
}

export interface ZonedEndpointInput {
  role: EndpointRole;
  /** Null only for a flight or transport endpoint outside the trip's country stops. */
  countryStopId: string | null;
  placeId: string;
  localDateTime: string;
  timeZone: string;
  utcOffset?: string | null;
}

export type ConstraintType = "fixed_time" | "immovable" | "minimum_buffer";
export type ConstraintStatus = "confirmed" | "unknown" | "conflicted";

export interface ConstraintDto {
  id: string;
  itemId: string;
  type: ConstraintType;
  status: ConstraintStatus;
  minimumBufferMinutes: number | null;
  version: number;
}

export interface ConstraintInput {
  type: ConstraintType;
  status: ConstraintStatus;
  minimumBufferMinutes?: number | null;
}

export interface FlightDetails {
  carrier: string | null;
  serviceNumber: string;
  confirmationNotes: string | null;
}

export interface LodgingDetails {
  bookedBy: string | null;
  confirmationCode: string | null;
}

export interface TransportDetails {
  mode: string;
  ticketInfo: string | null;
}

export interface AppointmentDetails {
  durationMinutes: number;
  bookedBy: string | null;
  confirmationStatus: string | null;
}

export interface FreeTimeDetails {
  durationMinutes: number;
}

export interface ItineraryParticipantDto {
  memberId: string;
  displayName: string | null;
  email: string;
  removed: boolean;
}

interface ItineraryItemBase {
  id: string;
  tripId: string;
  title: string;
  notes: string | null;
  sourceUrl: string | null;
  money: MoneyDto | null;
  lockedAt: string | null;
  lockedBy: string | null;
  version: number;
  endpoints: ZonedEndpointDto[];
  constraints: ConstraintDto[];
  participants: ItineraryParticipantDto[] | null;
}

export type ItineraryItemDto =
  | (ItineraryItemBase & { type: "flight"; details: FlightDetails })
  | (ItineraryItemBase & { type: "lodging"; details: LodgingDetails })
  | (ItineraryItemBase & { type: "transport"; details: TransportDetails })
  | (ItineraryItemBase & {
      type: "reservation" | "meal" | "activity";
      details: AppointmentDetails;
    })
  | (ItineraryItemBase & { type: "free-time"; details: FreeTimeDetails });

export type ItineraryItemDetails = ItineraryItemDto["details"];

export interface CreateItineraryItemInput {
  type: ItineraryItemType;
  title: string;
  participantMemberIds: string[] | null;
  notes?: string | null;
  sourceUrl?: string | null;
  money?: MoneyDto | null;
  endpoints: ZonedEndpointInput[];
  details: ItineraryItemDetails;
  constraints?: ConstraintInput[];
}

export type UpdateItineraryItemInput = Omit<
  CreateItineraryItemInput,
  "constraints"
> & {
  expectedVersion: number;
};

export interface TimelineEntryDto {
  itemId: string;
  projection: "full" | "continuation";
  sortInstant: string;
}

export interface TimelineDayDto {
  id: string;
  date: string;
  entries: TimelineEntryDto[];
}

export interface ChangeEventDto {
  id: string;
  actorId: string;
  eventType: string;
  targetType: string;
  targetId: string;
  summary: string;
  createdAt: string;
}

export interface TripSkeletonDto {
  tripVersion: number;
  places: PlaceDto[];
  items: ItineraryItemDto[];
  days: TimelineDayDto[];
  tripInformationItemIds: string[];
  events: ChangeEventDto[];
}

export interface TripSkeletonResponse {
  skeleton: TripSkeletonDto;
}

export interface PlaceResponse {
  place: PlaceDto;
}

export interface ItineraryItemResponse {
  item: ItineraryItemDto;
}

function invalidResponse(): never {
  throw new Error("Invalid trip skeleton response");
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : invalidResponse();
}

function nullableString(value: unknown) {
  return value === null || typeof value === "string" ? value : invalidResponse();
}

function nullableNumber(value: unknown) {
  return value === null || (typeof value === "number" && Number.isFinite(value))
    ? value
    : invalidResponse();
}

function integerValue(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : invalidResponse();
}

function nullableInteger(value: unknown) {
  return value === null ? value : integerValue(value);
}

function placeTypeValue(value: unknown): PlaceType {
  if (
    value === "airport" ||
    value === "station" ||
    value === "lodging" ||
    value === "restaurant" ||
    value === "activity" ||
    value === "other"
  ) {
    return value;
  }
  return invalidResponse();
}

function locationStatusValue(value: unknown): PlaceLocationStatus {
  if (
    value === "complete" ||
    value === "coordinates_missing" ||
    value === "timezone_missing"
  ) {
    return value;
  }
  return invalidResponse();
}

function placeValue(value: unknown): PlaceDto {
  if (!isRecord(value)) return invalidResponse();
  return {
    id: stringValue(value.id),
    tripId: stringValue(value.tripId),
    name: stringValue(value.name),
    type: placeTypeValue(value.type),
    address: nullableString(value.address),
    latitude: nullableNumber(value.latitude),
    longitude: nullableNumber(value.longitude),
    timeZone: nullableString(value.timeZone),
    sourceUrl: nullableString(value.sourceUrl),
    notes: nullableString(value.notes),
    locationStatus: locationStatusValue(value.locationStatus),
    version: integerValue(value.version),
  };
}

function endpointRoleValue(value: unknown): EndpointRole {
  if (value === "start" || value === "end") return value;
  return invalidResponse();
}

function endpointValue(value: unknown): ZonedEndpointDto {
  if (!isRecord(value)) return invalidResponse();
  return {
    role: endpointRoleValue(value.role),
    countryStopId: nullableString(value.countryStopId),
    placeId: stringValue(value.placeId),
    localDateTime: stringValue(value.localDateTime),
    timeZone: stringValue(value.timeZone),
    utcOffset: stringValue(value.utcOffset),
    instant: stringValue(value.instant),
  };
}

function constraintTypeValue(value: unknown): ConstraintType {
  if (value === "fixed_time" || value === "immovable" || value === "minimum_buffer") {
    return value;
  }
  return invalidResponse();
}

function constraintStatusValue(value: unknown): ConstraintStatus {
  if (value === "confirmed" || value === "unknown" || value === "conflicted") {
    return value;
  }
  return invalidResponse();
}

function constraintValue(value: unknown): ConstraintDto {
  if (!isRecord(value)) return invalidResponse();
  return {
    id: stringValue(value.id),
    itemId: stringValue(value.itemId),
    type: constraintTypeValue(value.type),
    status: constraintStatusValue(value.status),
    minimumBufferMinutes: nullableInteger(value.minimumBufferMinutes),
    version: integerValue(value.version),
  };
}

function moneyValue(value: unknown): MoneyDto | null {
  if (value === null) return null;
  if (!isRecord(value)) return invalidResponse();
  return {
    amountMinor: integerValue(value.amountMinor),
    currency: stringValue(value.currency),
  };
}

function appointmentDetails(value: unknown): AppointmentDetails {
  if (!isRecord(value)) return invalidResponse();
  return {
    durationMinutes: integerValue(value.durationMinutes),
    bookedBy: nullableString(value.bookedBy),
    confirmationStatus: nullableString(value.confirmationStatus),
  };
}

function participantsValue(value: unknown): ItineraryParticipantDto[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0) return invalidResponse();
  const memberIds = new Set<string>();
  return value.map((participant) => {
    if (!isRecord(participant) || typeof participant.removed !== "boolean") {
      return invalidResponse();
    }
    const memberId = stringValue(participant.memberId);
    if (memberIds.has(memberId)) return invalidResponse();
    memberIds.add(memberId);
    return {
      memberId,
      displayName: nullableString(participant.displayName),
      email: stringValue(participant.email),
      removed: participant.removed,
    };
  });
}

function itemValue(value: unknown): ItineraryItemDto {
  if (!isRecord(value) || !Array.isArray(value.endpoints) || !Array.isArray(value.constraints)) {
    return invalidResponse();
  }
  const base = {
    id: stringValue(value.id),
    tripId: stringValue(value.tripId),
    title: stringValue(value.title),
    notes: nullableString(value.notes),
    sourceUrl: nullableString(value.sourceUrl),
    money: moneyValue(value.money),
    lockedAt: nullableString(value.lockedAt),
    lockedBy: nullableString(value.lockedBy),
    version: integerValue(value.version),
    endpoints: value.endpoints.map(endpointValue),
    constraints: value.constraints.map(constraintValue),
    participants: participantsValue(value.participants),
  };
  if (!isRecord(value.details)) return invalidResponse();
  switch (value.type) {
    case "flight":
      return {
        ...base,
        type: value.type,
        details: {
          carrier: nullableString(value.details.carrier),
          serviceNumber: stringValue(value.details.serviceNumber),
          confirmationNotes: nullableString(value.details.confirmationNotes),
        },
      };
    case "lodging":
      return {
        ...base,
        type: value.type,
        details: {
          bookedBy: nullableString(value.details.bookedBy),
          confirmationCode: nullableString(value.details.confirmationCode),
        },
      };
    case "transport":
      return {
        ...base,
        type: value.type,
        details: {
          mode: stringValue(value.details.mode),
          ticketInfo: nullableString(value.details.ticketInfo),
        },
      };
    case "reservation":
    case "meal":
    case "activity":
      return { ...base, type: value.type, details: appointmentDetails(value.details) };
    case "free-time":
      return {
        ...base,
        type: value.type,
        details: { durationMinutes: integerValue(value.details.durationMinutes) },
      };
    default:
      return invalidResponse();
  }
}

function timelineEntryValue(value: unknown): TimelineEntryDto {
  if (!isRecord(value)) return invalidResponse();
  if (value.projection !== "full" && value.projection !== "continuation") {
    return invalidResponse();
  }
  return {
    itemId: stringValue(value.itemId),
    projection: value.projection,
    sortInstant: stringValue(value.sortInstant),
  };
}

function timelineDayValue(value: unknown): TimelineDayDto {
  if (!isRecord(value) || !Array.isArray(value.entries)) return invalidResponse();
  return {
    id: stringValue(value.id),
    date: stringValue(value.date),
    entries: value.entries.map(timelineEntryValue),
  };
}

function changeEventValue(value: unknown): ChangeEventDto {
  if (!isRecord(value)) return invalidResponse();
  return {
    id: stringValue(value.id),
    actorId: stringValue(value.actorId),
    eventType: stringValue(value.eventType),
    targetType: stringValue(value.targetType),
    targetId: stringValue(value.targetId),
    summary: stringValue(value.summary),
    createdAt: stringValue(value.createdAt),
  };
}

export function parseTripSkeletonResponse(value: unknown): TripSkeletonResponse {
  if (!isRecord(value) || !isRecord(value.skeleton)) return invalidResponse();
  const skeleton = value.skeleton;
  if (
    !Array.isArray(skeleton.places) ||
    !Array.isArray(skeleton.items) ||
    !Array.isArray(skeleton.days) ||
    !Array.isArray(skeleton.tripInformationItemIds) ||
    !Array.isArray(skeleton.events)
  ) {
    return invalidResponse();
  }
  return {
    skeleton: {
      tripVersion: integerValue(skeleton.tripVersion),
      places: skeleton.places.map(placeValue),
      items: skeleton.items.map(itemValue),
      days: skeleton.days.map(timelineDayValue),
      tripInformationItemIds: skeleton.tripInformationItemIds.map(stringValue),
      events: skeleton.events.map(changeEventValue),
    },
  };
}

export function parsePlaceResponse(value: unknown): PlaceResponse {
  if (!isRecord(value)) return invalidResponse();
  return { place: placeValue(value.place) };
}

export function parseItineraryItemResponse(value: unknown): ItineraryItemResponse {
  if (!isRecord(value)) return invalidResponse();
  return { item: itemValue(value.item) };
}
