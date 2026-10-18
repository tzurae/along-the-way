import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { Kysely } from "kysely";
import { parsePlaceDetailResponse, parsePlacePreviewResponse, type CuratedPlaceManifest, type PlaceDetailReference } from "@along-the-way/contracts/place-details";
import { parseTripResponse } from "@along-the-way/contracts/private-trips";
import { parseProviderCandidatesResponse, parseTripPlaceResponse, type ProviderPlaceCandidateDto, type TripPlaceDto } from "@along-the-way/contracts/trip-places";
import { createApp } from "../src/app";
import { createDatabase, type AlongTheWayDatabase } from "../src/database/database";
import { runMigrations } from "../src/database/migrate";
import { importCuratedPlaceDetails, type CuratedPlaceBindings } from "../src/place-details/import-curated-place-details";
import { PostgresPlaceDetailModule } from "../src/place-details/postgres-place-detail-module";
import { PostgresCollaborationModule } from "../src/private-trips/postgres-collaboration-module";
import { PostgresIdentityAccessModule } from "../src/private-trips/postgres-identity-access-module";
import { PostgresRateLimiter } from "../src/private-trips/postgres-rate-limiter";
import { PostgresReadinessProbe } from "../src/private-trips/postgres-readiness-probe";
import { PostgresTripWorkspaceModule } from "../src/private-trips/postgres-trip-workspace-module";
import { hashToken, TokenIssuer } from "../src/private-trips/token-issuer";
import { PostgresTripSkeletonModule } from "../src/trip-skeleton/postgres-trip-skeleton-module";
import { PostgresTripPlaceModule } from "../src/trip-places/postgres-trip-place-module";
import { googlePlacePhotoFingerprint, PlacePhotoNotFoundError, type PlaceProvider } from "../src/trip-places/google-places-provider";
import { unrelatedDayPlanModule } from "./day-plan-test-support";
import { unrelatedDiscoveryModule } from "./discovery-test-support";
import { tripFlights } from "./travel-test-support";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required; use an isolated verification database");
const now = () => new Date("2026-10-09T12:00:00.000Z");
const photoCapabilitySecret = "place-photo-capability-secret-at-least-32-bytes";
// Original test-only pixel, never an application image or a claimed photograph of a real place.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH9sAAAAASUVORK5CYII=", "base64");
const checksum = createHash("sha256").update(png).digest("hex");
const filename = `${checksum}.png`;

function manifest(key: string): CuratedPlaceManifest {
  const asset = { filename, sha256: checksum, width: 1, height: 1, mediaType: "image/png" as const };
  return { version: 1, places: [{ key, name: "同名庭園", sources: [
    { id: "official", title: "庭園公開資訊", url: "https://example.test/garden/visit", checkedAt: "2026-10-01T08:00:00Z",
      publishedAt: null, validFrom: "2026-10-01", validUntil: "2026-10-31", expiresAt: null },
    { id: "old-guide", title: "旅遊資料", url: "https://example.test/guide/garden", checkedAt: "2026-09-01T08:00:00Z",
      publishedAt: "2026-08-01", validFrom: null, validUntil: null, expiresAt: "2026-10-09T12:00:00Z" },
  ], sections: [
    { kind: "intro", title: "景點介紹", blocks: [{ text: "庭園有可參觀的東側步道。", style: "paragraph", sourceIds: ["official"], certainty: "sourced" }] },
    { kind: "fees", title: "費用", blocks: [
      { text: "官方與舊旅遊資料的票價不同，需要確認。", style: "paragraph", sourceIds: ["official", "old-guide"], certainty: "conflicted" },
      { text: "特別展覽費用待確認。", style: "bullet", sourceIds: [], certainty: "unknown" },
    ] },
  ], photos: [{
    id: "original-test-pixel", title: "測試像素", description: "僅供資料管線驗證，並非場所照片。",
    sourceName: "Test work", sourceUrl: "https://example.test/works/pixel", fileSourceUrl: "https://example.test/files/pixel.png",
    author: "測試作者", authorUrl: null, creditText: "測試作者，原始像素", licenseName: "CC0 1.0",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/", capturedAt: null, checkedAt: "2026-10-01T08:00:00Z",
    verificationUrl: "https://example.test/works/pixel?revision=1", locationEvidence: "測試資料明確綁定測試場所。",
    changes: "無修改。", notices: ["不是正式策展內容。"], originalWidth: 1, originalHeight: 1, image: asset, thumbnail: asset,
  }] }] };
}

describe("curated place detail publication and authenticated HTTP reads", () => {
  let database: Kysely<AlongTheWayDatabase>;
  let app: Hono;
  let assetRoot: string;
  let owner: { id: string; cookie: string };
  let outsider: { id: string; cookie: string };
  let tripId: string;
  let place: TripPlaceDto;
  let branch: TripPlaceDto;
  let legacyId: string;
  let proposalId: string;
  let input: CuratedPlaceManifest;
  let bindings: CuratedPlaceBindings;
  let providerReads: number;
  let mediaReads: number;
  let mediaRequests: Array<{ photoName: string; maxWidthPx: 192 | 1024 }>;
  let missingMediaPhotoName: string | null;
  let currentPhotoToken: string;
  let currentPhotoAuthors: Array<{ displayName: string; uri: string | null }>;
  let googlePhotoOrder: Array<0 | 1 | 2>;
  let failedProviderPhotoId: string | null;
  let unassociatedSearchPlaceId: string;
  const createdTrips: string[] = [];
  const createdUsers: string[] = [];
  const canonicalIds: string[] = [];

  beforeAll(async () => {
    database = createDatabase(databaseUrl);
    await runMigrations(database);
    await mkdir("/tmp/along-place-details-verification", { recursive: true });
  });

  async function session() {
    const token = randomUUID();
    const user = await database.insertInto("users").values({ email: `${token}@example.test`, display_name: "測試成員", status: "active" })
      .returning("id").executeTakeFirstOrThrow();
    createdUsers.push(user.id);
    await database.insertInto("sessions").values({ user_id: user.id, token_hash: hashToken(token),
      expires_at: "2026-11-01T00:00:00Z", last_seen_at: now(), revoked_at: null }).execute();
    return { id: user.id, cookie: `__Host-along_the_way_session=${token}` };
  }

  async function createTrip(cookie: string) {
    const response = await app.request("/api/trips", { method: "POST", headers: {
      cookie, "content-type": "application/json", origin: "https://app.example.test", "idempotency-key": randomUUID(),
    }, body: JSON.stringify({ name: `照片隔離驗證 ${randomUUID()}`, startDate: "2026-10-01", endDate: "2026-10-03",
      countryCodes: ["TW"], flights: tripFlights("2026-10-01", "2026-10-03", "Asia/Taipei") }) });
    expect(response.status).toBe(201);
    const trip = parseTripResponse(await response.json()).trip;
    createdTrips.push(trip.id);
    return trip.id;
  }

  async function addPlace(providerPlaceId: string) {
    const response = await app.request(`/api/trips/${tripId}/trip-places`, { method: "POST", headers: {
      cookie: owner.cookie, "content-type": "application/json", origin: "https://app.example.test", "idempotency-key": randomUUID(),
    }, body: JSON.stringify({ method: "search", providerPlaceId, originalNote: "成員想去的原因，不能被景點介紹覆蓋。" }) });
    expect(response.status).toBe(201);
    const place = parseTripPlaceResponse(await response.json()).tripPlace;
    canonicalIds.push(place.placeId);
    return place;
  }

  beforeEach(async () => {
    assetRoot = await mkdtemp("/tmp/along-place-details-verification/api-test-");
    await writeFile(join(assetRoot, filename), png);
    owner = await session();
    outsider = await session();
    providerReads = 0;
    mediaReads = 0;
    mediaRequests = [];
    missingMediaPhotoName = null;
    currentPhotoToken = "controlled-photo";
    currentPhotoAuthors = [{ displayName: "Google 攝影者", uri: "https://example.test/google-author" }];
    googlePhotoOrder = [0, 1, 2];
    failedProviderPhotoId = null;
    unassociatedSearchPlaceId = `search-photo-${randomUUID()}`;
    const provider: PlaceProvider = {
      available: true,
      attribution: "Controlled provider",
      async search() {
        return [{
          provider: "google",
          providerPlaceId: unassociatedSearchPlaceId,
          name: "搜尋中的未加入地點",
          type: "activity",
          typeLabel: "景點",
          address: "尚未加入旅程",
          latitude: 25.1,
          longitude: 121.1,
          timeZone: "Asia/Taipei",
          sourceUrl: "https://example.test/map/search-result",
          attribution: "Controlled provider",
          observedAt: "2026-10-09T12:00:00.000Z",
          expiresAt: "2026-11-08T12:00:00.000Z",
          photo: null,
          providerPhoto: {
            name: `places/${unassociatedSearchPlaceId}/photos/${currentPhotoToken}`,
            width: 1600,
            height: 1200,
            authors: currentPhotoAuthors,
            googleMapsUri: "https://maps.google.com/?cid=search-photo",
          },
        }];
      },
      async getPlace(providerPlaceId): Promise<ProviderPlaceCandidateDto> {
        return { provider: "google", providerPlaceId, name: "同名庭園", type: "activity", typeLabel: null,
          address: `測試地址 ${providerPlaceId}`, latitude: 25, longitude: 121, timeZone: "Asia/Taipei", sourceUrl: "https://example.test/map/garden",
          attribution: "Controlled provider", observedAt: "2026-10-01T00:00:00Z", expiresAt: "2026-11-01T00:00:00Z",
          photo: null };
      },
      async getPhotos(providerPlaceId) {
        providerReads++;
        if (providerPlaceId === failedProviderPhotoId) throw new Error("Controlled photo failure");
        const photos = [
          {
            name: `places/${providerPlaceId}/photos/${currentPhotoToken}`,
            width: 1600,
            height: 1200,
            authors: currentPhotoAuthors,
            googleMapsUri: providerPlaceId === unassociatedSearchPlaceId
              ? "https://maps.google.com/?cid=search-photo"
              : "https://maps.google.com/?cid=controlled-photo",
          },
          {
            name: `places/${providerPlaceId}/photos/controlled-photo-2`,
            width: 1400,
            height: 1000,
            authors: [{ displayName: "Google 攝影者二", uri: "https://example.test/google-author-2" }],
            googleMapsUri: "https://maps.google.com/?cid=controlled-photo-2",
          },
          {
            name: `places/${providerPlaceId}/photos/controlled-photo-3`,
            width: 1200,
            height: 900,
            authors: [{ displayName: "Google 攝影者三", uri: "https://example.test/google-author-3" }],
            googleMapsUri: "https://maps.google.com/?cid=controlled-photo-3",
          },
        ];
        return googlePhotoOrder.map((index) => photos[index]!);
      },
      async fetchPhotoMedia(photoName, maxWidthPx) {
        mediaReads++;
        mediaRequests.push({ photoName, maxWidthPx });
        if (photoName === missingMediaPhotoName) throw new PlacePhotoNotFoundError();
        return { bytes: new Uint8Array(png), contentType: "image/png" };
      },
    };
    const tripPlaces = new PostgresTripPlaceModule({
      database,
      provider,
      now,
      photoCapabilitySecret,
    });
    app = createApp({
      collaboration: new PostgresCollaborationModule(database), dayPlans: unrelatedDayPlanModule, discovery: unrelatedDiscoveryModule,
      identityAccess: new PostgresIdentityAccessModule({ database, now, tokenIssuer: new TokenIssuer("place-detail-integration-secret-at-least-32-bytes") }),
      placeDetails: new PostgresPlaceDetailModule({
        database,
        assetRoot,
        provider,
        now,
        photoCapabilitySecret,
      }),
      rateLimiter: new PostgresRateLimiter(database, "place-detail-rate-secret-at-least-32-bytes", now),
      readiness: new PostgresReadinessProbe(database, now), siteAddress: "https://app.example.test",
      tripWorkspace: new PostgresTripWorkspaceModule({ database, now }), tripSkeleton: new PostgresTripSkeletonModule({ database, now }), tripPlaces,
    });
    tripId = await createTrip(owner.cookie);
    const providerId = `test-garden-${randomUUID()}`;
    place = await addPlace(providerId);
    branch = await addPlace(`test-branch-${randomUUID()}`);
    legacyId = (await database.selectFrom("trip_places").select("legacy_place_id").where("id", "=", place.id).executeTakeFirstOrThrow()).legacy_place_id;
    const run = await database.insertInto("discovery_runs").values({ trip_id: tripId, brief_version: 1, policy_version: "test", model_id: "test",
      status: "completed", search_plan: "{}", error_code: null, created_by: owner.id, completed_at: now() }).returning("id").executeTakeFirstOrThrow();
    const proposal = await database.insertInto("candidate_proposals").values({ trip_id: tripId, run_id: run.id, provider_place_id: providerId,
      name: "同名庭園", place_type: "activity", address: null, latitude: null, longitude: null, source_url: null,
      recommendation: "AI 的推薦原因保留。", matched_needs: "[]", tradeoffs: "[]", unknowns: "[]", status: "pending",
      accepted_trip_place_id: null, decided_by: null, decided_at: null, reopened_at: null, category: null,
    }).returning("id").executeTakeFirstOrThrow();
    proposalId = proposal.id;
    input = manifest(`garden-${randomUUID()}`);
    bindings = { version: 1, bindings: [{ key: input.places[0]!.key, canonicalPlaceId: place.placeId, itineraryPlaceIds: [legacyId] }] };
    await importCuratedPlaceDetails({ database, manifest: input, bindings, assetRoot });
    providerReads = 0;
  });

  afterEach(async () => {
    if (createdTrips.length) await database.deleteFrom("itinerary_items").where("trip_id", "in", createdTrips).execute();
    if (createdTrips.length) await database.deleteFrom("trips").where("id", "in", createdTrips.splice(0)).execute();
    if (canonicalIds.length) await database.deleteFrom("place_identities").where("id", "in", canonicalIds.splice(0)).execute();
    if (createdUsers.length) await database.deleteFrom("users").where("id", "in", createdUsers.splice(0)).execute();
    if (assetRoot) await rm(assetRoot, { recursive: true, force: true });
  });
  afterAll(async () => { await database.destroy(); });

  async function detail(reference: PlaceDetailReference, date = "2026-10-15") {
    const response = await app.request(`/api/trips/${tripId}/place-details?kind=${reference.kind}&id=${reference.id}&date=${date}`, { headers: { cookie: owner.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("vary")).toBe("Cookie");
    return parsePlaceDetailResponse(await response.json()).detail;
  }

  it("keeps Google first in detail and curated list photos while preserving same-name distinctions and planning state", async () => {
    const before = await (await app.request(`/api/trips/${tripId}/skeleton`, { headers: { cookie: owner.cookie } })).json();
    const wishlistBefore = await (await app.request(`/api/trips/${tripId}/trip-places`, { headers: { cookie: owner.cookie } })).json();
    const references: PlaceDetailReference[] = [{ kind: "trip-place", id: place.id }, { kind: "proposal", id: proposalId }, { kind: "itinerary-place", id: legacyId }];
    for (const reference of references) {
      const result = await detail(reference);
      expect(result.canonicalPlaceId).toBe(place.placeId);
      expect(result.sections[0]?.blocks[0]?.text).toBe("庭園有可參觀的東側步道。");
      expect(result.photos).toEqual([]);
      expect(result.googlePhotos).toHaveLength(2);
    }
    await database.updateTable("candidate_proposals").set({ status: "accepted", accepted_trip_place_id: place.id, decided_by: owner.id, decided_at: now() })
      .where("id", "=", proposalId).execute();
    expect((await detail({ kind: "proposal", id: proposalId })).canonicalPlaceId).toBe(place.placeId);
    expect(providerReads).toBe(4);
    const other = await detail({ kind: "trip-place", id: branch.id });
    expect(other.canonicalPlaceId).toBe(branch.placeId);
    expect(other.sections).toEqual([]);
    expect(other.photos).toEqual([]);
    expect(other.googlePhotos).toHaveLength(2);
    expect(other.googlePhotos.map(({ index, authors, googleMapsUri }) => ({
      index, author: authors[0]?.displayName, googleMapsUri,
    }))).toEqual([
      { index: 0, author: "Google 攝影者", googleMapsUri: "https://maps.google.com/?cid=controlled-photo" },
      { index: 1, author: "Google 攝影者二", googleMapsUri: "https://maps.google.com/?cid=controlled-photo-2" },
    ]);
    expect(other.googlePhotos[0]?.imageUrl).not.toContain("server-only");
    const previews = await app.request(`/api/trips/${tripId}/place-previews?kind=trip-place&ids=${branch.id},${place.id}`, { headers: { cookie: owner.cookie } });
    expect(previews.headers.get("cache-control")).toBe("private, max-age=3600");
    const parsed = parsePlacePreviewResponse(await previews.json()).previews;
    expect(parsed.map((item) => item.reference.id)).toEqual([branch.id, place.id]);
    expect(parsed[0]).toMatchObject({ photo: null, photoCount: 0 });
    expect(parsed[1]).toMatchObject({ photo: { source: "curated", id: "original-test-pixel" }, photoCount: 1 });
    const image = await app.request(parsed[1]!.photo!.imageUrl, { headers: { cookie: owner.cookie } });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer()).equals(png)).toBe(true);
    expect(providerReads).toBe(5);
    expect(await (await app.request(`/api/trips/${tripId}/skeleton`, { headers: { cookie: owner.cookie } })).json()).toEqual(before);
    const wishlistAfter = await (await app.request(`/api/trips/${tripId}/trip-places`, { headers: { cookie: owner.cookie } })).json();
    // Acceptance deliberately changes the proposal pointer only; member notes/votes/schedules remain intact.
    expect(wishlistAfter.tripPlaces.map(({ aiProposalId: _id, ...rest }: TripPlaceDto) => rest))
      .toEqual(wishlistBefore.tripPlaces.map(({ aiProposalId: _id, ...rest }: TripPlaceDto) => rest));
  });

  it("never asks Google for a preview batch, even when a provider lookup would fail", async () => {
    failedProviderPhotoId = branch.providerPlaceId;
    const response = await app.request(
      `/api/trips/${tripId}/place-previews?kind=trip-place&ids=${branch.id},${place.id}`,
      { headers: { cookie: owner.cookie } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    const previews = parsePlacePreviewResponse(await response.json()).previews;
    expect(previews[0]?.photo).toBeNull();
    expect(previews[1]?.photo).toMatchObject({ source: "curated", id: "original-test-pixel" });
    expect(providerReads).toBe(0);
  });

  it.each(["trip-place", "proposal", "itinerary-place"] as const)("never returns a Google photo from a %s preview", async (kind) => {
    await database.deleteFrom("curated_place_photos").where("place_id", "=", place.placeId).execute();
    const id = kind === "trip-place" ? place.id : kind === "proposal" ? proposalId : legacyId;
    const response = await app.request(`/api/trips/${tripId}/place-previews?kind=${kind}&ids=${id}`, {
      headers: { cookie: owner.cookie },
    });
    expect(response.status).toBe(200);
    expect(parsePlacePreviewResponse(await response.json()).previews).toEqual([
      { reference: { kind, id }, photo: null, photoCount: 0 },
    ]);
    expect(providerReads).toBe(0);
    expect(mediaReads).toBe(0);
  });

  it("caps curated detail fallback at two without changing the preview count when Google returns no photos", async () => {
    googlePhotoOrder = [];
    const first = input.places[0]!.photos[0]!;
    await database.insertInto("curated_place_photos").values([1, 2, 3].map((position) => ({
      place_id: place.placeId,
      work_id: `curated-work-${position}`,
      position,
      metadata: JSON.stringify({
        ...first,
        id: `curated-work-${position}`,
        sourceUrl: `https://example.test/works/pixel-${position}`,
        verificationUrl: `https://example.test/works/pixel-${position}?revision=1`,
        image: {
          ...first.image,
          sha256: String(position).repeat(64),
          filename: `${String(position).repeat(64)}.png`,
        },
      }),
      image_filename: filename,
      thumbnail_filename: filename,
    }))).execute();

    const result = await detail({ kind: "trip-place", id: place.id });
    expect(result.photos.map((photo) => photo.id)).toEqual([
      "original-test-pixel", "curated-work-1",
    ]);
    expect(result.googlePhotos).toEqual([]);
    const response = await app.request(
      `/api/trips/${tripId}/place-previews?kind=trip-place&ids=${place.id}`,
      { headers: { cookie: owner.cookie } },
    );
    expect(parsePlacePreviewResponse(await response.json()).previews[0]).toMatchObject({
      photo: { id: "original-test-pixel" },
      photoCount: 3,
    });
    expect(providerReads).toBe(1);
  });

  it("serves a signed search-result photo only to the member who received its capability", async () => {
    const searchResponse = await app.request(`/api/trips/${tripId}/trip-places/search`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        "content-type": "application/json",
        origin: "https://app.example.test",
      },
      body: JSON.stringify({ query: "未加入地點" }),
    });
    expect(searchResponse.status).toBe(200);
    const candidate = parseProviderCandidatesResponse(await searchResponse.json()).candidates[0]!;
    expect(candidate.providerPlaceId).toBe(unassociatedSearchPlaceId);
    expect(candidate.photo?.thumbnailUrl).toMatch(/&exp=[1-9][0-9]{9}&sig=[A-Za-z0-9_-]{43}$/);

    const thumbnailUrl = candidate.photo!.thumbnailUrl;
    const photo = await app.request(thumbnailUrl, { headers: { cookie: owner.cookie } });
    expect(photo.status).toBe(200);
    expect(Buffer.from(await photo.arrayBuffer()).equals(png)).toBe(true);

    await createTrip(outsider.cookie);
    expect((await app.request(thumbnailUrl, { headers: { cookie: outsider.cookie } })).status).toBe(404);
    await database.insertInto("trip_members").values({
      trip_id: tripId,
      user_id: outsider.id,
      role: "editor",
      removed_at: null,
    }).execute();
    expect((await app.request(thumbnailUrl, { headers: { cookie: outsider.cookie } })).status).toBe(404);

    const readsBeforeTampering = providerReads;
    const signatureTampered = new URL(thumbnailUrl, "https://app.example.test");
    const signature = signatureTampered.searchParams.get("sig")!;
    signatureTampered.searchParams.set("sig", `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`);
    expect((await app.request(`${signatureTampered.pathname}${signatureTampered.search}`, {
      headers: { cookie: owner.cookie },
    })).status).toBe(404);

    const indexTampered = new URL(thumbnailUrl, "https://app.example.test");
    indexTampered.searchParams.set("index", "1");
    expect((await app.request(`${indexTampered.pathname}${indexTampered.search}`, {
      headers: { cookie: owner.cookie },
    })).status).toBe(404);

    const fingerprintTampered = new URL(thumbnailUrl, "https://app.example.test");
    const fingerprint = fingerprintTampered.searchParams.get("photo")!;
    fingerprintTampered.searchParams.set("photo", `${fingerprint.startsWith("a") ? "b" : "a"}${fingerprint.slice(1)}`);
    expect((await app.request(`${fingerprintTampered.pathname}${fingerprintTampered.search}`, {
      headers: { cookie: owner.cookie },
    })).status).toBe(404);
    expect(providerReads).toBe(readsBeforeTampering);
    expect(mediaReads).toBe(1);

    const expired = Math.floor(now().getTime() / 1_000) - 1;
    const expiredUrl = new URL(thumbnailUrl, "https://app.example.test");
    expiredUrl.searchParams.set("exp", String(expired));
    expiredUrl.searchParams.set("sig", new TokenIssuer(photoCapabilitySecret).issue(
      `${tripId}|${owner.id}|${candidate.providerPlaceId}|0|${fingerprint}|places/${candidate.providerPlaceId}/photos/${expiredUrl.searchParams.get("resource")}|${expired}`,
    ));
    expect((await app.request(`${expiredUrl.pathname}${expiredUrl.search}`, {
      headers: { cookie: owner.cookie },
    })).status).toBe(404);
    expect(providerReads).toBe(readsBeforeTampering);
  });

  it("does not consume the detail photo allowance for previews and exposes a rate-limited detail failure", async () => {
    const secret = "place-detail-rate-secret-at-least-32-bytes";
    const scope = "place_photo_metadata:account";
    await database.insertInto("rate_limit_windows").values({
      scope,
      key_hash: createHmac("sha256", Buffer.from(secret)).update(`${scope}:${owner.id}`).digest("hex"),
      window_start: new Date("2026-10-09T12:00:00.000Z"),
      request_count: 299,
    }).execute();

    // Previews no longer consume the final metadata unit.
    const previewResponse = await app.request(
      `/api/trips/${tripId}/place-previews?kind=trip-place&ids=${branch.id},${place.id}`,
      { headers: { cookie: owner.cookie } },
    );
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.headers.get("cache-control")).toBe("private, max-age=3600");
    const previews = parsePlacePreviewResponse(await previewResponse.json()).previews;
    expect(previews[0]).toMatchObject({ photo: null, photoCount: 0 });
    expect(previews[1]).toMatchObject({ photo: { source: "curated", id: "original-test-pixel" }, photoCount: 1 });
    expect(providerReads).toBe(0);
    const lastAllowed = await detail({ kind: "trip-place", id: branch.id });
    expect(lastAllowed.googlePhotos).toHaveLength(2);
    expect(lastAllowed.photosUnavailable).toBe(false);

    const detailResponse = await app.request(
      `/api/trips/${tripId}/place-details?kind=trip-place&id=${branch.id}`,
      { headers: { cookie: owner.cookie } },
    );
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(parsePlaceDetailResponse(await detailResponse.json()).detail).toMatchObject({
      googlePhotos: [], photosUnavailable: true,
    });
    expect(providerReads).toBe(1);
  });

  it("returns a Google photo for an uncurated proposal without a place identity and proxies its bytes privately", async () => {
    const source = await database.selectFrom("candidate_proposals").select("run_id").where("id", "=", proposalId).executeTakeFirstOrThrow();
    const providerPlaceId = `proposal-photo-${randomUUID()}`;
    const proposal = await database.insertInto("candidate_proposals").values({
      trip_id: tripId,
      run_id: source.run_id,
      provider_place_id: providerPlaceId,
      name: "尚未接受的提案",
      place_type: "activity",
      address: null,
      latitude: null,
      longitude: null,
      source_url: null,
      recommendation: "未建立 place identity 也能顯示照片。",
      matched_needs: "[]",
      tradeoffs: "[]",
      unknowns: "[]",
      status: "pending",
      accepted_trip_place_id: null,
      decided_by: null,
      decided_at: null,
      reopened_at: null,
      category: null,
    }).returning("id").executeTakeFirstOrThrow();

    const result = await detail({ kind: "proposal", id: proposal.id });
    expect(result.canonicalPlaceId).toBeNull();
    expect(result.photos).toEqual([]);
    expect(result.googlePhotos).toHaveLength(2);
    expect(result.googlePhotos[1]).toMatchObject({
      source: "google",
      index: 1,
      authors: [{ displayName: "Google 攝影者二", uri: "https://example.test/google-author-2" }],
    });
    const photoUrl = result.googlePhotos[1]!.imageUrl;
    const metadataReads = providerReads;
    expect((await app.request(photoUrl)).status).toBe(401);
    expect((await app.request(photoUrl, { headers: { cookie: outsider.cookie } })).status).toBe(404);
    const photo = await app.request(photoUrl, { headers: { cookie: owner.cookie } });
    expect(photo.status).toBe(200);
    expect(photo.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(photo.headers.get("x-content-type-options")).toBe("nosniff");
    expect(photo.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await photo.arrayBuffer()).equals(png)).toBe(true);
    expect(mediaReads).toBe(1);
    expect(mediaRequests).toEqual([{
      photoName: `places/${providerPlaceId}/photos/controlled-photo-2`,
      maxWidthPx: 1024,
    }]);
    expect(providerReads).toBe(metadataReads);
  });

  it("rejects tampered signed fields and keeps issued resources valid when Google metadata order changes", async () => {
    const result = await detail({ kind: "trip-place", id: branch.id });
    const readsBeforeValidation = providerReads;
    const missingIndexUrl = new URL(result.googlePhotos[0]!.imageUrl, "https://app.example.test");
    missingIndexUrl.searchParams.delete("index");
    const missingIndex = await app.request(`${missingIndexUrl.pathname}${missingIndexUrl.search}`, {
      headers: { cookie: owner.cookie },
    });
    expect(missingIndex.status).toBe(404);
    expect(await missingIndex.json()).toMatchObject({ error: { code: "place_photo_not_found" } });
    const malformedIndexUrl = new URL(result.googlePhotos[0]!.imageUrl, "https://app.example.test");
    malformedIndexUrl.searchParams.set("index", "01");
    expect((await app.request(`${malformedIndexUrl.pathname}${malformedIndexUrl.search}`, {
      headers: { cookie: owner.cookie },
    })).status).toBe(400);
    expect(providerReads).toBe(readsBeforeValidation);

    const indexOneUrl = new URL(result.googlePhotos[1]!.imageUrl, "https://app.example.test");
    const indexZeroFingerprint = new URL(result.googlePhotos[0]!.imageUrl, "https://app.example.test").searchParams.get("photo")!;
    indexOneUrl.searchParams.set("photo", indexZeroFingerprint);
    const metadataReads = providerReads;
    expect((await app.request(`${indexOneUrl.pathname}${indexOneUrl.search}`, {
      headers: { cookie: owner.cookie },
    })).status).toBe(404);
    expect(mediaRequests).toEqual([]);
    expect(providerReads).toBe(metadataReads);

    const resourceTampered = new URL(result.googlePhotos[1]!.imageUrl, "https://app.example.test");
    resourceTampered.searchParams.set("resource", "other-photo");
    expect((await app.request(`${resourceTampered.pathname}${resourceTampered.search}`, {
      headers: { cookie: owner.cookie },
    })).status).toBe(404);
    expect(mediaRequests).toEqual([]);

    googlePhotoOrder = [1, 0, 2];
    expect((await app.request(result.googlePhotos[1]!.imageUrl, { headers: { cookie: owner.cookie } })).status).toBe(200);
    googlePhotoOrder = [1];
    expect((await app.request(result.googlePhotos[0]!.imageUrl, { headers: { cookie: owner.cookie } })).status).toBe(200);
    expect(mediaRequests).toEqual([
      { photoName: `places/${branch.providerPlaceId}/photos/controlled-photo-2`, maxWidthPx: 1024 },
      { photoName: `places/${branch.providerPlaceId}/photos/controlled-photo`, maxWidthPx: 1024 },
    ]);
    expect(providerReads).toBe(metadataReads);
  });

  it("fetches the originally signed resource rather than a newly returned author's photo", async () => {
    const result = await detail({ kind: "trip-place", id: branch.id });
    const metadataReads = providerReads;
    currentPhotoToken = "different-photo";
    currentPhotoAuthors = [{ displayName: "另一位攝影者", uri: "https://example.test/another-author" }];
    const photo = await app.request(result.googlePhotos[0]!.imageUrl, { headers: { cookie: owner.cookie } });
    expect(photo.status).toBe(200);
    expect(mediaRequests).toEqual([{
      photoName: `places/${branch.providerPlaceId}/photos/controlled-photo`,
      maxWidthPx: 1024,
    }]);
    expect(providerReads).toBe(metadataReads);
  });

  it("maps an expired matching Google media resource to not found", async () => {
    const result = await detail({ kind: "trip-place", id: branch.id });
    missingMediaPhotoName = `places/${branch.providerPlaceId}/photos/${currentPhotoToken}`;
    const photo = await app.request(result.googlePhotos[0]!.imageUrl, { headers: { cookie: owner.cookie } });
    expect(photo.status).toBe(404);
    expect(await photo.json()).toMatchObject({ error: { code: "place_photo_not_found" } });
    expect(mediaRequests).toEqual([{
      photoName: missingMediaPhotoName,
      maxWidthPx: 1024,
    }]);
  });

  it("rejects a Google photo ID that has no association with the authorized trip", async () => {
    const providerPlaceId = `unrelated-photo-${randomUUID()}`;
    const fingerprint = googlePlacePhotoFingerprint({
      name: `places/${providerPlaceId}/photos/${currentPhotoToken}`,
      width: 1600,
      height: 1200,
      authors: currentPhotoAuthors,
      googleMapsUri: "https://maps.google.com/?cid=controlled-photo",
    });
    const metadataReads = providerReads;
    const response = await app.request(
      `/api/trips/${tripId}/google-place-photos/${providerPlaceId}?index=0&photo=${fingerprint}&resource=${currentPhotoToken}&maxWidth=1024`,
      { headers: { cookie: owner.cookie } },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "place_photo_not_found" } });
    expect(providerReads).toBe(metadataReads);
    expect(mediaReads).toBe(0);
  });

  it("rate-limits the Google photo proxy after the hourly account allowance", async () => {
    const result = await detail({ kind: "trip-place", id: branch.id });
    const secret = "place-detail-rate-secret-at-least-32-bytes";
    const scope = "place_photo:account";
    await database.insertInto("rate_limit_windows").values({
      scope,
      key_hash: createHmac("sha256", Buffer.from(secret)).update(`${scope}:${owner.id}`).digest("hex"),
      window_start: new Date("2026-10-09T12:00:00.000Z"),
      request_count: 600,
    }).execute();
    const limited = await app.request(result.googlePhotos[0]!.imageUrl, { headers: { cookie: owner.cookie } });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(mediaReads).toBe(0);
  });

  it("does not disclose details, previews, or photo bytes outside the authorized trip/reference", async () => {
    googlePhotoOrder = [];
    const result = await detail({ kind: "trip-place", id: place.id });
    const url = `/api/trips/${tripId}/place-details?kind=trip-place&id=${place.id}`;
    const previewUrl = `/api/trips/${tripId}/place-previews?kind=trip-place&ids=${place.id}`;
    for (const endpoint of [url, previewUrl, result.photos[0]!.imageUrl]) {
      expect((await app.request(endpoint)).status).toBe(401);
      expect((await app.request(endpoint, { headers: { cookie: outsider.cookie } })).status).toBe(404);
    }
    const otherTrip = await createTrip(owner.cookie);
    for (const endpoint of [url, previewUrl, result.photos[0]!.imageUrl]) {
      expect((await app.request(endpoint.replace(tripId, otherTrip), { headers: { cookie: owner.cookie } })).status).toBe(404);
    }
    expect((await app.request(result.photos[0]!.imageUrl.replace(place.id, branch.id), { headers: { cookie: owner.cookie } })).status).toBe(404);
    expect((await app.request(url.replace(place.id, place.placeId), { headers: { cookie: owner.cookie } })).status).toBe(404);
    await database.updateTable("trip_members").set({ removed_at: now() }).where("trip_id", "=", tripId).where("user_id", "=", owner.id).execute();
    expect((await app.request(result.photos[0]!.imageUrl, { headers: { cookie: owner.cookie } })).status).toBe(404);
  });

  it("leaves unidentified manual and unassociated travel places honest instead of guessing a canonical identity", async () => {
    const created = await app.request(`/api/trips/${tripId}/trip-places`, { method: "POST", headers: {
      cookie: owner.cookie, "content-type": "application/json", origin: "https://app.example.test", "idempotency-key": randomUUID(),
    }, body: JSON.stringify({ method: "manual", name: "沿途看到的咖啡店", type: "restaurant" }) });
    expect(created.status).toBe(201);
    const unknown = parseTripPlaceResponse(await created.json()).tripPlace;
    canonicalIds.push(unknown.placeId);
    expect(await detail({ kind: "trip-place", id: unknown.id })).toMatchObject({
      name: "沿途看到的咖啡店", photos: [], googlePhotos: [], sections: [], sources: [],
    });
    const travel = await database.selectFrom("places").select("id")
      .where("trip_id", "=", tripId).where("travel_only", "=", true).executeTakeFirstOrThrow();
    expect(await detail({ kind: "itinerary-place", id: travel.id })).toMatchObject({
      canonicalPlaceId: null, photos: [], googlePhotos: [], sections: [], sources: [],
    });
    const unassociated = structuredClone(bindings);
    unassociated.bindings[0]!.itineraryPlaceIds = [travel.id];
    await expect(importCuratedPlaceDetails({ database, manifest: input, bindings: unassociated, assetRoot }))
      .rejects.toThrow("existing canonical association");
  });

  it("keeps observed dates, unknowns, conflicts, inclusive applicability and expiry deterministic", async () => {
    for (const date of ["2026-10-01", "2026-10-31"]) {
      const result = await detail({ kind: "trip-place", id: place.id }, date);
      expect(result.sections[0]?.blocks[0]?.needsRecheck).toBe(false);
      expect(result.sections[1]?.blocks[0]).toMatchObject({ certainty: "conflicted", needsRecheck: true, sourceIds: ["official", "old-guide"] });
      expect(result.sections[1]?.blocks[1]).toMatchObject({ certainty: "unknown", needsRecheck: false });
      expect(result.sources[0]?.checkedAt).toBe("2026-10-01T08:00:00Z");
    }
    for (const date of ["2026-09-30", "2026-11-01"]) {
      expect((await detail({ kind: "trip-place", id: place.id }, date)).sections[0]?.blocks[0]?.needsRecheck).toBe(true);
    }
    const invalid = await app.request(`/api/trips/${tripId}/place-details?kind=trip-place&id=${place.id}&date=2026-02-30`, { headers: { cookie: owner.cookie } });
    expect(invalid.status).toBe(400);
    for (const ids of [`${place.id},`, `${place.id},${place.id}`, "not-an-id"]) {
      expect((await app.request(`/api/trips/${tripId}/place-previews?kind=trip-place&ids=${ids}`, { headers: { cookie: owner.cookie } })).status).toBe(400);
    }
  });

  it("marks the published Kiyomizu seasonal hours for recheck outside each event period", async () => {
    const catalog = JSON.parse(await readFile(new URL("../data/place-details/initial-places.json", import.meta.url), "utf8")) as CuratedPlaceManifest;
    const seasonalPlace = catalog.places.find((entry) => entry.key === "kiyomizu")!;
    await importCuratedPlaceDetails({
      database,
      manifest: { version: 1, places: [{ ...seasonalPlace, key: input.places[0]!.key, photos: [] }] },
      bindings,
      assetRoot,
    });
    for (const [date, expected] of [
      ["2026-09-01", [false, true]],
      ["2026-10-21", [false, true]],
      ["2026-11-20", [false, true]],
      ["2026-11-21", [true, false]],
      ["2026-11-30", [true, false]],
      ["2026-12-01", [true, true]],
    ] as const) {
      const result = await detail({ kind: "trip-place", id: place.id }, date);
      expect(result.sections.find((section) => section.kind === "hours")!.blocks.map((block) => block.needsRecheck)).toEqual(expected);
    }
  });

  it("repeats imports safely, replaces rather than appends, and keeps errors atomic", async () => {
    googlePhotoOrder = [];
    const reference: PlaceDetailReference = { kind: "trip-place", id: place.id };
    const before = await detail(reference);
    await importCuratedPlaceDetails({ database, manifest: input, bindings, assetRoot });
    expect(await detail(reference)).toEqual(before);
    const invalid = structuredClone(input);
    invalid.places[0]!.sections[0]!.blocks[0]!.sourceIds = ["not-present"];
    await expect(importCuratedPlaceDetails({ database, manifest: invalid, bindings, assetRoot })).rejects.toThrow("source references");
    const badDimensions = structuredClone(input);
    badDimensions.places[0]!.photos[0]!.image.width = 2;
    badDimensions.places[0]!.photos[0]!.originalWidth = 2;
    await expect(importCuratedPlaceDetails({ database, manifest: badDimensions, bindings, assetRoot })).rejects.toThrow("dimensions");
    const wrongBinding = structuredClone(bindings);
    wrongBinding.bindings[0]!.canonicalPlaceId = branch.placeId;
    await expect(importCuratedPlaceDetails({ database, manifest: input, bindings: wrongBinding, assetRoot })).rejects.toThrow();
    const lateFailure = structuredClone(input);
    lateFailure.places[0]!.sections[0]!.blocks[0]!.text = "這段不能部分發布。";
    lateFailure.places.push({ key: "missing-identity", name: "不存在的綁定", sections: [], sources: [], photos: [] });
    const lateBindings = structuredClone(bindings);
    lateBindings.bindings.push({ key: "missing-identity", canonicalPlaceId: randomUUID(), itineraryPlaceIds: [] });
    await expect(importCuratedPlaceDetails({ database, manifest: lateFailure, bindings: lateBindings, assetRoot })).rejects.toThrow("does not exist");
    expect(await detail(reference)).toEqual(before);
    input.places[0]!.photos = [];
    input.places[0]!.sections = [{ kind: "notices", title: "參觀注意事項", blocks: [{ text: "開放情況尚未確認。", style: "paragraph", sourceIds: [], certainty: "unknown" }] }];
    await importCuratedPlaceDetails({ database, manifest: input, bindings, assetRoot });
    const replaced = await detail(reference);
    expect(replaced.photos).toEqual([]);
    expect(replaced.sections.map((section) => section.kind)).toEqual(["notices"]);
    expect((await app.request(before.photos[0]!.imageUrl, { headers: { cookie: owner.cookie } })).status).toBe(404);
  });

  it("fails honestly when packaged bytes are missing or altered without blocking text reads", async () => {
    googlePhotoOrder = [];
    const result = await detail({ kind: "trip-place", id: place.id });
    await writeFile(join(assetRoot, filename), Buffer.from("not the reviewed image"));
    await expect(importCuratedPlaceDetails({ database, manifest: input, bindings, assetRoot })).rejects.toThrow("checksum");
    await rm(join(assetRoot, filename));
    expect((await app.request(result.photos[0]!.imageUrl, { headers: { cookie: owner.cookie } })).status).toBe(404);
    expect((await detail({ kind: "trip-place", id: place.id })).sections[0]?.blocks[0]?.text).toBe("庭園有可參觀的東側步道。");
  });
});
