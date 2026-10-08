export const tripTabIds = ["today", "itinerary", "places", "members"] as const;
export type TripTab = (typeof tripTabIds)[number];

export const itinerarySegmentIds = ["daily", "flight", "lodging"] as const;
export type ItinerarySegment = (typeof itinerarySegmentIds)[number];
export const placesSegmentIds = ["wishlist", "discovery"] as const;
export type PlacesSegment = (typeof placesSegmentIds)[number];
export type TripSegment = ItinerarySegment | PlacesSegment;

const legacyLocations: Record<string, { tab: TripTab; segment: TripSegment | null }> = {
  overview: { tab: "itinerary", segment: "flight" },
  discovery: { tab: "places", segment: "discovery" },
  wishlist: { tab: "places", segment: "wishlist" },
  lodging: { tab: "itinerary", segment: "lodging" },
  recent: { tab: "members", segment: null },
};

export function defaultSegment(tab: TripTab): TripSegment | null {
  if (tab === "itinerary") return "daily";
  if (tab === "places") return "wishlist";
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
  return {
    trip: query.get("trip"),
    day: query.get("day"),
    tab,
    segment,
    needsReplace: Boolean(legacy) || (tab !== null && rawTab !== tab)
      || (tab !== null && rawSegment !== segment),
  };
}

export function writeTripLocation(
  trip: string,
  tab: TripTab,
  segment: TripSegment | null,
  day: string | null,
  replace = false,
) {
  const url = new URL(window.location.href);
  url.searchParams.set("trip", trip);
  url.searchParams.set("tab", tab);
  const normalizedSegment = tab === "itinerary"
    ? (itinerarySegmentIds.includes(segment as ItinerarySegment) ? segment : "daily")
    : tab === "places"
      ? (placesSegmentIds.includes(segment as PlacesSegment) ? segment : "wishlist")
      : null;
  if (normalizedSegment) url.searchParams.set("segment", normalizedSegment);
  else url.searchParams.delete("segment");
  if (day) url.searchParams.set("day", day); else url.searchParams.delete("day");
  if (url.href !== window.location.href) window.history[replace ? "replaceState" : "pushState"]({}, "", url);
}
