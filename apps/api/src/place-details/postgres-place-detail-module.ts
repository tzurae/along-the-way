import { sql, type Kysely } from "kysely";
import {
  parseCuratedPhoto,
  parseCuratedPlaceManifest,
  parsePlaceDetailDate,
  parsePlaceDetailReference,
  parsePlacePreviewIds,
  type CuratedPhotoInput,
  type PlaceDetailDto,
  type PlaceDetailReference,
  type PlaceDetailReferenceKind,
  type PlacePhotoDto,
  type PlacePreviewDto,
} from "@along-the-way/contracts/place-details";
import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "../private-trips/private-trip-module";
import type { PlaceDetailModule } from "./place-detail-module";
import { readPackagedPhoto } from "./photo-assets";

interface ResolvedPlace {
  id: string;
  name: string;
  canonicalPlaceId: string | null;
}

export class PostgresPlaceDetailModule implements PlaceDetailModule {
  private readonly database: Kysely<AlongTheWayDatabase>;
  private readonly assetRoot: string;
  private readonly now: () => Date;

  constructor(options: { database: Kysely<AlongTheWayDatabase>; assetRoot: string; now?: () => Date }) {
    this.database = options.database;
    this.assetRoot = options.assetRoot;
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
      sections: [], sources: [], photos: [],
    };
    if (!place!.canonicalPlaceId) return empty;
    // One statement observes content and its ordered photos from the same publication.
    const content = await this.database.selectFrom("curated_place_details").selectAll()
      .select(sql<unknown>`coalesce((
        select jsonb_agg(photo.metadata order by photo.position)
        from curated_place_photos photo where photo.place_id = curated_place_details.place_id
      ), '[]'::jsonb)`.as("photos"))
      .where("place_id", "=", place!.canonicalPlaceId).executeTakeFirst();
    if (!content) return empty;
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
    return {
      ...empty,
      sources: curated.sources,
      sections: curated.sections.map((section) => ({ ...section, blocks: section.blocks.map((block) => ({
        ...block, needsRecheck: block.sourceIds.some((id) => staleIds.has(id)),
      })) })),
      photos: curated.photos.map((photo) => this.photoDto(tripId, reference, photo)),
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
    return places.map((place) => {
      const reference = { kind, id: place.id };
      const photo = place.canonicalPlaceId ? byPlace.get(place.canonicalPlaceId) : undefined;
      return { reference, photo: photo ? this.photoDto(tripId, reference, photo) : null };
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
      places = await this.database.selectFrom("trip_places").select(["id", "name", "place_id as canonicalPlaceId"])
        .where("trip_id", "=", tripId).where("id", "in", ids).where("archived_at", "is", null).execute();
    } else if (kind === "itinerary-place") {
      places = await this.database.selectFrom("places as legacy")
        .leftJoin("trip_places as tripPlace", (join) => join.onRef("tripPlace.legacy_place_id", "=", "legacy.id")
          .onRef("tripPlace.trip_id", "=", "legacy.trip_id"))
        .select(["legacy.id", "legacy.name", "tripPlace.place_id as canonicalPlaceId"])
        .where("legacy.trip_id", "=", tripId).where("legacy.id", "in", ids).execute();
    } else {
      places = await this.database.selectFrom("candidate_proposals as proposal")
        .leftJoin("trip_places as accepted", (join) => join.onRef("accepted.id", "=", "proposal.accepted_trip_place_id")
          .onRef("accepted.trip_id", "=", "proposal.trip_id"))
        .leftJoin("place_identities as identity", (join) => join.on("identity.provider", "=", "google")
          .onRef("identity.provider_place_id", "=", "proposal.provider_place_id"))
        .select(["proposal.id", "proposal.name", sql<string | null>`coalesce(accepted.place_id, identity.id)`.as("canonicalPlaceId")])
        .where("proposal.trip_id", "=", tripId).where("proposal.id", "in", ids).execute();
    }
    const byId = new Map(places.map((place) => [place.id, place]));
    return ids.map((id) => {
      const place = byId.get(id);
      if (!place) throw new AppError("place_not_found", "Place not found", 404);
      return place;
    });
  }

  private photoDto(tripId: string, reference: PlaceDetailReference, photo: CuratedPhotoInput): PlacePhotoDto {
    const { image, thumbnail, ...metadata } = photo;
    const suffix = `?kind=${reference.kind}&id=${reference.id}`;
    const prefix = `/api/trips/${tripId}/place-photo-assets/`;
    return { ...metadata, imageUrl: prefix + image.filename + suffix, thumbnailUrl: prefix + thumbnail.filename + suffix,
      width: image.width, height: image.height };
  }
}
