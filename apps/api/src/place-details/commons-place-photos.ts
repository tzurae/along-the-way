import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { parseCuratedPhoto, type CuratedPhotoAssetInput, type CuratedPhotoInput } from "@along-the-way/contracts/place-details";
import type { AlongTheWayDatabase } from "../database/database";

/** A matched, licence-checked Commons work with its downloaded renditions, not yet stored. */
export interface PreparedCommonsPhoto {
  wikidataId: string;
  photo: CuratedPhotoInput;
  renditions: Array<{ asset: CuratedPhotoAssetInput; bytes: Uint8Array }>;
}

/**
 * The network lookup and the write are separate so the caller can store the photo in
 * the same transaction that creates the place: a reader then never sees the new place
 * without its photo and falls back to Google while the lookup is still running.
 */
export interface RepresentativePhotoSource {
  /** Null for anything but a confident, freely licensed match, including any Wikimedia failure. Never throws. */
  prepare(googleMapsUri: string | null): Promise<PreparedCommonsPhoto | null>;
  store(executor: Kysely<AlongTheWayDatabase>, placeIdentityId: string, prepared: PreparedCommonsPhoto): Promise<void>;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
// The same long sides as the packaged curated derivatives (1280 display, 330 thumbnail).
const IMAGE_LONG_SIDE = 1280;
const THUMBNAIL_LONG_SIDE = 330;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// extmetadata `License` codes, e.g. cc0, cc-by-4.0, cc-by-sa-3.0-de.
const ALLOWED_LICENSE = /^(cc0|cc-by-[0-9.]+(-[a-z]{2,3})?|cc-by-sa-[0-9.]+(-[a-z]{2,3})?)$/;
const CC0_URL = "https://creativecommons.org/publicdomain/zero/1.0/";
const MEDIA_EXTENSION = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
type MediaType = keyof typeof MEDIA_EXTENSION;

interface Rendition {
  url: string;
  width: number;
  height: number;
}

interface CommonsWork {
  pageId: number;
  title: string;
  revisionId: number;
  sourceUrl: string;
  fileSourceUrl: string;
  mediaType: MediaType;
  originalWidth: number;
  originalHeight: number;
  image: Rendition;
  thumbnail: Rendition;
  license: string;
  licenseShortName: string;
  licenseName: string;
  licenseUrl: string;
  author: string;
  authorUrl: string | null;
  description: string | null;
  capturedAt: string | null;
  restrictions: string | null;
}

/** The decimal CID that Google Maps puts in a place's `googleMapsUri`; null when absent. */
export function googleMapsCid(googleMapsUri: string | null): string | null {
  if (!googleMapsUri) return null;
  try {
    const url = new URL(googleMapsUri);
    if (url.protocol !== "https:" || !(url.hostname === "google.com" || url.hostname.endsWith(".google.com"))) return null;
    const cid = url.searchParams.get("cid");
    return cid && /^[1-9][0-9]{0,19}$/.test(cid) ? cid : null;
  } catch {
    return null;
  }
}

function plainText(html: string | undefined, maximum: number): string | null {
  if (!html) return null;
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function firstHttpsLink(html: string | undefined): string | null {
  const href = html?.match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
  if (!href) return null;
  const absolute = href.startsWith("//") ? `https:${href}` : href.startsWith("/") ? `https://commons.wikimedia.org${href}` : href;
  try {
    return new URL(absolute).protocol === "https:" ? absolute : null;
  } catch {
    return null;
  }
}

function httpsLicenseUrl(value: string | undefined, license: string): string | null {
  if (!value) return license === "cc0" ? CC0_URL : null;
  const normalized = value.startsWith("//") ? `https:${value}` : value.replace(/^http:\/\/creativecommons\.org\//, "https://creativecommons.org/");
  try {
    return new URL(normalized).protocol === "https:" ? normalized : null;
  } catch {
    return null;
  }
}

function capturedDate(value: string | undefined): string | null {
  const date = plainText(value, 200)?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function metadataValue(metadata: Record<string, unknown> | null, key: string): string | undefined {
  const value = record(metadata?.[key])?.value;
  return typeof value === "string" ? value : undefined;
}

/**
 * Finds the Wikidata representative image (P18) for a place whose Google CID is
 * registered on exactly one Wikidata item (P3749), with its licence and renditions.
 */
export class CommonsPlacePhotos implements RepresentativePhotoSource {
  private readonly fetch: FetchLike;
  private readonly userAgent: string;
  private readonly budgetMs: number;
  private readonly now: () => Date;

  constructor(options: {
    userAgent: string;
    fetch?: FetchLike;
    budgetMs?: number;
    now?: () => Date;
  }) {
    this.userAgent = options.userAgent;
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.budgetMs = options.budgetMs ?? 6_000;
    this.now = options.now ?? (() => new Date());
  }

  async prepare(googleMapsUri: string | null): Promise<PreparedCommonsPhoto | null> {
    const cid = googleMapsCid(googleMapsUri);
    if (!cid) return null;
    const signal = AbortSignal.timeout(this.budgetMs);
    try {
      const itemId = await this.uniqueItem(cid, signal);
      const fileName = itemId ? await this.representativeImage(itemId, signal) : null;
      const work = fileName ? await this.licensedWork(fileName, signal) : null;
      if (!itemId || !work) return null;
      const renditions = await Promise.all([
        this.download(work.image, work.mediaType, signal),
        this.download(work.thumbnail, work.mediaType, signal),
      ]);
      return { wikidataId: itemId, photo: this.photoMetadata(itemId, work, renditions[0].asset, renditions[1].asset), renditions };
    } catch {
      return null;
    }
  }

  async store(executor: Kysely<AlongTheWayDatabase>, placeIdentityId: string, prepared: PreparedCommonsPhoto) {
    await executor.insertInto("place_photo_blobs")
      .values(prepared.renditions.map((item) => ({ filename: item.asset.filename, media_type: item.asset.mediaType, bytes: item.bytes })))
      .onConflict((conflict) => conflict.column("filename").doNothing())
      .execute();
    await executor.insertInto("commons_place_photos").values({
      place_id: placeIdentityId,
      wikidata_id: prepared.wikidataId,
      metadata: JSON.stringify(prepared.photo),
      image_filename: prepared.photo.image.filename,
      thumbnail_filename: prepared.photo.thumbnail.filename,
      checked_at: prepared.photo.checkedAt,
    }).onConflict((conflict) => conflict.column("place_id").doNothing()).execute();
  }

  private async uniqueItem(cid: string, signal: AbortSignal): Promise<string | null> {
    const response = record(await this.json(WIKIDATA_API, {
      action: "query", list: "search", srsearch: `haswbstatement:P3749=${cid}`, srnamespace: "0", srlimit: "2",
    }, signal));
    const hits = record(response?.query)?.search;
    if (!Array.isArray(hits) || hits.length !== 1) return null;
    const title = record(hits[0])?.title;
    return typeof title === "string" && /^Q[1-9][0-9]*$/.test(title) ? title : null;
  }

  private async representativeImage(itemId: string, signal: AbortSignal): Promise<string | null> {
    const response = record(await this.json(WIKIDATA_API, { action: "wbgetclaims", entity: itemId, property: "P18" }, signal));
    const claims = record(response?.claims)?.P18;
    if (!Array.isArray(claims)) return null;
    const usable = claims.map(record).filter((claim) => claim && claim.rank !== "deprecated");
    const chosen = usable.find((claim) => claim!.rank === "preferred") ?? usable[0];
    const value = record(record(record(chosen?.mainsnak)?.datavalue))?.value;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  private async licensedWork(fileName: string, signal: AbortSignal): Promise<CommonsWork | null> {
    const title = `File:${fileName}`;
    const page = this.firstPage(await this.json(COMMONS_API, {
      action: "query", titles: title, prop: "imageinfo|revisions", rvprop: "ids", iiprop: "url|size|mime|extmetadata",
    }, signal));
    const info = this.firstImageInfo(page);
    const revisionId = positiveInteger(record(Array.isArray(page?.revisions) ? page.revisions[0] : null)?.revid);
    const pageId = positiveInteger(page?.pageid);
    const metadata = record(info?.extmetadata);
    const mediaType = info?.mime;
    if (!info || !revisionId || !pageId || typeof page?.title !== "string"
      || (mediaType !== "image/jpeg" && mediaType !== "image/png" && mediaType !== "image/webp")) return null;
    const license = metadataValue(metadata, "License")?.toLowerCase() ?? "";
    if (!ALLOWED_LICENSE.test(license) || metadataValue(metadata, "NonFree") === "true") return null;
    const licenseUrl = httpsLicenseUrl(metadataValue(metadata, "LicenseUrl"), license);
    const licenseShortName = plainText(metadataValue(metadata, "LicenseShortName"), 200);
    const author = plainText(metadataValue(metadata, "Artist"), 4_000);
    const originalWidth = positiveInteger(info.width);
    const originalHeight = positiveInteger(info.height);
    if (!licenseUrl || !licenseShortName || !author || !originalWidth || !originalHeight
      || typeof info.descriptionurl !== "string" || typeof info.url !== "string") return null;
    const [image, thumbnail] = await Promise.all([IMAGE_LONG_SIDE, THUMBNAIL_LONG_SIDE].map((longSide) =>
      this.rendition(title, originalWidth, originalHeight, longSide, signal)));
    if (!image || !thumbnail) return null;
    return {
      pageId,
      title: page.title,
      revisionId,
      sourceUrl: info.descriptionurl,
      fileSourceUrl: info.url,
      mediaType,
      originalWidth,
      originalHeight,
      image,
      thumbnail,
      license,
      licenseShortName,
      licenseName: plainText(metadataValue(metadata, "UsageTerms"), 500) ?? licenseShortName,
      licenseUrl,
      author,
      authorUrl: firstHttpsLink(metadataValue(metadata, "Artist")),
      description: plainText(metadataValue(metadata, "ImageDescription"), 4_000),
      capturedAt: capturedDate(metadataValue(metadata, "DateTimeOriginal")),
      restrictions: plainText(metadataValue(metadata, "Restrictions"), 1_000),
    };
  }

  /** Commons answers a width with its nearest standard rendition, or the original when that is smaller. */
  private async rendition(title: string, width: number, height: number, longSide: number, signal: AbortSignal): Promise<Rendition | null> {
    const requestedWidth = width >= height ? Math.min(longSide, width) : Math.max(1, Math.min(width, Math.round(longSide * width / height)));
    const info = this.firstImageInfo(this.firstPage(await this.json(COMMONS_API, {
      action: "query", titles: title, prop: "imageinfo", iiprop: "url", iiurlwidth: String(requestedWidth),
    }, signal)));
    const url = info?.thumburl;
    const renditionWidth = positiveInteger(info?.thumbwidth);
    const renditionHeight = positiveInteger(info?.thumbheight);
    if (typeof url !== "string" || !renditionWidth || !renditionHeight) return null;
    try {
      const parsed = new URL(url);
      // Commons serves renditions from thumb.wikimedia.org, and originals smaller than the request from upload.wikimedia.org.
      return parsed.protocol === "https:" && (parsed.hostname === "thumb.wikimedia.org" || parsed.hostname === "upload.wikimedia.org")
        ? { url, width: renditionWidth, height: renditionHeight }
        : null;
    } catch {
      return null;
    }
  }

  private firstImageInfo(page: Record<string, unknown> | null) {
    return record(Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null);
  }

  private firstPage(response: unknown) {
    const pages = record(record(response)?.query)?.pages;
    return Array.isArray(pages) ? record(pages[0]) : null;
  }

  private async download(rendition: Rendition, mediaType: MediaType, signal: AbortSignal) {
    const response = await this.fetch(rendition.url, { signal, headers: { "User-Agent": this.userAgent } });
    if (!response.ok || response.headers.get("content-type")?.split(";")[0]?.trim() !== mediaType) {
      throw new Error("Commons rendition is unavailable");
    }
    const bytes = new Uint8Array(await this.boundedBytes(response, MAX_IMAGE_BYTES));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const asset: CuratedPhotoAssetInput = {
      filename: `${sha256}.${MEDIA_EXTENSION[mediaType]}`,
      sha256,
      width: rendition.width,
      height: rendition.height,
      mediaType,
    };
    return { asset, bytes };
  }

  private photoMetadata(itemId: string, work: CommonsWork, image: CuratedPhotoAssetInput, thumbnail: CuratedPhotoAssetInput): CuratedPhotoInput {
    const shareAlike = work.license.startsWith("cc-by-sa-");
    const attribution = work.license !== "cc0";
    const notices = [
      ...(attribution ? [`使用時須適當署名、連結授權條款並標示修改${shareAlike ? `；若另行改作，須依 ${work.licenseShortName} 以相同授權分享` : ""}。`] : []),
      "此照片由系統依 Wikidata 的代表圖片自動選取，未經人工審核；Wikimedia Commons 也不保證所有權利資料無誤，其他非著作權限制仍可能適用。",
      ...(work.restrictions ? [`Commons 標示的其他限制：${work.restrictions}`] : []),
    ];
    const verificationTitle = encodeURIComponent(work.title.replace(/ /g, "_"));
    return parseCuratedPhoto({
      id: `commons-${work.pageId}`,
      title: work.title.replace(/^File:/, "").replace(/\.[A-Za-z0-9]+$/, ""),
      description: work.description ?? "Wikimedia Commons 作品頁未提供說明。",
      sourceName: "Wikimedia Commons",
      sourceUrl: work.sourceUrl,
      fileSourceUrl: work.fileSourceUrl,
      author: work.author,
      authorUrl: work.authorUrl,
      creditText: `${work.author}，作品來源 Wikimedia Commons，${work.licenseShortName}`,
      licenseName: work.licenseName,
      licenseUrl: work.licenseUrl,
      capturedAt: work.capturedAt,
      checkedAt: this.now().toISOString(),
      verificationUrl: `https://commons.wikimedia.org/w/index.php?title=${verificationTitle}&oldid=${work.revisionId}`,
      locationEvidence: `Wikidata ${itemId} 以 Google Maps Customer ID（P3749）對應此地點，並以本作品為代表圖片（P18）。`,
      changes: `採用 Wikimedia Commons 產生的 ${image.width}×${image.height} 與 ${thumbnail.width}×${thumbnail.height} 等比例縮放版本，下載後未再編修。`,
      notices,
      originalWidth: work.originalWidth,
      originalHeight: work.originalHeight,
      image,
      thumbnail,
    });
  }

  private async json(endpoint: string, parameters: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    const url = new URL(endpoint);
    // No `maxlag`: it is meant for edits, and on reads it fails whenever the query service lags.
    for (const [key, value] of Object.entries({ ...parameters, format: "json", formatversion: "2" })) {
      url.searchParams.set(key, value);
    }
    const response = await this.fetch(url, { signal, headers: { "User-Agent": this.userAgent, Accept: "application/json" } });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("Wikimedia API is unavailable");
    }
    const body = JSON.parse(new TextDecoder().decode(await this.boundedBytes(response, MAX_JSON_BYTES))) as unknown;
    if (record(body)?.error) throw new Error("Wikimedia API rejected the request");
    return body;
  }

  private async boundedBytes(response: Response, maximum: number) {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximum) throw new Error("Wikimedia response is too large");
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maximum) throw new Error("Wikimedia response is too large");
    return buffer;
  }
}
