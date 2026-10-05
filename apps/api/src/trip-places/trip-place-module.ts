import type { ApplyTripPlanInput } from "@along-the-way/contracts/day-plans";
import type {
  CreateTripPlaceInput,
  MergeTripPlacesInput,
  ProviderCandidatesResponse,
  ProviderPlaceCandidateDto,
  TripPlaceDto,
  UpdateMemberVoteInput,
  UpdateTripPlaceDayAssignmentsInput,
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
  updateDayAssignments(
    userId: string,
    tripId: string,
    idempotencyKey: string,
    input: UpdateTripPlaceDayAssignmentsInput,
  ): Promise<TripPlaceDto[]>;
  /** Uses a trip plan: adds its new places to their days and keeps each day's order. */
  addPlacesToDays(
    userId: string,
    tripId: string,
    idempotencyKey: string,
    input: ApplyTripPlanInput,
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
  withdrawContribution(
    userId: string,
    tripId: string,
    tripPlaceId: string,
    contributionId: string,
    idempotencyKey: string,
  ): Promise<TripPlaceDto | null>;
}
