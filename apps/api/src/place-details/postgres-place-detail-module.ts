import { sql, type Kysely } from "kysely";
import {
  parseCuratedPhoto,
  parseCuratedPlaceManifest,
  parsePlaceDetailDate,
  parsePlaceDetailReference,
  parsePlacePreviewIds,
  type CuratedPhotoInput,
  type GooglePlacePhotoDto,
  type PlaceDetailDto,
  type PlaceDetailReference,
  type PlaceDetailReferenceKind,
  type PlacePhotoDto,
  type PlacePreviewDto,
} from "@along-the-way/contracts/place-details";
import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "../private-trips/private-trip-module";
import {
  googlePlacePhotoDto,
  PlacePhotoNotFoundError,
  type PlaceProvider,
} from "../trip-places/google-places-provider";
import { GooglePhotoCapability } from "../trip-places/google-photo-capability";
import type { PlaceDetailModule, PlaceDetailReadResult, PlacePreviewReadResult } from "./place-detail-module";
import { readPackagedPhoto } from "./photo-assets";

interface ResolvedPlace {
  id: string;
  name: string;
  canonicalPlaceId: string | null;
  providerPlaceId: string | null;
}

interface GooglePhotoReadResult {
  photos: GooglePlacePhotoDto[];
  failed: boolean;
}


export class PostgresPlaceDetailModule implements PlaceDetailModule {
  private readonly database: Kysely<AlongTheWayDatabase>;
  private readonly assetRoot: string;
  private readonly provider: PlaceProvider | undefined;
  private readonly now: () => Date;
  private readonly photoCapability: GooglePhotoCapability | undefined;

  constructor(options: {
    database: Kysely<AlongTheWayDatabase>;
    assetRoot: string;
    provider?: PlaceProvider;
    now?: () => Date;
    photoCapabilitySecret?: string;
  }) {
    this.database = options.database;
    this.assetRoot = options.assetRoot;
    this.provider = options.provider;
    this.now = options.now ?? (() => new Date());
    this.photoCapability = options.photoCapabilitySecret
      ? new GooglePhotoCapability(options.photoCapabilitySecret, this.now)
      : undefined;
  }

  async getDetail(userId: string, tripId: string, reference: PlaceDetailReference, date: string | null, includeGooglePhoto = true): Promise<PlaceDetailReadResult> {
    await this.authorize(userId, tripId);
    this.validateRequest(reference, date);
    const [place] = await this.resolve(tripId, reference.kind, [reference.id]);
    const empty: PlaceDetailDto = {
      reference,
      canonicalPlaceId: place!.canonicalPlaceId,
      name: place!.name,
      asOfDate: date,
      sections: [], sources: [], photos: [], googlePhotos: [], photosUnavailable: false,
    };
    const content = place!.canonicalPlaceId
      ? await this.database.selectFrom("curated_place_details").selectAll()
          .select(sql<unknown>`coalesce((
            select jsonb_agg(photo.metadata order by photo.position)
            from (
              select candidate.metadata, candidate.position
              from curated_place_photos candidate
              where candidate.place_id = curated_place_details.place_id
              order by candidate.position
              limit 3
            ) photo
          ), '[]'::jsonb)`.as("photos"))
          .where("place_id", "=", place!.canonicalPlaceId).executeTakeFirst()
      : undefined;
    if (!content) {
      const google = includeGooglePhoto && place!.providerPlaceId !== null
        ? await this.googlePhotos(userId, tripId, place!.providerPlaceId)
        : { photos: [], failed: !includeGooglePhoto && place!.providerPlaceId !== null };
      const commons = google.photos.length === 0 && place!.canonicalPlaceId
        ? (await this.commonsPhotos([place!.canonicalPlaceId])).get(place!.canonicalPlaceId)
        : undefined;
      const photos = commons
        ? [this.photoDto(tripId, reference, commons, "commons")]
        : [];
      return {
        googleFallbackFailed: google.failed,
        detail: {
          ...empty,
          photos,
          googlePhotos: google.photos,
          photosUnavailable: google.failed && photos.length === 0,
        },
      };
    }
    // Validate stored content too: malformed data is an error, never a false empty state.
    const curated = parseCuratedPlaceManifest({ version: 1, places: [{
      key: content.manifest_key, name: content.name, sections: content.sections,
      sources: content.sources, photos: content.photos,
    }] }).places[0]!;
    const observedNow = this.now().getTime();
    const staleIds = new Set(curated.sources.filter((source) =>
      (source.expiresAt !== null && Date.parse(source.expiresAt) <= observedNow)
      || (date !== null && source.validFrom !== null && date < source.validFrom)
      || (date !== null && source.validUntil !== null && date > source.validUntil),
    ).map((source) => source.id));
    const google = includeGooglePhoto && place!.providerPlaceId !== null
      ? await this.googlePhotos(userId, tripId, place!.providerPlaceId)
      : { photos: [], failed: !includeGooglePhoto && place!.providerPlaceId !== null };
    const curatedPhotos = google.photos.length === 0
      ? curated.photos.map((photo) => this.photoDto(tripId, reference, photo, "curated"))
      : [];
    const commons = curatedPhotos.length === 0 && google.photos.length === 0
      ? (await this.commonsPhotos([place!.canonicalPlaceId!])).get(place!.canonicalPlaceId!)
      : undefined;
    const photos = commons ? [this.photoDto(tripId, reference, commons, "commons")] : curatedPhotos;
    return {
      googleFallbackFailed: google.failed,
      detail: {
        ...empty,
        sources: curated.sources,
        sections: curated.sections.map((section) => ({ ...section, blocks: section.blocks.map((block) => ({
          ...block, needsRecheck: block.sourceIds.some((id) => staleIds.has(id)),
        })) })),
        photos,
        googlePhotos: google.photos,
        photosUnavailable: google.failed && photos.length === 0,
      },
    };
  }

  async getPreviews(userId: string, tripId: string, kind: PlaceDetailReferenceKind, ids: string[]): Promise<PlacePreviewReadResult> {
    await this.authorize(userId, tripId);
    try {
      parsePlacePreviewIds(ids.join(","));
      parsePlaceDetailReference({ kind, id: ids[0] });
    } catch {
      throw new AppError("validation_error", "Invalid place preview references");
    }
    const places = await this.resolve(tripId, kind, ids);
    const canonicalIds = [...new Set(places.flatMap((place) => place.canonicalPlaceId ? [place.canonicalPlaceId] : []))];
    // The database returns only the first metadata row plus a capped count per
    // place, rather than hydrating every curated photo DTO.
    const photos = canonicalIds.length === 0 ? [] : await this.database.selectFrom("curated_place_photos")
      .distinctOn("place_id")
      .select(["place_id", "metadata"])
      .select(sql<number>`least(count(*) over (partition by place_id), 3)::integer`.as("photo_count"))
      .where("place_id", "in", canonicalIds)
      .orderBy("place_id")
      .orderBy("position")
      .execute();
    const byPlace = new Map(photos.map((row) => [row.place_id, {
      photo: parseCuratedPhoto(row.metadata),
      photoCount: row.photo_count,
    }]));
    const commonsByPlace = await this.commonsPhotos(canonicalIds.filter((id) => !byPlace.has(id)));
    const previews = places.map((place) => {
      const reference = { kind, id: place.id };
      const curated = place.canonicalPlaceId ? byPlace.get(place.canonicalPlaceId) : undefined;
      if (curated) return {
        reference,
        photo: this.photoDto(tripId, reference, curated.photo, "curated"),
        photoCount: curated.photoCount,
      };
      const commons = place.canonicalPlaceId ? commonsByPlace.get(place.canonicalPlaceId) : undefined;
      if (commons) return { reference, photo: this.photoDto(tripId, reference, commons, "commons"), photoCount: 1 };
      return { reference, photo: null, photoCount: 0 };
    });
    return { previews };
  }

  async getPhotoAsset(userId: string, tripId: string, reference: PlaceDetailReference, filename: string) {
    await this.authorize(userId, tripId);
    this.validateRequest(reference, null);
    if (!/^[a-f0-9]{64}\.(jpg|png|webp)$/.test(filename)) throw new AppError("validation_error", "Invalid photo filename");
    const [place] = await this.resolve(tripId, reference.kind, [reference.id]);
    if (!place!.canonicalPlaceId) throw new AppError("place_not_found", "Photo not found", 404);
    const row = await this.database.selectFrom("curated_place_photos").select("metadata")
      .where("place_id", "=", place!.canonicalPlaceId)
      .where((eb) => eb.or([eb("image_filename", "=", filename), eb("thumbnail_filename", "=", filename)]))
      .executeTakeFirst();
    if (!row) return this.commonsPhotoAsset(place!.canonicalPlaceId, filename);
    const photo = parseCuratedPhoto(row.metadata);
    const asset = photo.image.filename === filename ? photo.image : photo.thumbnail;
    try {
      const bytes = await readPackagedPhoto(this.assetRoot, asset.filename);
      return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), mediaType: asset.mediaType };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") throw new AppError("place_not_found", "Photo not found", 404);
      throw error;
    }
  }

  /** Stored bytes of a Commons representative photo; the filename must belong to this place's own photo. */
  private async commonsPhotoAsset(placeId: string, filename: string) {
    const owned = await this.database.selectFrom("commons_place_photos").select("place_id")
      .where("place_id", "=", placeId)
      .where((eb) => eb.or([eb("image_filename", "=", filename), eb("thumbnail_filename", "=", filename)]))
      .executeTakeFirst();
    const blob = owned
      ? await this.database.selectFrom("place_photo_blobs").select(["bytes", "media_type"]).where("filename", "=", filename).executeTakeFirst()
      : undefined;
    if (!blob) throw new AppError("place_not_found", "Photo not found", 404);
    return { bytes: new Uint8Array(blob.bytes), mediaType: blob.media_type };
  }

  async getGooglePhoto(
    userId: string,
    tripId: string,
    providerPlaceId: string,
    index: 0 | 1 | 2,
    photoFingerprint: string,
    photoResource: string,
    maxWidth: 192 | 1024,
    capabilityExpiry: string | null = null,
    capabilitySignature: string | null = null,
  ) {
    await this.authorize(userId, tripId);
    if (!/^[A-Za-z0-9_-]{8,300}$/.test(providerPlaceId)
      || !/^[a-f0-9]{16}$/.test(photoFingerprint)
      || !/^[A-Za-z0-9_-]{1,1000}$/.test(photoResource)
      || (maxWidth !== 192 && maxWidth !== 1024)) {
      throw new AppError("validation_error", "Invalid Google place photo request");
    }
    const photoName = `places/${providerPlaceId}/photos/${photoResource}`;
    if (!this.photoCapability?.matches(
      tripId,
      userId,
      providerPlaceId,
      index,
      photoFingerprint,
      photoName,
      capabilityExpiry,
      capabilitySignature,
    )) {
      throw new AppError("place_photo_not_found", "Place photo not found", 404);
    }
    if (!this.provider
      || this.provider.available === false
      || !this.provider.fetchPhotoMedia) {
      throw new AppError("place_photo_not_found", "Place photo not found", 404);
    }
    try {
      const media = await this.provider.fetchPhotoMedia(photoName, maxWidth);
      return { bytes: media.bytes, mediaType: media.contentType };
    } catch (error) {
      if (error instanceof PlacePhotoNotFoundError) {
        throw new AppError("place_photo_not_found", "Place photo not found", 404);
      }
      throw new AppError("place_photo_unavailable", "Place photo is temporarily unavailable", 502);
    }
  }

  private async authorize(userId: string, tripId: string) {
    const member = await this.database.selectFrom("trip_members").select("user_id")
      .where("trip_id", "=", tripId).where("user_id", "=", userId).where("removed_at", "is", null).executeTakeFirst();
    if (!member) throw new AppError("trip_not_found", "Trip not found", 404);
  }

  private validateRequest(reference: PlaceDetailReference, date: string | null) {
    try {
      parsePlaceDetailReference(reference);
      if (date !== null) parsePlaceDetailDate(date);
    } catch {
      throw new AppError("validation_error", "Invalid place detail reference or date");
    }
  }

  private async resolve(tripId: string, kind: PlaceDetailReferenceKind, ids: string[]): Promise<ResolvedPlace[]> {
    let places: ResolvedPlace[];
    if (kind === "trip-place") {
      places = await this.database.selectFrom("trip_places as tripPlace")
        .innerJoin("place_identities as identity", "identity.id", "tripPlace.place_id")
        .select([
          "tripPlace.id", "tripPlace.name", "tripPlace.place_id as canonicalPlaceId",
          "identity.provider_place_id as providerPlaceId",
        ])
        .where("tripPlace.trip_id", "=", tripId).where("tripPlace.id", "in", ids)
        .where("tripPlace.archived_at", "is", null).execute();
    } else if (kind === "itinerary-place") {
      places = await this.database.selectFrom("places as legacy")
        .leftJoin("trip_places as tripPlace", (join) => join.onRef("tripPlace.legacy_place_id", "=", "legacy.id")
          .onRef("tripPlace.trip_id", "=", "legacy.trip_id"))
        .leftJoin("place_identities as identity", "identity.id", "tripPlace.place_id")
        .select([
          "legacy.id", "legacy.name", "tripPlace.place_id as canonicalPlaceId",
          "identity.provider_place_id as providerPlaceId",
        ])
        .where("legacy.trip_id", "=", tripId).where("legacy.id", "in", ids).execute();
    } else {
      places = await this.database.selectFrom("candidate_proposals as proposal")
        .leftJoin("trip_places as accepted", (join) => join.onRef("accepted.id", "=", "proposal.accepted_trip_place_id")
          .onRef("accepted.trip_id", "=", "proposal.trip_id"))
        .leftJoin("place_identities as identity", (join) => join.on("identity.provider", "=", "google")
          .onRef("identity.provider_place_id", "=", "proposal.provider_place_id"))
        .select([
          "proposal.id", "proposal.name",
          sql<string | null>`coalesce(accepted.place_id, identity.id)`.as("canonicalPlaceId"),
          "proposal.provider_place_id as providerPlaceId",
        ])
        .where("proposal.trip_id", "=", tripId).where("proposal.id", "in", ids).execute();
    }
    const byId = new Map(places.map((place) => [place.id, place]));
    return ids.map((id) => {
      const place = byId.get(id);
      if (!place) throw new AppError("place_not_found", "Place not found", 404);
      return place;
    });
  }

  private async googlePhotos(userId: string, tripId: string, providerPlaceId: string | null): Promise<GooglePhotoReadResult> {
    if (!providerPlaceId) return { photos: [], failed: false };
    const photoCapability = this.photoCapability;
    if (!this.provider?.getPhotos || !this.provider.fetchPhotoMedia
      || this.provider.available === false || !photoCapability) {
      return { photos: [], failed: true };
    }
    try {
      // Owner decision 2026-10-18: the detail gallery shows at most two Google photos.
      const photos = (await this.provider.getPhotos(providerPlaceId)).slice(0, 2);
      return {
        photos: photos.map((photo, index) =>
          googlePlacePhotoDto(
            tripId,
            providerPlaceId,
            index as 0 | 1 | 2,
            photo,
            (fingerprint) => photoCapability.issue(
              tripId, userId, providerPlaceId, index as 0 | 1 | 2, fingerprint, photo.name,
            ),
          )),
        failed: false,
      };
    } catch {
      return { photos: [], failed: true };
    }
  }

  /** Commons representative photos per canonical place; parsed so malformed stored data fails loudly. */
  private async commonsPhotos(placeIds: string[]): Promise<Map<string, CuratedPhotoInput>> {
    if (placeIds.length === 0) return new Map();
    const rows = await this.database.selectFrom("commons_place_photos").select(["place_id", "metadata"])
      .where("place_id", "in", placeIds).execute();
    return new Map(rows.map((row) => [row.place_id, parseCuratedPhoto(row.metadata)]));
  }

  private photoDto(tripId: string, reference: PlaceDetailReference, photo: CuratedPhotoInput, source: PlacePhotoDto["source"]): PlacePhotoDto {
    const { image, thumbnail, ...metadata } = photo;
    const suffix = `?kind=${reference.kind}&id=${reference.id}`;
    const prefix = `/api/trips/${tripId}/place-photo-assets/`;
    return { source, ...metadata, imageUrl: prefix + image.filename + suffix, thumbnailUrl: prefix + thumbnail.filename + suffix,
      width: image.width, height: image.height };
  }
}
