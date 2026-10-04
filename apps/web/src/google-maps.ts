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
