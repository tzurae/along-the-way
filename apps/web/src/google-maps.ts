/**
 * Opens the place's own Google Maps page (photos, reviews, hours) through a documented
 * Maps URL. Following the link is free: it is not a Places API request.
 */
export function googleMapsPlaceUrl(name: string, providerPlaceId: string) {
  const url = new URL("https://www.google.com/maps/search/");
  url.searchParams.set("api", "1");
  url.searchParams.set("query", name);
  url.searchParams.set("query_place_id", providerPlaceId);
  return url.toString();
}

/** Coordinates are required; a name or an unverified address alone must not guess a destination. */
export function googleMapsCoordinatesUrl(destination: { latitude: number | null; longitude: number | null }, origin?: { latitude: number | null; longitude: number | null }) {
  if (destination.latitude === null || destination.longitude === null || !Number.isFinite(destination.latitude) || !Number.isFinite(destination.longitude) || Math.abs(destination.latitude) > 90 || Math.abs(destination.longitude) > 180) return null;
  if (origin && (origin.latitude === null || origin.longitude === null || !Number.isFinite(origin.latitude) || !Number.isFinite(origin.longitude) || Math.abs(origin.latitude) > 90 || Math.abs(origin.longitude) > 180)) return null;
  const url = new URL(origin ? "https://www.google.com/maps/dir/" : "https://www.google.com/maps/search/");
  url.searchParams.set("api", "1");
  url.searchParams.set(origin ? "destination" : "query", `${destination.latitude},${destination.longitude}`);
  if (origin) url.searchParams.set("origin", `${origin.latitude},${origin.longitude}`);
  return url.toString();
}
