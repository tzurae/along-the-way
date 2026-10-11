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

type Coordinates = { latitude: number | null; longitude: number | null };
function validCoordinates(point: Coordinates) {
  return point.latitude !== null && point.longitude !== null && Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180;
}

/** Coordinates are required; a name or an unverified address alone must not guess a destination. */
export function googleMapsCoordinatesUrl(destination: Coordinates, origin?: Coordinates) {
  if (!validCoordinates(destination) || origin && !validCoordinates(origin)) return null;
  const url = new URL(origin ? "https://www.google.com/maps/dir/" : "https://www.google.com/maps/search/");
  url.searchParams.set("api", "1");
  url.searchParams.set(origin ? "destination" : "query", `${destination.latitude},${destination.longitude}`);
  if (origin) url.searchParams.set("origin", `${origin.latitude},${origin.longitude}`);
  return url.toString();
}

/** Maps supplies the device origin or asks for it; never invent coordinates.
 * https://developers.google.com/maps/documentation/urls/get-started#directions
 */
export function googleMapsNavigationUrl(destination: Coordinates) {
  if (!validCoordinates(destination)) return null;
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("destination", `${destination.latitude},${destination.longitude}`);
  return url.toString();
}
