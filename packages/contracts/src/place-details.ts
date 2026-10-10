export type PlaceDetailReferenceKind = "trip-place" | "proposal" | "itinerary-place";

export interface PlaceDetailReference {
  kind: PlaceDetailReferenceKind;
  id: string;
}

export interface PlaceDetailSourceDto {
  id: string;
  title: string;
  url: string;
  checkedAt: string;
  publishedAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  expiresAt: string | null;
}

export type PlaceDetailSectionKind = "intro" | "sights" | "location" | "transport" | "hours" | "fees" | "notices";
export type PlaceDetailCertainty = "sourced" | "unknown" | "conflicted";

export interface PlaceDetailBlockInput {
  text: string;
  style: "paragraph" | "bullet";
  sourceIds: string[];
  certainty: PlaceDetailCertainty;
}

export interface PlaceDetailBlockDto extends PlaceDetailBlockInput {
  needsRecheck: boolean;
}

export interface PlaceDetailSectionInput {
  kind: PlaceDetailSectionKind;
  title: string;
  blocks: PlaceDetailBlockInput[];
}

export interface PlaceDetailSectionDto extends Omit<PlaceDetailSectionInput, "blocks"> {
  blocks: PlaceDetailBlockDto[];
}

export interface PlacePhotoMetadata {
  id: string;
  title: string;
  description: string;
  sourceName: string;
  sourceUrl: string;
  fileSourceUrl: string;
  author: string;
  authorUrl: string | null;
  creditText: string;
  licenseName: string;
  licenseUrl: string;
  capturedAt: string | null;
  checkedAt: string;
  verificationUrl: string;
  locationEvidence: string;
  changes: string;
  notices: string[];
  originalWidth: number;
  originalHeight: number;
}

export interface PlacePhotoDto extends PlacePhotoMetadata {
  imageUrl: string;
  thumbnailUrl: string;
  width: number;
  height: number;
}

export interface PlaceDetailDto {
  reference: PlaceDetailReference;
  canonicalPlaceId: string | null;
  name: string;
  asOfDate: string | null;
  sections: PlaceDetailSectionDto[];
  sources: PlaceDetailSourceDto[];
  photos: PlacePhotoDto[];
}

export interface PlaceDetailResponse {
  detail: PlaceDetailDto;
}

export interface PlacePreviewDto {
  reference: PlaceDetailReference;
  photo: PlacePhotoDto | null;
}

export interface PlacePreviewResponse {
  previews: PlacePreviewDto[];
}

export interface CuratedPhotoAssetInput {
  filename: string;
  sha256: string;
  width: number;
  height: number;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
}

export interface CuratedPhotoInput extends PlacePhotoMetadata {
  image: CuratedPhotoAssetInput;
  thumbnail: CuratedPhotoAssetInput;
}

export interface CuratedPlaceInput {
  key: string;
  name: string;
  sections: PlaceDetailSectionInput[];
  sources: PlaceDetailSourceDto[];
  photos: CuratedPhotoInput[];
}

export interface CuratedPlaceManifest {
  version: 1;
  places: CuratedPlaceInput[];
}

function invalid(field: string): never {
  throw new Error(`Invalid place details: ${field}`);
}

function record(value: unknown, field: string, keys: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid(field);
  if (Object.keys(value).some((key) => !keys.includes(key))) return invalid(`${field}: unexpected field`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
    return invalid(field);
  }
  return value;
}

function identifier(value: unknown, field: string): string {
  const result = text(value, field, 160);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result) ? result : invalid(field);
}

function uuid(value: unknown, field: string): string {
  const result = text(value, field, 36);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)
    ? result.toLowerCase() : invalid(field);
}

function array<T>(value: unknown, field: string, max: number, parse: (item: unknown) => T): T[] {
  return Array.isArray(value) && value.length <= max ? value.map(parse) : invalid(field);
}

function unique<T>(items: T[], key: (item: T) => string, field: string): T[] {
  if (new Set(items.map(key)).size !== items.length) return invalid(`${field}: duplicate`);
  return items;
}

function httpsUrl(value: unknown, field: string): string {
  const result = text(value, field, 4_096);
  try {
    const url = new URL(result);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || /\s/.test(result)) return invalid(field);
  } catch {
    return invalid(field);
  }
  return result;
}

export function parsePlaceDetailDate(value: unknown): string {
  const result = text(value, "date", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || result.startsWith("0000-")) return invalid("date");
  const date = new Date(`${result}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === result ? result : invalid("date");
}

function instant(value: unknown, field: string): string {
  const result = text(value, field, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(result)
    || !Number.isFinite(Date.parse(result))) return invalid(field);
  parsePlaceDetailDate(result.slice(0, 10));
  const hour = Number(result.slice(11, 13));
  const minute = Number(result.slice(14, 16));
  const second = Number(result.slice(17, 19));
  if (hour > 23 || minute > 59 || second > 59) return invalid(field);
  return result;
}

function dateOrInstant(value: unknown, field: string): string {
  return typeof value === "string" && value.length === 10 ? parsePlaceDetailDate(value) : instant(value, field);
}

function nullable<T>(value: unknown, parse: (item: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function dimension(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 50_000
    ? value : invalid("image dimension");
}

export function parsePlaceDetailReference(value: unknown): PlaceDetailReference {
  const item = record(value, "reference", ["kind", "id"]);
  const kind = item.kind;
  if (kind !== "trip-place" && kind !== "proposal" && kind !== "itinerary-place") return invalid("reference kind");
  return { kind, id: uuid(item.id, "reference id") };
}

export function parsePlacePreviewIds(value: unknown): string[] {
  const ids = text(value, "ids", 3_699).split(",");
  if (ids.length > 100) return invalid("ids: at most 100");
  return unique(ids.map((id) => uuid(id, "reference id")), (id) => id, "ids");
}

const sourceKeys = ["id", "title", "url", "checkedAt", "publishedAt", "validFrom", "validUntil", "expiresAt"];
function source(value: unknown): PlaceDetailSourceDto {
  const item = record(value, "source", sourceKeys);
  const result: PlaceDetailSourceDto = {
    id: identifier(item.id, "source id"),
    title: text(item.title, "source title", 500),
    url: httpsUrl(item.url, "source URL"),
    checkedAt: instant(item.checkedAt, "checkedAt"),
    publishedAt: nullable(item.publishedAt, (value) => dateOrInstant(value, "publishedAt")),
    validFrom: nullable(item.validFrom, parsePlaceDetailDate),
    validUntil: nullable(item.validUntil, parsePlaceDetailDate),
    expiresAt: nullable(item.expiresAt, (value) => instant(value, "expiresAt")),
  };
  if (result.validFrom && result.validUntil && result.validFrom > result.validUntil) return invalid("source validity range");
  return result;
}

const sectionKinds: PlaceDetailSectionKind[] = ["intro", "sights", "location", "transport", "hours", "fees", "notices"];
function sections(value: unknown, sources: PlaceDetailSourceDto[], response: false): PlaceDetailSectionInput[];
function sections(value: unknown, sources: PlaceDetailSourceDto[], response: true): PlaceDetailSectionDto[];
function sections(value: unknown, sources: PlaceDetailSourceDto[], response: boolean) {
  const sourceIds = new Set(sources.map((item) => item.id));
  return unique(array(value, "sections", 7, (value) => {
    const item = record(value, "section", ["kind", "title", "blocks"]);
    const kind = item.kind as PlaceDetailSectionKind;
    if (!sectionKinds.includes(kind)) return invalid("section kind");
    const blocks = array(item.blocks, "blocks", 30, (value) => {
      const block = record(value, "block", ["text", "style", "sourceIds", "certainty", ...(response ? ["needsRecheck"] : [])]);
      const certainty = block.certainty;
      if (certainty !== "sourced" && certainty !== "unknown" && certainty !== "conflicted") return invalid("certainty");
      const ids = unique(array(block.sourceIds, "sourceIds", 20, (id) => identifier(id, "source id")), (id) => id, "sourceIds");
      if (ids.some((id) => !sourceIds.has(id))
        || (certainty === "sourced" && ids.length === 0)
        || (certainty === "conflicted" && ids.length < 2)) return invalid("block source references");
      if (block.style !== "paragraph" && block.style !== "bullet") return invalid("block style");
      const result: PlaceDetailBlockInput = { text: text(block.text, "block text", 4_000), style: block.style, sourceIds: ids, certainty };
      if (!response) return result;
      if (typeof block.needsRecheck !== "boolean") return invalid("needsRecheck");
      return { ...result, needsRecheck: block.needsRecheck };
    });
    if (!blocks.length) return invalid("empty section");
    return { kind, title: text(item.title, "section title", 120), blocks };
  }), (item) => item.kind, "sections");
}

const photoKeys = ["id", "title", "description", "sourceName", "sourceUrl", "fileSourceUrl", "author", "authorUrl", "creditText",
  "licenseName", "licenseUrl", "capturedAt", "checkedAt", "verificationUrl", "locationEvidence", "changes", "notices", "originalWidth", "originalHeight"];
function photoMetadata(item: Record<string, unknown>): PlacePhotoMetadata {
  const metadata = {
    id: identifier(item.id, "work id"),
    title: text(item.title, "photo title", 1_000),
    description: text(item.description, "photo description", 4_000),
    sourceName: text(item.sourceName, "source name", 200),
    sourceUrl: httpsUrl(item.sourceUrl, "work URL"),
    fileSourceUrl: httpsUrl(item.fileSourceUrl, "file source URL"),
    author: text(item.author, "author", 4_000),
    authorUrl: nullable(item.authorUrl, (value) => httpsUrl(value, "author URL")),
    creditText: text(item.creditText, "credit", 8_000),
    licenseName: text(item.licenseName, "license name/version", 500),
    licenseUrl: httpsUrl(item.licenseUrl, "license URL"),
    capturedAt: nullable(item.capturedAt, (value) => dateOrInstant(value, "capturedAt")),
    checkedAt: instant(item.checkedAt, "photo checkedAt"),
    verificationUrl: httpsUrl(item.verificationUrl, "license verification URL"),
    locationEvidence: text(item.locationEvidence, "location evidence", 4_000),
    changes: text(item.changes, "changes", 4_000),
    notices: array(item.notices, "notices", 20, (value) => text(value, "notice", 4_000)),
    originalWidth: dimension(item.originalWidth),
    originalHeight: dimension(item.originalHeight),
  };
  if (new URL(metadata.sourceUrl).hostname === "commons.wikimedia.org") {
    const evidence = new URL(metadata.verificationUrl);
    if (evidence.hostname !== "commons.wikimedia.org"
      || (!/^[1-9][0-9]*$/.test(evidence.searchParams.get("oldid") ?? "")
        && !/^\/wiki\/Special:PermanentLink\/[1-9][0-9]*$/.test(evidence.pathname))) {
      return invalid("Commons licensing evidence must identify a reviewed revision");
    }
  }
  return metadata;
}

export function parseCuratedPhotoAsset(value: unknown): CuratedPhotoAssetInput {
  const item = record(value, "asset", ["filename", "sha256", "width", "height", "mediaType"]);
  const sha256 = text(item.sha256, "sha256", 64);
  const filename = text(item.filename, "filename", 70);
  const mediaType = item.mediaType;
  if (mediaType !== "image/jpeg" && mediaType !== "image/png" && mediaType !== "image/webp") return invalid("mediaType");
  const extension = mediaType === "image/jpeg" ? "jpg" : mediaType === "image/png" ? "png" : "webp";
  if (!/^[a-f0-9]{64}$/.test(sha256) || filename !== `${sha256}.${extension}`) return invalid("immutable filename/checksum");
  return { filename, sha256, width: dimension(item.width), height: dimension(item.height), mediaType };
}

export function parseCuratedPhoto(value: unknown): CuratedPhotoInput {
  const item = record(value, "photo", [...photoKeys, "image", "thumbnail"]);
  const metadata = photoMetadata(item);
  const image = parseCuratedPhotoAsset(item.image);
  const thumbnail = parseCuratedPhotoAsset(item.thumbnail);
  if (image.width > metadata.originalWidth || image.height > metadata.originalHeight
    || thumbnail.width > image.width || thumbnail.height > image.height) return invalid("asset dimensions exceed source");
  return { ...metadata, image, thumbnail };
}

function photos<T extends PlacePhotoMetadata>(value: unknown, parse: (value: unknown) => T): T[] {
  const result = unique(array(value, "photos", 30, parse), (photo) => photo.id, "work ids/order");
  return unique(result, (photo) => photo.sourceUrl, "work source URLs");
}

export function parseCuratedPlaceManifest(value: unknown): CuratedPlaceManifest {
  const manifest = record(value, "manifest", ["version", "places"]);
  if (manifest.version !== 1) return invalid("manifest version");
  return {
    version: 1,
    places: unique(array(manifest.places, "places", 200, (value) => {
      const place = record(value, "place", ["key", "name", "sections", "sources", "photos"]);
      const sources = unique(array(place.sources, "sources", 100, source), (item) => item.id, "source ids");
      return {
        key: identifier(place.key, "place key"),
        name: text(place.name, "place name", 200),
        sources,
        sections: sections(place.sections, sources, false),
        photos: unique(photos(place.photos, parseCuratedPhoto), (photo) => photo.image.sha256, "duplicate photo bytes"),
      };
    }), (place) => place.key, "place keys"),
  };
}

function assetUrl(value: unknown): string {
  const url = text(value, "authenticated asset URL", 1_000);
  if (!/^\/api\/trips\/[0-9a-f-]{36}\/place-photo-assets\/[a-f0-9]{64}\.(jpg|png|webp)\?kind=(trip-place|proposal|itinerary-place)&id=[0-9a-f-]{36}$/.test(url)) {
    return invalid("authenticated asset URL");
  }
  return url;
}

function photoDto(value: unknown): PlacePhotoDto {
  const item = record(value, "photo", [...photoKeys, "imageUrl", "thumbnailUrl", "width", "height"]);
  return {
    ...photoMetadata(item),
    imageUrl: assetUrl(item.imageUrl),
    thumbnailUrl: assetUrl(item.thumbnailUrl),
    width: dimension(item.width),
    height: dimension(item.height),
  };
}

export function parsePlaceDetailResponse(value: unknown): PlaceDetailResponse {
  const response = record(value, "response", ["detail"]);
  const detail = record(response.detail, "detail", ["reference", "canonicalPlaceId", "name", "asOfDate", "sections", "sources", "photos"]);
  const sources = unique(array(detail.sources, "sources", 100, source), (item) => item.id, "source ids");
  return { detail: {
    reference: parsePlaceDetailReference(detail.reference),
    canonicalPlaceId: nullable(detail.canonicalPlaceId, (value) => uuid(value, "canonical place id")),
    name: text(detail.name, "place name", 200),
    asOfDate: nullable(detail.asOfDate, parsePlaceDetailDate),
    sections: sections(detail.sections, sources, true),
    sources,
    photos: photos(detail.photos, photoDto),
  } };
}

export function parsePlacePreviewResponse(value: unknown): PlacePreviewResponse {
  const response = record(value, "response", ["previews"]);
  return { previews: unique(array(response.previews, "previews", 100, (value) => {
    const item = record(value, "preview", ["reference", "photo"]);
    return { reference: parsePlaceDetailReference(item.reference), photo: nullable(item.photo, photoDto) };
  }), (item) => `${item.reference.kind}:${item.reference.id}`, "preview references") };
}
