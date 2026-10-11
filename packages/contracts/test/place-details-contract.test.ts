import { describe, expect, it } from "vitest";
import {
  parseCuratedPlaceManifest,
  parsePlaceDetailDate,
  parsePlaceDetailResponse,
  parsePlacePreviewIds,
  parsePlacePreviewResponse,
  type CuratedPlaceManifest,
} from "../src/place-details";

function reviewedManifest(): CuratedPlaceManifest {
  const asset = { filename: `${"a".repeat(64)}.jpg`, sha256: "a".repeat(64), width: 800, height: 600, mediaType: "image/jpeg" as const };
  return { version: 1, places: [{ key: "garden-east", name: "同名庭園", sources: [{
    id: "official", title: "庭園參觀資訊", url: "https://example.test/garden/visit", checkedAt: "2026-10-09T10:00:00Z",
    publishedAt: "2026-09-01", validFrom: "2026-10-01", validUntil: "2026-10-31", expiresAt: null,
  }], sections: [{ kind: "hours", title: "開放時間", blocks: [
    { text: "十月開放至下午五時。", style: "paragraph", certainty: "sourced", sourceIds: ["official"] },
    { text: "冬季時間待確認。", style: "bullet", certainty: "unknown", sourceIds: [] },
  ] }], photos: [{
    id: "garden-east-view", title: "庭園東側", description: "東側庭園的歷史照片。", sourceName: "Wikimedia Commons",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Garden.jpg", fileSourceUrl: "https://upload.wikimedia.org/garden.jpg",
    author: "甲與乙", authorUrl: null, creditText: "甲與乙，依作品頁指定署名", licenseName: "CC BY-SA 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/", capturedAt: "2018-05-11", checkedAt: "2026-10-09T09:00:00Z",
    verificationUrl: "https://commons.wikimedia.org/w/index.php?title=File:Garden.jpg&oldid=1234",
    locationEvidence: "作品描述及座標對應庭園東側。", changes: "縮小尺寸，未裁切原圖。", notices: ["保留作者指定聲明。"],
    originalWidth: 1600, originalHeight: 1200, image: asset, thumbnail: { ...asset, width: 400, height: 300 },
  }] }] };
}

const tripId = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";

describe("curated place detail contract boundaries", () => {
  it("keeps distinct work-specific licensing, evidence, and unknown facts", () => {
    const input = reviewedManifest();
    const first = input.places[0]!.photos[0]!;
    input.places[0]!.photos.push({ ...first, id: "garden-second-work", sourceUrl: "https://commons.wikimedia.org/wiki/File:Second.jpg",
      author: "丙", creditText: "丙", licenseName: "CC0 1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
      image: { ...first.image, filename: `${"b".repeat(64)}.jpg`, sha256: "b".repeat(64) },
      thumbnail: { ...first.thumbnail, filename: `${"c".repeat(64)}.jpg`, sha256: "c".repeat(64) },
    });
    const place = parseCuratedPlaceManifest(input).places[0]!;
    expect(place.photos.map(({ id, author, licenseName }) => ({ id, author, licenseName }))).toEqual([
      { id: "garden-east-view", author: "甲與乙", licenseName: "CC BY-SA 3.0" },
      { id: "garden-second-work", author: "丙", licenseName: "CC0 1.0" },
    ]);
    expect(place.sources[0]?.checkedAt).toBe("2026-10-09T10:00:00Z");
    expect(place.sections[0]?.blocks[1]).toMatchObject({ certainty: "unknown", sourceIds: [] });
  });

  it.each([
    ["missing source", (m: CuratedPlaceManifest) => { m.places[0]!.sections[0]!.blocks[0]!.sourceIds = ["missing"]; }],
    ["unsourced claim", (m: CuratedPlaceManifest) => { m.places[0]!.sections[0]!.blocks[0]!.sourceIds = []; }],
    ["conflict without two sources", (m: CuratedPlaceManifest) => { m.places[0]!.sections[0]!.blocks[0]!.certainty = "conflicted"; }],
    ["duplicate work", (m: CuratedPlaceManifest) => { m.places[0]!.photos.push(m.places[0]!.photos[0]!); }],
    ["duplicate work under another id", (m: CuratedPlaceManifest) => { m.places[0]!.photos.push({ ...m.places[0]!.photos[0]!, id: "another-id" }); }],
    ["reversed validity", (m: CuratedPlaceManifest) => { m.places[0]!.sources[0]!.validFrom = "2026-11-01"; }],
    ["unsafe source URL", (m: CuratedPlaceManifest) => { m.places[0]!.sources[0]!.url = "javascript:alert(1)"; }],
    ["missing licensing evidence", (m: CuratedPlaceManifest) => { m.places[0]!.photos[0]!.verificationUrl = ""; }],
    ["unversioned Commons evidence", (m: CuratedPlaceManifest) => { m.places[0]!.photos[0]!.verificationUrl = m.places[0]!.photos[0]!.sourceUrl; }],
    ["missing credit", (m: CuratedPlaceManifest) => { m.places[0]!.photos[0]!.creditText = ""; }],
    ["unbounded dimensions", (m: CuratedPlaceManifest) => { m.places[0]!.photos[0]!.image.width = 100_000; }],
    ["path traversal asset", (m: CuratedPlaceManifest) => { m.places[0]!.photos[0]!.image.filename = "../photo.jpg"; }],
    ["unknown order field", (m: CuratedPlaceManifest) => { Object.assign(m.places[0]!.photos[0]!, { order: 0 }); }],
  ])("rejects %s instead of stripping data", (_label, mutate) => {
    const input = reviewedManifest();
    mutate(input);
    expect(() => parseCuratedPlaceManifest(input)).toThrow("Invalid place details");
  });

  it("accepts real leap days and rejects malformed dates or ambiguous batch IDs", () => {
    expect(parsePlaceDetailDate("2028-02-29")).toBe("2028-02-29");
    for (const date of ["2026-02-29", "2026-04-31", "2026-10-9", "2026-10-09T00:00:00Z", ""]) {
      expect(() => parsePlaceDetailDate(date)).toThrow();
    }
    for (const ids of ["", `${id},${id}`, `${id},`, "display-name", Array(101).fill(id).join(",")]) {
      expect(() => parsePlacePreviewIds(ids)).toThrow();
    }
  });

  it("requires response source integrity, explicit recheck state, and same-origin authenticated photos", () => {
    const place = reviewedManifest().places[0]!;
    const { image, thumbnail: _thumbnail, ...metadata } = place.photos[0]!;
    const url = `/api/trips/${tripId}/place-photo-assets/${image.filename}?kind=trip-place&id=${id}`;
    const photo = { ...metadata, imageUrl: url, thumbnailUrl: url, width: 800, height: 600 };
    const response = { detail: { reference: { kind: "trip-place", id }, canonicalPlaceId: id, name: place.name,
      asOfDate: "2026-11-01", sources: place.sources, photos: [photo],
      sections: place.sections.map((section) => ({ ...section, blocks: section.blocks.map((block) => ({ ...block, needsRecheck: true })) })),
    } };
    expect(parsePlaceDetailResponse(response).detail.sections[0]?.blocks[0]?.needsRecheck).toBe(true);
    expect(() => parsePlaceDetailResponse({ detail: { ...response.detail, sources: [] } })).toThrow();
    expect(() => parsePlacePreviewResponse({ previews: [{ reference: response.detail.reference,
      photo: { ...photo, imageUrl: "https://other.test/photo.jpg" } }] })).toThrow();
    expect(parsePlacePreviewResponse({ previews: [{ reference: response.detail.reference, photo: null }] }).previews[0]?.photo).toBeNull();
  });
});
