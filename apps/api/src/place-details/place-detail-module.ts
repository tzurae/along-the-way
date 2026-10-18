import type {
  PlaceDetailDto,
  PlaceDetailReference,
  PlaceDetailReferenceKind,
  PlacePreviewDto,
} from "@along-the-way/contracts/place-details";

export interface PlaceDetailReadResult {
  detail: PlaceDetailDto;
}

export interface PlacePreviewReadResult {
  previews: PlacePreviewDto[];
}

/** All reads authorize membership before resolving a trip-scoped reference; none mutate trip data. */
export interface PlaceDetailModule {
  getDetail(userId: string, tripId: string, reference: PlaceDetailReference, date: string | null, includeGooglePhoto?: boolean): Promise<PlaceDetailReadResult>;
  getPreviews(userId: string, tripId: string, kind: PlaceDetailReferenceKind, ids: string[]): Promise<PlacePreviewReadResult>;
  getPhotoAsset(userId: string, tripId: string, reference: PlaceDetailReference, filename: string): Promise<{
    bytes: Uint8Array<ArrayBuffer>;
    mediaType: "image/jpeg" | "image/png" | "image/webp";
  }>;
  getGooglePhoto(
    userId: string,
    tripId: string,
    providerPlaceId: string,
    index: 0 | 1 | 2,
    photoFingerprint: string,
    photoResource: string,
    maxWidth: 192 | 1024,
    capabilityExpiry?: string | null,
    capabilitySignature?: string | null,
  ): Promise<{ bytes: Uint8Array<ArrayBuffer>; mediaType: string }>;
}
