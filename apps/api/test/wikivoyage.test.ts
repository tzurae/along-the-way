import { describe, expect, it } from "vitest";

import {
  listsPlace,
  parseWikivoyageListings,
  WikivoyageVerifier,
} from "../src/discovery/wikivoyage";

const KYOTO_SOUTH = `
==See==
* {{see | name=Tōfuku-ji | alt=東福寺 | url=https://tofukuji.jp | lat=34.9767 | long=135.7738
| content=Famous for {{w|Tsūten-kyō}} bridge in autumn. }}
* {{listing | type=eat | name=[[Nishiki Market|Nishiki]] | lat= | long= }}
* '''Fushimi Inari-taisha''' – thousands of torii gates.
`;

describe("Wikivoyage listings", () => {
  it("reads listing templates, including nested templates and links, and bolded names", () => {
    expect(parseWikivoyageListings(KYOTO_SOUTH)).toEqual([
      { names: ["Tōfuku-ji", "東福寺"], latitude: 34.9767, longitude: 135.7738 },
      { names: ["Nishiki"], latitude: null, longitude: null },
      { names: ["Fushimi Inari-taisha"], latitude: null, longitude: null },
    ]);
  });

  it("identifies a place by name or by coordinates within 300 m, not 1 km away", () => {
    const listings = parseWikivoyageListings(KYOTO_SOUTH);
    expect(listsPlace(listings, { names: ["東福寺"], latitude: null, longitude: null })).toBe(true);
    expect(listsPlace(listings, { names: ["Tofukuji Temple Gate"], latitude: 34.9772, longitude: 135.7745 })).toBe(true);
    expect(listsPlace(listings, { names: ["Sennyu-ji"], latitude: 34.9767, longitude: 135.7850 })).toBe(false);
  });
});

describe("Wikivoyage verifier", () => {
  it("searches each edition, verifies the listing, and loads a shared guide page once", async () => {
    const requested: string[] = [];
    const verifier = new WikivoyageVerifier({
      fetch: async (input) => {
        const url = new URL(String(input));
        requested.push(`${url.hostname} ${url.searchParams.get("list") ?? "page"}`);
        if (url.hostname !== "en.wikivoyage.org") return Response.json({ query: { search: [] } });
        if (url.searchParams.get("list") === "search") {
          return Response.json({ query: { search: [{ title: "Kyoto/Southern" }] } });
        }
        return Response.json({ query: { pages: [{ revisions: [{ slots: { main: { content: KYOTO_SOUTH } } }] }] } });
      },
    });

    const tofukuji = await verifier.verify({ names: ["東福寺", "Tofuku-ji"], latitude: null, longitude: null, languages: ["zh", "en"] });
    const fushimi = await verifier.verify({ names: ["Fushimi Inari Taisha"], latitude: null, longitude: null, languages: ["en"] });
    const unlisted = await verifier.verify({ names: ["Sennyu-ji"], latitude: 34.97, longitude: 135.79, languages: ["en"] });

    expect(tofukuji).toEqual({ url: "https://en.wikivoyage.org/wiki/Kyoto/Southern", title: "Kyoto/Southern" });
    expect(fushimi?.title).toBe("Kyoto/Southern");
    expect(unlisted).toBeNull();
    expect(requested.filter((entry) => entry.endsWith("page"))).toHaveLength(1);
  });

  it("treats an unreachable edition as no evidence", async () => {
    const verifier = new WikivoyageVerifier({ fetch: async () => { throw new Error("no such host"); } });
    expect(await verifier.verify({ names: ["경복궁"], latitude: 37.58, longitude: 126.98, languages: ["ko"] })).toBeNull();
  });
});
