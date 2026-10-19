export const tripTabIds = ["today", "itinerary", "places", "members"] as const;
export type TripTab = (typeof tripTabIds)[number];

export const itinerarySegmentIds = ["daily", "flight", "lodging", "settings"] as const;
export type ItinerarySegment = (typeof itinerarySegmentIds)[number];
export const placesSegmentIds = ["wishlist", "discovery"] as const;
export type PlacesSegment = (typeof placesSegmentIds)[number];
/** 成員 sub-pages by responsibility: who is on the trip, your own profile, invitations, permissions. */
export const membersSegmentIds = ["people", "profile", "invites", "permissions"] as const;
export type MembersSegment = (typeof membersSegmentIds)[number];
export type TripSegment = ItinerarySegment | PlacesSegment | MembersSegment;

export interface TripOverviewFilter {
  days: string[];
}

export const TRIP_OVERVIEW_FILTER_CHANGE_EVENT = "trip-overview-filter-change";

function normalizedIsoDates(dates: Iterable<string>) {
  return [...new Set(dates)]
    .filter((date) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
      const instant = new Date(`${date}T00:00:00Z`);
      return !Number.isNaN(instant.valueOf()) && instant.toISOString().slice(0, 10) === date;
    })
    .sort();
}

const legacyLocations: Record<string, { tab: TripTab; segment: TripSegment | null }> = {
  overview: { tab: "itinerary", segment: "flight" },
  discovery: { tab: "places", segment: "discovery" },
  wishlist: { tab: "places", segment: "wishlist" },
  lodging: { tab: "itinerary", segment: "lodging" },
  recent: { tab: "members", segment: "people" },
};

export function defaultSegment(tab: TripTab): TripSegment | null {
  if (tab === "itinerary") return "daily";
  if (tab === "places") return "wishlist";
  if (tab === "members") return "people";
  return null;
}

export function readTripLocation() {
  const query = new URLSearchParams(window.location.search);
  const rawTab = query.get("tab");
  const legacy = rawTab ? legacyLocations[rawTab] : undefined;
  const tab = legacy?.tab ?? (tripTabIds.includes(rawTab as TripTab) ? rawTab as TripTab : null);
  const rawSegment = query.get("segment");
  let segment = legacy?.segment ?? null;
  if (!legacy && tab === "itinerary") {
    segment = itinerarySegmentIds.includes(rawSegment as ItinerarySegment)
      ? rawSegment as ItinerarySegment
      : "daily";
  }
  if (!legacy && tab === "places") {
    segment = placesSegmentIds.includes(rawSegment as PlacesSegment)
      ? rawSegment as PlacesSegment
      : "wishlist";
  }
  if (!legacy && tab === "members") {
    segment = membersSegmentIds.includes(rawSegment as MembersSegment)
      ? rawSegment as MembersSegment
      : "people";
  }
  return {
    trip: query.get("trip"),
    day: query.get("day"),
    tab,
    segment,
    needsReplace: Boolean(legacy) || (tab !== null && rawTab !== tab)
      || (tab !== null && rawSegment !== segment),
  };
}

export function readTripOverviewFilter(): TripOverviewFilter {
  const query = new URLSearchParams(window.location.search);
  return { days: normalizedIsoDates((query.get("days") ?? "").split(",").filter(Boolean)) };
}

export function writeTripOverviewFilter(days: Iterable<string>) {
  const url = new URL(window.location.href);
  const previousDays = url.searchParams.get("days");
  const normalizedDays = normalizedIsoDates(days);
  if (normalizedDays.length > 0) url.searchParams.set("days", normalizedDays.join(","));
  else url.searchParams.delete("days");
  if (url.href !== window.location.href) {
    window.history.replaceState({}, "", url);
    if (url.searchParams.get("days") !== previousDays) {
      window.dispatchEvent(new Event(TRIP_OVERVIEW_FILTER_CHANGE_EVENT));
    }
  }
}

export function writeTripLocation(
  trip: string,
  tab: TripTab,
  segment: TripSegment | null,
  day: string | null,
  replace = false,
) {
  const url = new URL(window.location.href);
  const previousTrip = url.searchParams.get("trip");
  const previousDays = url.searchParams.get("days");
  url.searchParams.set("trip", trip);
  if (previousTrip !== trip) url.searchParams.delete("days");
  url.searchParams.set("tab", tab);
  const normalizedSegment = tab === "itinerary"
    ? (itinerarySegmentIds.includes(segment as ItinerarySegment) ? segment : "daily")
    : tab === "places"
      ? (placesSegmentIds.includes(segment as PlacesSegment) ? segment : "wishlist")
      : tab === "members"
        ? (membersSegmentIds.includes(segment as MembersSegment) ? segment : "people")
        : null;
  if (normalizedSegment) url.searchParams.set("segment", normalizedSegment);
  else url.searchParams.delete("segment");
  if (day) url.searchParams.set("day", day); else url.searchParams.delete("day");
  if (url.href !== window.location.href) {
    window.history[replace ? "replaceState" : "pushState"]({}, "", url);
    if (url.searchParams.get("days") !== previousDays) {
      window.dispatchEvent(new Event(TRIP_OVERVIEW_FILTER_CHANGE_EVENT));
    }
  }
}
