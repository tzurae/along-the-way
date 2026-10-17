import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { sql, type Kysely } from "kysely";
import { parsePlaceDetailResponse, parsePlacePreviewResponse } from "@along-the-way/contracts/place-details";
import { parseTripResponse } from "@along-the-way/contracts/private-trips";
import { parseTripPlaceListResponse, parseTripPlaceResponse, type ProviderPlaceCandidateDto, type TripPlaceDto } from "@along-the-way/contracts/trip-places";
import { createApp } from "../src/app";
import { createDatabase, type AlongTheWayDatabase } from "../src/database/database";
import { runMigrations } from "../src/database/migrate";
import { CommonsPlacePhotos } from "../src/place-details/commons-place-photos";
import { PostgresPlaceDetailModule } from "../src/place-details/postgres-place-detail-module";
import { PostgresCollaborationModule } from "../src/private-trips/postgres-collaboration-module";
import { PostgresIdentityAccessModule } from "../src/private-trips/postgres-identity-access-module";
import { PostgresRateLimiter } from "../src/private-trips/postgres-rate-limiter";
import { PostgresRapidApiKeysModule } from "../src/private-trips/postgres-rapidapi-keys-module";
import { RapidApiKeyCipher } from "../src/private-trips/rapidapi-key-cipher";
import { PostgresReadinessProbe } from "../src/private-trips/postgres-readiness-probe";
import { PostgresTripWorkspaceModule } from "../src/private-trips/postgres-trip-workspace-module";
import { hashToken, TokenIssuer } from "../src/private-trips/token-issuer";
import { PostgresTripSkeletonModule } from "../src/trip-skeleton/postgres-trip-skeleton-module";
import { PostgresTripPlaceModule } from "../src/trip-places/postgres-trip-place-module";
import type { PlaceProvider } from "../src/trip-places/google-places-provider";
import { unrelatedDayPlanModule } from "./day-plan-test-support";
import { unrelatedDiscoveryModule } from "./discovery-test-support";
import { tripFlights } from "./travel-test-support";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required; use an isolated verification database");
const now = () => new Date("2026-10-13T12:00:00.000Z");

interface WikimediaScenario {
  /** Wikidata items registered with the CID (P3749). */
  items: readonly string[];
  license: string;
  failing?: boolean;
}

// Controlled Wikidata, Commons and upload.wikimedia.org responses keyed by Google CID.
function wikimedia(scenarios: Map<string, WikimediaScenario>, requests: string[], beforeDownload: () => Promise<void> | undefined) {
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8" } });
  const scenarioFor = (value: string) => [...scenarios.entries()].find(([cid]) => value.includes(cid))?.[1];
  let currentScenario: WikimediaScenario | undefined;
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requests.push(url.hostname);
    if (url.hostname === "www.wikidata.org" && url.searchParams.get("list") === "search") {
      currentScenario = scenarioFor(url.searchParams.get("srsearch") ?? "");
      if (currentScenario?.failing) return new Response("busy", { status: 429, headers: { "content-type": "text/html" } });
      return json({ query: { search: (currentScenario?.items ?? []).map((title) => ({ title })) } });
    }
    if (url.hostname === "www.wikidata.org" && url.searchParams.get("action") === "wbgetclaims") {
      return json({ claims: { P18: [{ rank: "normal", mainsnak: { datavalue: { value: "Controlled shrine.jpg" } } }] } });
    }
    if (url.hostname === "commons.wikimedia.org" && url.searchParams.get("prop") === "imageinfo|revisions") {
      return json({ query: { pages: [{ pageid: 424242, title: "File:Controlled shrine.jpg", revisions: [{ revid: 777 }], imageinfo: [{
        width: 4000, height: 3000, mime: "image/jpeg",
        url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Controlled_shrine.jpg",
        descriptionurl: "https://commons.wikimedia.org/wiki/File:Controlled_shrine.jpg",
        extmetadata: {
          License: { value: currentScenario?.license ?? "cc0" },
          LicenseShortName: { value: currentScenario?.license === "cc0" ? "CC0" : "Copyrighted" },
          LicenseUrl: { value: "https://creativecommons.org/publicdomain/zero/1.0/" },
          Artist: { value: "<a href=\"//commons.wikimedia.org/wiki/User:Tester\">Tester</a>" },
          ImageDescription: { value: "<p>Controlled test work.</p>" },
          DateTimeOriginal: { value: "2020-05-01 10:00:00" },
        },
      }] }] } });
    }
    if (url.hostname === "commons.wikimedia.org") {
      const width = Number(url.searchParams.get("iiurlwidth"));
      return json({ query: { pages: [{ imageinfo: [{
        thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Controlled_shrine.jpg/${width}px-Controlled_shrine.jpg`,
        thumbwidth: width, thumbheight: Math.round(width * 3 / 4),
      }] }] } });
    }
    if (url.hostname === "upload.wikimedia.org") {
      await beforeDownload();
      return new Response(new TextEncoder().encode(`controlled bytes ${url.pathname}`), { headers: { "content-type": "image/jpeg" } });
    }
    return new Response("unexpected", { status: 404 });
  };
}

describe("Commons representative photos chosen by Google CID at intake", () => {
  let database: Kysely<AlongTheWayDatabase>;
  let app: Hono;
  let assetRoot: string;
  let cookie: string;
  let tripId: string;
  let googlePhotoReads: number;
  let wikimediaRequests: string[];
  let scenarios: Map<string, WikimediaScenario>;
  let duringDownload: (() => Promise<void>) | null;
  const createdTrips: string[] = [];
  const createdUsers: string[] = [];
  const canonicalIds: string[] = [];

  beforeAll(async () => {
    database = createDatabase(databaseUrl);
    await runMigrations(database);
  });

  beforeEach(async () => {
    assetRoot = await mkdtemp("/tmp/along-commons-photo-test-");
    googlePhotoReads = 0;
    wikimediaRequests = [];
    scenarios = new Map();
    duringDownload = null;
    const provider: PlaceProvider = {
      available: true,
      attribution: "Controlled provider",
      async search() { return []; },
      async getPlace(providerPlaceId): Promise<ProviderPlaceCandidateDto> {
        const cid = /cid([0-9]+)$/.exec(providerPlaceId)?.[1] ?? "";
        return { provider: "google", providerPlaceId, name: "受控神社", type: "activity", typeLabel: null, address: "測試地址",
          latitude: 35, longitude: 135, timeZone: "Asia/Tokyo", sourceUrl: `https://maps.google.com/?cid=${cid}&g_mp=controlled`,
          attribution: "Controlled provider", observedAt: "2026-10-13T00:00:00Z", expiresAt: "2026-11-12T00:00:00Z", photo: null };
      },
      async getPhotos() {
        googlePhotoReads++;
        return [];
      },
    };
    const tripPlaces = new PostgresTripPlaceModule({
      database, provider, now,
      commonsPhotos: new CommonsPlacePhotos({ now, userAgent: "AlongTheWayTest/0 (https://example.test)",
        fetch: wikimedia(scenarios, wikimediaRequests, () => duringDownload?.()) }),
    });
    app = createApp({
      rapidApiKeys: new PostgresRapidApiKeysModule(database, new RapidApiKeyCipher(Buffer.alloc(32, 7).toString("base64"))),
      collaboration: new PostgresCollaborationModule(database), dayPlans: unrelatedDayPlanModule, discovery: unrelatedDiscoveryModule,
      identityAccess: new PostgresIdentityAccessModule({ database, now, tokenIssuer: new TokenIssuer("commons-photo-integration-secret-at-least-32-bytes") }),
      placeDetails: new PostgresPlaceDetailModule({ database, assetRoot, provider, now }),
      rateLimiter: new PostgresRateLimiter(database, "commons-photo-rate-secret-at-least-32-bytes", now),
      readiness: new PostgresReadinessProbe(database, now), siteAddress: "https://app.example.test",
      tripWorkspace: new PostgresTripWorkspaceModule({ database, now }), tripSkeleton: new PostgresTripSkeletonModule({ database, now }), tripPlaces,
    });
    const token = randomUUID();
    const user = await database.insertInto("users").values({ email: `${token}@example.test`, display_name: "測試成員", status: "active" })
      .returning("id").executeTakeFirstOrThrow();
    createdUsers.push(user.id);
    await database.insertInto("sessions").values({ user_id: user.id, token_hash: hashToken(token),
      expires_at: "2026-11-01T00:00:00Z", last_seen_at: now(), revoked_at: null }).execute();
    cookie = `__Host-along_the_way_session=${token}`;
    const response = await app.request("/api/trips", { method: "POST", headers: {
      cookie, "content-type": "application/json", origin: "https://app.example.test", "idempotency-key": randomUUID(),
    }, body: JSON.stringify({ name: `Commons 照片驗證 ${randomUUID()}`, startDate: "2026-10-20", endDate: "2026-10-22",
      countryCodes: ["JP"], flights: tripFlights("2026-10-20", "2026-10-22", "Asia/Tokyo") }) });
    expect(response.status).toBe(201);
    tripId = parseTripResponse(await response.json()).trip.id;
    createdTrips.push(tripId);
  });

  afterEach(async () => {
    if (createdTrips.length) await database.deleteFrom("itinerary_items").where("trip_id", "in", createdTrips).execute();
    if (createdTrips.length) await database.deleteFrom("trips").where("id", "in", createdTrips.splice(0)).execute();
    if (canonicalIds.length) await database.deleteFrom("place_identities").where("id", "in", canonicalIds.splice(0)).execute();
    if (createdUsers.length) await database.deleteFrom("users").where("id", "in", createdUsers.splice(0)).execute();
    // Deleting a place identity cascades to its Commons photo row but not to the shared blobs.
    await sql`delete from place_photo_blobs blob where not exists (
      select 1 from commons_place_photos photo where blob.filename in (photo.image_filename, photo.thumbnail_filename))`.execute(database);
    await rm(assetRoot, { recursive: true, force: true });
  });
  afterAll(async () => { await database.destroy(); });

  async function addPlace(cid: string): Promise<TripPlaceDto> {
    const response = await app.request(`/api/trips/${tripId}/trip-places`, { method: "POST", headers: {
      cookie, "content-type": "application/json", origin: "https://app.example.test", "idempotency-key": randomUUID(),
    }, body: JSON.stringify({ method: "search", providerPlaceId: `controlled-${randomUUID()}-cid${cid}` }) });
    expect(response.status).toBe(201);
    const place = parseTripPlaceResponse(await response.json()).tripPlace;
    canonicalIds.push(place.placeId);
    return place;
  }

  async function preview(place: TripPlaceDto) {
    const response = await app.request(`/api/trips/${tripId}/place-previews?kind=trip-place&ids=${place.id}`, { headers: { cookie } });
    expect(response.status).toBe(200);
    return parsePlacePreviewResponse(await response.json()).previews[0]!;
  }

  it("stores a uniquely matched, freely licensed photo and serves it without any Google photo call", async () => {
    const cid = `${Date.now()}1`;
    scenarios.set(cid, { items: ["Q714828"], license: "cc0" });
    const place = await addPlace(cid);
    wikimediaRequests.length = 0;

    const thumbnail = await preview(place);
    expect(thumbnail.photo).toMatchObject({ source: "commons", author: "Tester", licenseName: "CC0", width: 1280, height: 960 });
    expect(thumbnail.photoCount).toBe(1);
    const detailResponse = await app.request(`/api/trips/${tripId}/place-details?kind=trip-place&id=${place.id}`, { headers: { cookie } });
    const detail = parsePlaceDetailResponse(await detailResponse.json()).detail;
    expect(detail.photos.map((photo) => photo.source)).toEqual(["commons"]);
    expect(detail.googlePhotos).toEqual([]);
    expect(detail.photos[0]!.verificationUrl).toBe("https://commons.wikimedia.org/w/index.php?title=File%3AControlled_shrine.jpg&oldid=777");

    const asset = await app.request(thumbnail.photo!.thumbnailUrl, { headers: { cookie } });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("controlled bytes /wikipedia/commons/thumb/a/ab/Controlled_shrine.jpg/330px-Controlled_shrine.jpg");
    expect(googlePhotoReads).toBe(0);
    // Reads come from PostgreSQL: neither Wikimedia nor Google is contacted after intake.
    expect(wikimediaRequests).toEqual([]);
  });

  it("never shows a reader the new place before its Commons photo is stored", async () => {
    const cid = `${Date.now()}5`;
    scenarios.set(cid, { items: ["Q714828"], license: "cc0" });
    // A live-update refresh can list the trip while the intake still waits on Wikimedia.
    let listedDuringLookup: number | null = null;
    duringDownload = async () => {
      const response = await app.request(`/api/trips/${tripId}/trip-places`, { headers: { cookie } });
      listedDuringLookup = parseTripPlaceListResponse(await response.json()).tripPlaces.length;
    };
    const place = await addPlace(cid);

    expect(listedDuringLookup).toBe(0);
    expect((await preview(place)).photo?.source).toBe("commons");
    expect(googlePhotoReads).toBe(0);
  });

  it.each([
    ["two Wikidata items share the CID", { items: ["Q1", "Q2"], license: "cc0" }],
    ["no Wikidata item has the CID", { items: [], license: "cc0" }],
    ["the work is not freely licensed", { items: ["Q714828"], license: "arr" }],
    ["Wikimedia throttles the lookup", { items: ["Q714828"], license: "cc0", failing: true }],
  ] as const)("keeps the place and its Google fallback when %s", async (_, scenario) => {
    const cid = `${Date.now()}2`;
    scenarios.set(cid, scenario);
    const place = await addPlace(cid);
    expect(place.name).toBe("受控神社");

    expect((await preview(place)).photo).toBeNull();
    expect(googlePhotoReads).toBe(1);
    expect(await database.selectFrom("commons_place_photos").select("place_id").where("place_id", "=", place.placeId).executeTakeFirst())
      .toBeUndefined();
  });

  it("does not serve another place's Commons file through this place's reference", async () => {
    const matched = `${Date.now()}3`;
    scenarios.set(matched, { items: ["Q714828"], license: "cc0" });
    const withPhoto = await addPlace(matched);
    const withoutPhoto = await addPlace(`${Date.now()}4`);
    const filename = (await preview(withPhoto)).photo!.thumbnailUrl.split("/").pop()!.split("?")[0]!;

    const response = await app.request(
      `/api/trips/${tripId}/place-photo-assets/${filename}?kind=trip-place&id=${withoutPhoto.id}`,
      { headers: { cookie } },
    );
    expect(response.status).toBe(404);
  });
});
