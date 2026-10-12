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
  googlePlacePhotoFingerprint,
  PlacePhotoNotFoundError,
  type PlaceProvider,
} from "../trip-places/google-places-provider";
import type { PlaceDetailModule } from "./place-detail-module";
import { readPackagedPhoto } from "./photo-assets";

interface ResolvedPlace {
  id: string;
  name: string;
  canonicalPlaceId: string | null;
  providerPlaceId: string | null;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await work(items[index]!, index);
    }
  }));
  return results;
}

export class PostgresPlaceDetailModule implements PlaceDetailModule {
  private readonly database: Kysely<AlongTheWayDatabase>;
  private readonly assetRoot: string;
  private readonly provider: PlaceProvider | undefined;
  private readonly now: () => Date;

  constructor(options: {
    database: Kysely<AlongTheWayDatabase>;
    assetRoot: string;
    provider?: PlaceProvider;
    now?: () => Date;
  }) {
    this.database = options.database;
    this.assetRoot = options.assetRoot;
    this.provider = options.provider;
    this.now = options.now ?? (() => new Date());
  }

  async getDetail(userId: string, tripId: string, reference: PlaceDetailReference, date: string | null): Promise<PlaceDetailDto> {
    await this.authorize(userId, tripId);
    this.validateRequest(reference, date);
    const [place] = await this.resolve(tripId, reference.kind, [reference.id]);
    const empty: PlaceDetailDto = {
      reference,
      canonicalPlaceId: place!.canonicalPlaceId,
      name: place!.name,
      asOfDate: date,
      sections: [], sources: [], photos: [], googlePhoto: null,
    };
    const content = place!.canonicalPlaceId
      ? await this.database.selectFrom("curated_place_details").selectAll()
          .select(sql<unknown>`coalesce((
            select jsonb_agg(photo.metadata order by photo.position)
            from curated_place_photos photo where photo.place_id = curated_place_details.place_id
          ), '[]'::jsonb)`.as("photos"))
          .where("place_id", "=", place!.canonicalPlaceId).executeTakeFirst()
      : undefined;
    if (!content) {
      return { ...empty, googlePhoto: await this.googlePhoto(tripId, place!.providerPlaceId) };
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
    const photos = curated.photos.map((photo) => this.photoDto(tripId, reference, photo));
    return {
      ...empty,
      sources: curated.sources,
      sections: curated.sections.map((section) => ({ ...section, blocks: section.blocks.map((block) => ({
        ...block, needsRecheck: block.sourceIds.some((id) => staleIds.has(id)),
      })) })),
      photos,
      googlePhoto: photos.length === 0 ? await this.googlePhoto(tripId, place!.providerPlaceId) : null,
    };
  }

  async getPreviews(userId: string, tripId: string, kind: PlaceDetailReferenceKind, ids: string[]): Promise<PlacePreviewDto[]> {
    await this.authorize(userId, tripId);
    try {
      parsePlacePreviewIds(ids.join(","));
      parsePlaceDetailReference({ kind, id: ids[0] });
    } catch {
      throw new AppError("validation_error", "Invalid place preview references");
    }
    const places = await this.resolve(tripId, kind, ids);
    const canonicalIds = [...new Set(places.flatMap((place) => place.canonicalPlaceId ? [place.canonicalPlaceId] : []))];
    // One batch of first-photo metadata only, not N full-detail reads or section payloads.
    const photos = canonicalIds.length === 0 ? [] : await this.database.selectFrom("curated_place_photos")
      .select(["place_id", "metadata"]).where("place_id", "in", canonicalIds).where("position", "=", 0).execute();
    const byPlace = new Map(photos.map((row) => [row.place_id, parseCuratedPhoto(row.metadata)]));
    return mapWithConcurrency(places, 4, async (place) => {
      const reference = { kind, id: place.id };
      const curated = place.canonicalPlaceId ? byPlace.get(place.canonicalPlaceId) : undefined;
      return {
        reference,
        photo: curated
          ? this.photoDto(tripId, reference, curated)
          : await this.googlePhoto(tripId, place.providerPlaceId),
      };
    });
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
    if (!row) throw new AppError("place_not_found", "Photo not found", 404);
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

  async getGooglePhoto(
    userId: string,
    tripId: string,
    providerPlaceId: string,
    photoFingerprint: string,
    maxWidth: 192 | 1024,
  ) {
    await this.authorize(userId, tripId);
    if (!/^[A-Za-z0-9_-]{8,300}$/.test(providerPlaceId)
      || !/^[a-f0-9]{16}$/.test(photoFingerprint)
      || (maxWidth !== 192 && maxWidth !== 1024)) {
      throw new AppError("validation_error", "Invalid Google place photo request");
    }
    if (!this.provider
      || this.provider.available === false
      || !this.provider.getFirstPhoto
      || !this.provider.fetchPhotoMedia) {
      throw new AppError("place_photo_not_found", "Place photo not found", 404);
    }
    try {
      const photo = await this.provider.getFirstPhoto(providerPlaceId);
      if (!photo || googlePlacePhotoFingerprint(photo) !== photoFingerprint) {
        throw new PlacePhotoNotFoundError();
      }
      const media = await this.provider.fetchPhotoMedia(photo.name, maxWidth);
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

  private async googlePhoto(tripId: string, providerPlaceId: string | null): Promise<GooglePlacePhotoDto | null> {
    if (!providerPlaceId || !this.provider?.getFirstPhoto || this.provider.available === false) return null;
    try {
      const photo = await this.provider.getFirstPhoto(providerPlaceId);
      return photo ? googlePlacePhotoDto(tripId, providerPlaceId, photo) : null;
    } catch {
      return null;
    }
  }

  private photoDto(tripId: string, reference: PlaceDetailReference, photo: CuratedPhotoInput): PlacePhotoDto {
    const { image, thumbnail, ...metadata } = photo;
    const suffix = `?kind=${reference.kind}&id=${reference.id}`;
    const prefix = `/api/trips/${tripId}/place-photo-assets/`;
    return { source: "curated", ...metadata, imageUrl: prefix + image.filename + suffix, thumbnailUrl: prefix + thumbnail.filename + suffix,
      width: image.width, height: image.height };
  }
}
