import { Temporal } from "@js-temporal/polyfill";
import { resolveDayTimeZone } from "@along-the-way/contracts/day-time-zone";
import type { TripDto } from "@along-the-way/contracts/private-trips";
import type { TripPlaceDto } from "@along-the-way/contracts/trip-places";
import type { ItineraryItemDto, ItineraryItemType, TripSkeletonDto } from "@along-the-way/contracts/trip-skeleton";

export type TodayFact = "carrier" | "serviceNumber" | "confirmationNotes" | "bookedBy" | "confirmationCode" | "mode" | "ticketInfo" | "durationMinutes" | "confirmationStatus";
export interface TodayPlace {
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
}
export interface TodayItem {
  id: string;
  title: string;
  type: ItineraryItemType;
  start: string | null;
  end: string | null;
  endpoints: Array<{ role: "start" | "end"; instant: string; timeZone: string; place: TodayPlace | null }>;
  participants: Array<{ id: string; name: string }> | null;
  locked: boolean;
  constraints: Array<{ type: "fixed_time" | "immovable" | "minimum_buffer"; status: "confirmed" | "unknown" | "conflicted"; minutes: number | null }>;
  facts: Array<{ kind: TodayFact; value: string }>;
  notes: string | null;
  sourceUrl: string | null;
}
export interface TodayDay {
  id: string;
  date: string;
  timeZone: string | null;
  itemIds: string[];
  wishlist: Array<{ id: string; name: string }>;
}
export interface TodayModel {
  tripId: string;
  tripName: string;
  tripVersion: number;
  memberId: string;
  days: TodayDay[];
  items: TodayItem[];
}

function itemFacts(item: ItineraryItemDto): TodayItem["facts"] {
  const facts: TodayItem["facts"] = [];
  const add = (kind: TodayFact, value: string | number | null) => {
    if (value !== null && value !== "") facts.push({ kind, value: String(value) });
  };
  switch (item.type) {
    case "flight":
      add("carrier", item.details.carrier); add("serviceNumber", item.details.serviceNumber); add("confirmationNotes", item.details.confirmationNotes); break;
    case "lodging":
      add("bookedBy", item.details.bookedBy); add("confirmationCode", item.details.confirmationCode); break;
    case "transport":
      add("mode", item.details.mode); add("ticketInfo", item.details.ticketInfo); break;
    case "activity": case "meal": case "reservation":
      add("bookedBy", item.details.bookedBy); add("confirmationStatus", item.details.confirmationStatus);
      add("durationMinutes", item.details.durationMinutes); break;
    case "free-time": add("durationMinutes", item.details.durationMinutes);
  }
  return facts;
}

/** Explicit allowlist: API objects (including members, events and provider facts) are never persisted. */
export function createTodayModel(trip: TripDto, skeleton: TripSkeletonDto, places: TripPlaceDto[], userId: string): TodayModel {
  const member = trip.members.find((entry) => entry.userId === userId);
  if (!member || trip.version !== skeleton.tripVersion) throw new Error("Today read model requires a current authorized trip version");
  const byPlace = new Map(skeleton.places.map((place) => [place.id, place]));
  const items = skeleton.items.map((item): TodayItem => {
    const start = item.endpoints.find((endpoint) => endpoint.role === "start")?.instant ?? null;
    let end = item.endpoints.find((endpoint) => endpoint.role === "end")?.instant ?? null;
    if (!end && start && "durationMinutes" in item.details) {
      try { end = Temporal.Instant.from(start).add({ minutes: item.details.durationMinutes }).toString(); } catch { /* Legacy out-of-range duration stays visibly unconfirmed. */ }
    }
    return {
      id: item.id, title: item.title, type: item.type, start, end,
      endpoints: item.endpoints.map((endpoint) => {
        const place = byPlace.get(endpoint.placeId);
        return { role: endpoint.role, instant: endpoint.instant, timeZone: endpoint.timeZone,
          place: place ? { name: place.name, address: place.address, latitude: place.latitude, longitude: place.longitude } : null };
      }),
      participants: item.participants?.map((person) => ({ id: person.memberId, name: person.displayName ?? person.email })) ?? null,
      locked: item.lockedAt !== null,
      constraints: item.constraints.map((constraint) => ({ type: constraint.type, status: constraint.status, minutes: constraint.minimumBufferMinutes })),
      facts: itemFacts(item), notes: item.notes, sourceUrl: item.sourceUrl,
    };
  });
  return {
    tripId: trip.id, tripName: trip.name, tripVersion: skeleton.tripVersion, memberId: member.id, items,
    days: skeleton.days.map((day) => {
      const assigned = places.filter((place) => place.assignedDayId === day.id && !place.scheduled)
        .sort((a, b) => (a.dayPosition ?? Number.MAX_SAFE_INTEGER) - (b.dayPosition ?? Number.MAX_SAFE_INTEGER));
      const timeZone = resolveDayTimeZone(skeleton, day, assigned.filter((place) => place.latitude !== null && place.longitude !== null), trip.countryStops[0]?.timeZone ?? null);
      const itemIds = new Set(day.entries.map((entry) => entry.itemId));
      if (timeZone) {
        const date = Temporal.PlainDate.from(day.date);
        const dayStart = date.toZonedDateTime(timeZone).epochMilliseconds;
        // A midnight gap can start today at 01:00; tomorrow must resolve its own start.
        const dayEnd = date.add({ days: 1 }).toZonedDateTime(timeZone).epochMilliseconds;
        for (const item of items) {
          if (item.start && item.end && Date.parse(item.start) < dayEnd && Date.parse(item.end) > dayStart) itemIds.add(item.id);
        }
      }
      return { id: day.id, date: day.date,
        timeZone, itemIds: [...itemIds],
        wishlist: assigned.map((place) => ({ id: place.id, name: place.name })),
      };
    }).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export function localDate(now: number, timeZone: string) {
  return Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone).toPlainDate().toString();
}

export function tripClock(model: TodayModel, now: number) {
  const today = model.days.find((day) => day.timeZone && localDate(now, day.timeZone) === day.date);
  if (today) return { phase: "during" as const, today, daysUntil: 0 };
  const first = model.days[0];
  const last = model.days.at(-1);
  if (first?.timeZone && localDate(now, first.timeZone) < first.date) {
    return { phase: "before" as const, today: null, daysUntil: Temporal.PlainDate.from(localDate(now, first.timeZone)).until(first.date).days };
  }
  if (last?.timeZone && localDate(now, last.timeZone) > last.date) return { phase: "after" as const, today: null, daysUntil: 0 };
  return { phase: "unknown" as const, today: null, daysUntil: 0 };
}

export function dayItems(model: TodayModel, day: TodayDay) {
  const ids = new Set(day.itemIds);
  return model.items.filter((item) => ids.has(item.id)).sort((a, b) =>
    (a.start ? Date.parse(a.start) : Infinity) - (b.start ? Date.parse(b.start) : Infinity) || a.id.localeCompare(b.id));
}

export function personalState(items: TodayItem[], memberId: string, now: number) {
  const personal = items.filter((item) => item.participants?.some((person) => person.id === memberId));
  const current = personal.filter((item) => item.start && item.end && Date.parse(item.start) <= now && now < Date.parse(item.end));
  const next = personal.filter((item) => item.start && Date.parse(item.start) > now)
    .sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!) || a.id.localeCompare(b.id))[0] ?? null;
  const pending = personal.some((item) => !item.start || !item.end);
  return { current, next, minutesUntil: next ? Math.ceil((Date.parse(next.start!) - now) / 60_000) : null,
    phase: personal.length === 0 ? "empty" as const : current.length ? "current" as const : next ? "between" as const : pending ? "unconfirmed" as const : "done" as const };
}

export function parallelItemIds(items: TodayItem[]) {
  const result = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!;
    if (!a.start || !a.end) continue;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j]!;
      if (b.start && b.end && Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end)) {
        result.add(a.id); result.add(b.id);
      }
    }
  }
  return result;
}
