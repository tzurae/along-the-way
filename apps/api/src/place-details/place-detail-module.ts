import type {
  PlaceDetailDto,
  PlaceDetailReference,
  PlaceDetailReferenceKind,
  PlacePreviewDto,
} from "@along-the-way/contracts/place-details";

/** All reads authorize membership before resolving a trip-scoped reference; none mutate trip data. */
export interface PlaceDetailModule {
  getDetail(userId: string, tripId: string, reference: PlaceDetailReference, date: string | null): Promise<PlaceDetailDto>;
  getPreviews(userId: string, tripId: string, kind: PlaceDetailReferenceKind, ids: string[]): Promise<PlacePreviewDto[]>;
  getPhotoAsset(userId: string, tripId: string, reference: PlaceDetailReference, filename: string): Promise<{
    bytes: Uint8Array<ArrayBuffer>;
    mediaType: "image/jpeg" | "image/png" | "image/webp";
  }>;
}
