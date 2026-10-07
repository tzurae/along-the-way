export const tripTabIds = ["today", "overview", "discovery", "wishlist", "lodging", "itinerary", "recent"] as const;
export type TripTab = (typeof tripTabIds)[number];

export function readTripLocation() {
  const query = new URLSearchParams(window.location.search);
  const tab = query.get("tab");
  return { trip: query.get("trip"), day: query.get("day"), tab: tripTabIds.includes(tab as TripTab) ? tab as TripTab : null };
}

export function writeTripLocation(trip: string, tab: TripTab, day: string | null, replace = false) {
  const url = new URL(window.location.href);
  url.searchParams.set("trip", trip);
  url.searchParams.set("tab", tab);
  if (day) url.searchParams.set("day", day); else url.searchParams.delete("day");
  if (url.href !== window.location.href) window.history[replace ? "replaceState" : "pushState"]({}, "", url);
}
