import type {
  CreateTripPlaceInput,
  MergeTripPlacesInput,
  NearbyAlternativesResponse,
  ProviderCandidatesResponse,
  RemoveTripPlaceInput,
  MustItemKind,
  TripPlaceDto,
  TripPlaceMustItemDto,
  UpdateMemberVoteInput,
  UpdateTripPlaceDayAssignmentsInput,
  UpdateTripPlacePlanningInput,
} from "@along-the-way/contracts/trip-places";
import type { KeepTripPlaceInput, PlaceKeepDto } from "@along-the-way/contracts/place-keeps";

export interface TripPlaceModule {
  list(userId: string, tripId: string): Promise<TripPlaceDto[]>;
  nearbyAlternatives(
    userId: string,
    tripId: string,
    dayId: string,
    tripPlaceId: string,
  ): Promise<NearbyAlternativesResponse>;
  replaceStop(
    userId: string,
    tripId: string,
    dayId: string,
    tripPlaceId: string,
    idempotencyKey: string,
    input: { expectedDayVersion: number; providerPlaceId: string },
  ): Promise<TripPlaceDto[]>;
  undoStopReplacement(
    userId: string,
    tripId: string,
    replacementId: string,
    idempotencyKey: string,
  ): Promise<TripPlaceDto[]>;
  search(
    userId: string,
    tripId: string,
    query: string,
  ): Promise<ProviderCandidatesResponse>;
  resolveUrl(
    userId: string,
    tripId: string,
    url: string,
  ): Promise<ProviderCandidatesResponse>;
  add(
    userId: string,
    tripId: string,
    idempotencyKey: string,
    input: CreateTripPlaceInput,
  ): Promise<TripPlaceDto>;
  listMustItems(
    userId: string,
    tripId: string,
    tripPlaceId: string,
  ): Promise<TripPlaceMustItemDto[]>;
  createMustItem(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    idempotencyKey: string,
    input: { kind: MustItemKind; label: string },
  ): Promise<TripPlaceMustItemDto>;
  updateMustItem(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    itemId: string,
    idempotencyKey: string,
    input: { kind: MustItemKind; label: string; expectedVersion: number },
  ): Promise<TripPlaceMustItemDto>;
  removeMustItem(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    itemId: string,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<void>;
  updatePlanning(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    idempotencyKey: string,
    input: UpdateTripPlacePlanningInput,
  ): Promise<TripPlaceDto>;
  updateDayAssignments(
    userId: string,
    tripId: string,
    idempotencyKey: string,
    input: UpdateTripPlaceDayAssignmentsInput,
  ): Promise<TripPlaceDto[]>;
  /** Saves the route dialog's complete candidate list atomically. */
  arrangeDay(
    userId: string,
    tripId: string,
    dayId: string,
    idempotencyKey: string,
    input: { expectedVersion: number; orderedTripPlaceIds: string[] },
  ): Promise<TripPlaceDto[]>;
  setOwnVote(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    idempotencyKey: string,
    input: UpdateMemberVoteInput,
  ): Promise<TripPlaceDto>;
  merge(
    userId: string,
    tripId: string,
    sourceTripPlaceId: string,
    idempotencyKey: string,
    input: MergeTripPlacesInput,
  ): Promise<TripPlaceDto>;
  keepSeparate(
    userId: string,
    tripId: string,
    suggestionId: string,
    idempotencyKey: string,
  ): Promise<void>;
  listKeeps(userId: string, tripId: string): Promise<PlaceKeepDto[]>;
  keep(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    idempotencyKey: string,
    input: KeepTripPlaceInput,
  ): Promise<PlaceKeepDto>;
  unkeep(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    idempotencyKey: string,
  ): Promise<void>;
  remove(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    idempotencyKey: string,
    input: RemoveTripPlaceInput,
  ): Promise<void>;
}
