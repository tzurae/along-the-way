import type {
  CreateTripPlaceInput,
  MergeTripPlacesInput,
  ProviderCandidatesResponse,
  ProviderPlaceCandidateDto,
  TripPlaceDto,
  UpdateMemberPreferenceInput,
  UpdateTripPlacePlanningInput,
} from "@along-the-way/contracts/trip-places";

export interface TripPlaceModule {
  list(userId: string, tripId: string): Promise<TripPlaceDto[]>;
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
  addObservedCandidate(
    userId: string,
    tripId: string,
    idempotencyKey: string,
    candidate: ProviderPlaceCandidateDto,
  ): Promise<TripPlaceDto>;
  updatePlanning(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    idempotencyKey: string,
    input: UpdateTripPlacePlanningInput,
  ): Promise<TripPlaceDto>;
  setOwnPreference(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    idempotencyKey: string,
    input: UpdateMemberPreferenceInput,
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
  withdrawContribution(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    contributionId: string,
    idempotencyKey: string,
  ): Promise<TripPlaceDto | null>;
}
