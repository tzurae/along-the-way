import type { TripFlightInput } from "@along-the-way/contracts/private-trips";
import type {
  ConstraintInput,
  CreateItineraryItemInput,
  CreatePlaceInput,
  ItineraryItemDto,
  PlaceDto,
  TripSkeletonDto,
  TripLodgingInput,
  UpdateItineraryItemInput,
  UpdatePlaceInput,
} from "@along-the-way/contracts/trip-skeleton";

export interface TripSkeletonModule {
  getSkeleton(userId: string, tripId: string): Promise<TripSkeletonDto>;
  createFlight(userId: string, tripId: string, idempotencyKey: string, expectedTripVersion: number, input: TripFlightInput): Promise<ItineraryItemDto>;
  updateFlight(userId: string, tripId: string, itemId: string, idempotencyKey: string, expectedVersion: number, input: TripFlightInput): Promise<ItineraryItemDto>;
  createLodging(userId: string, tripId: string, idempotencyKey: string, expectedTripVersion: number, input: TripLodgingInput): Promise<ItineraryItemDto>;
  updateLodging(userId: string, tripId: string, itemId: string, idempotencyKey: string, expectedVersion: number, input: TripLodgingInput): Promise<ItineraryItemDto>;
  createPlace(
    userId: string,
    tripId: string,
    idempotencyKey: string,
    expectedTripVersion: number,
    input: CreatePlaceInput,
  ): Promise<PlaceDto>;
  updatePlace(
    userId: string,
    tripId: string,
    placeId: string,
    idempotencyKey: string,
    input: UpdatePlaceInput,
  ): Promise<PlaceDto>;
  deletePlace(
    userId: string,
    tripId: string,
    placeId: string,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<void>;
  createItem(
    userId: string,
    tripId: string,
    idempotencyKey: string,
    expectedTripVersion: number,
    input: CreateItineraryItemInput,
  ): Promise<ItineraryItemDto>;
  updateItem(
    userId: string,
    tripId: string,
    itemId: string,
    idempotencyKey: string,
    input: UpdateItineraryItemInput,
  ): Promise<ItineraryItemDto>;
  deleteItem(
    userId: string,
    tripId: string,
    itemId: string,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<void>;
  lockItem(
    userId: string,
    tripId: string,
    itemId: string,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<ItineraryItemDto>;
  unlockItem(
    userId: string,
    tripId: string,
    itemId: string,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<ItineraryItemDto>;
  createConstraint(
    userId: string,
    tripId: string,
    itemId: string,
    idempotencyKey: string,
    expectedItemVersion: number,
    input: ConstraintInput,
  ): Promise<ItineraryItemDto>;
  updateConstraint(
    userId: string,
    tripId: string,
    itemId: string,
    constraintId: string,
    idempotencyKey: string,
    expectedItemVersion: number,
    expectedVersion: number,
    input: ConstraintInput,
  ): Promise<ItineraryItemDto>;
  deleteConstraint(
    userId: string,
    tripId: string,
    itemId: string,
    constraintId: string,
    idempotencyKey: string,
    expectedItemVersion: number,
    expectedVersion: number,
  ): Promise<ItineraryItemDto>;
}
