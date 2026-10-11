import type { TripDto } from "@along-the-way/contracts/private-trips";
import type { TripSkeletonDto, ItineraryItemDto } from "@along-the-way/contracts/trip-skeleton";
import type { TripPlaceDto } from "@along-the-way/contracts/trip-places";

export const todayUser = { id: "account", email: "owner@example.test", displayName: null };
export function todayTrip(id = "A", month = "10"): TripDto {
  return { id, name: `Trip ${id}`, startDate: `2026-${month}-21`, endDate: `2026-${month}-23`, defaultCurrency: "JPY",
    countryStops: [{ id: "stop", countryCode: "JP", position: 0, timeZone: "Asia/Tokyo" }],
    days: [21, 22, 23].map((day) => ({ id: `day${day}`, date: `2026-${month}-${day}`, title: null })),
    members: [{ id: "member", userId: todayUser.id, email: todayUser.email, displayName: null, role: "owner" }],
    invites: [], memberCount: 1, dayCount: 3, role: "owner", version: 7 };
}
export function todayActivity(id = "activity"): ItineraryItemDto {
  return { id, tripId: "A", title: id, type: "activity", notes: null, sourceUrl: null, money: null, lockedAt: null, lockedBy: null, version: 1,
    endpoints: [{ role: "start", countryStopId: "stop", placeId: "place", localDateTime: "2026-10-21T10:00", timeZone: "Asia/Tokyo", utcOffset: "+09:00", instant: "2026-10-21T01:00:00Z" }],
    constraints: [], participants: [{ memberId: "member", displayName: null, email: todayUser.email, removed: false }],
    details: { durationMinutes: 60, bookedBy: null, confirmationStatus: null } };
}
export function todaySkeleton(trip = todayTrip(), items: ItineraryItemDto[] = []): TripSkeletonDto {
  return { tripVersion: trip.version,
    places: [{ id: "place", tripId: trip.id, name: "Park", type: "activity", address: null, latitude: 34, longitude: 135, timeZone: "Asia/Tokyo", sourceUrl: null, notes: null, locationStatus: "complete", version: 1 }],
    items, days: trip.days.map((day, index) => ({ id: day.id, date: day.date, entries: index === 0 ? items.map((item) => ({ itemId: item.id, projection: "full", sortInstant: item.endpoints[0]!.instant })) : [] })),
    tripInformationItemIds: [] };
}
export function todayWishlist(saved = false): TripPlaceDto[] {
  return ["FIRST", "SECOND"].map((name, index) => ({ id: name, tripId: "A", placeId: `canonical-${name}`, provider: "manual", aiProposalId: null,
    providerPlaceId: null, providerObservedAt: null, providerExpiresAt: null, providerAttribution: null, factsSource: "member", providerFactsExpired: false,
    name, type: "activity", address: null, latitude: 34 + index, longitude: 135, timeZone: index === 0 ? "Asia/Tokyo" : "Europe/Paris",
    status: "ready", scheduled: false, selectedForItinerary: true, unplacedFromDate: null, durationMinutes: 60, assignedDayId: "day21", dayPosition: saved ? 1 - index : index,
    budgetAmountMinor: null, budgetCurrency: null, notes: null, sourceUrl: null, voters: [], voteCount: 0, ownVote: false, votingAvailable: false, duplicateSuggestions: [], version: 1 }));
}
