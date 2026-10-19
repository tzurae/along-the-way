import type {
  PlaceDetailReference,
  PlaceGuideDto,
} from "@along-the-way/contracts/place-details";

export type ClaimPlaceGuideGeneration = () => Promise<void>;

export interface PlaceGuideModule {
  getGuide(
    userId: string,
    tripId: string,
    reference: PlaceDetailReference,
    claimGeneration: ClaimPlaceGuideGeneration,
  ): Promise<PlaceGuideDto>;
  regenerate(
    placeId: string,
    claimGeneration: ClaimPlaceGuideGeneration,
  ): Promise<PlaceGuideDto>;
}
