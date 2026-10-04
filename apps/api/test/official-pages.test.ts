import { describe, expect, it } from "vitest";

import {
  fetchPublicPageText,
  htmlText,
  isOfficialTourismSource,
  pageMentions,
  type PublicPageDependencies,
} from "../src/discovery/official-pages";

function dependencies(
  pages: Record<string, () => Response>,
  addresses: Record<string, string[]> = {},
): PublicPageDependencies & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    async resolveHost(host) {
      return addresses[host] ?? ["93.184.216.34"];
    },
    async fetch(input) {
      const url = String(input);
      requested.push(url);
      const page = pages[url];
      if (!page) throw new Error(`unexpected ${url}`);
      return page();
    },
  };
}

const html = (body: string, contentType = "text/html; charset=utf-8") =>
  () => new Response(body, { headers: { "content-type": contentType } });

describe("official tourism sources", () => {
  it("counts government domains even when the model labeled them otherwise", () => {
    expect(isOfficialTourismSource("https://www.city.kyoto.lg.jp/sankan/page.html", "other", null)).toBe(true);
    expect(isOfficialTourismSource("https://www.nps.gov/yose/index.htm", "other", null)).toBe(true);
  });

  it("never counts booking, review, social or reference platforms", () => {
    expect(isOfficialTourismSource("https://www.tripadvisor.com.tw/Attraction_Review-g1.html", "tourism_board", null)).toBe(false);
    expect(isOfficialTourismSource("https://tabelog.com/kyoto/A2601/", "tourism_board", null)).toBe(false);
    expect(isOfficialTourismSource("https://ja.wikipedia.org/wiki/東福寺", "government", null)).toBe(false);
  });

  it("never counts the place's own website, which only describes itself", () => {
    expect(isOfficialTourismSource("https://tofukuji.jp/autumn/", "tourism_board", "https://www.tofukuji.jp/")).toBe(false);
  });

  it("counts a tourism organization the model identified", () => {
    expect(isOfficialTourismSource("https://kyoto.travel/en/see-and-do/tofukuji.html", "tourism_board", "https://tofukuji.jp/")).toBe(true);
    expect(isOfficialTourismSource("https://example-blog.test/kyoto", "other", null)).toBe(false);
  });
});

describe("public page fetching", () => {
  it("returns the visible text of an HTTPS page", async () => {
    const text = await fetchPublicPageText("https://kyoto.travel/tofukuji", dependencies({
      "https://kyoto.travel/tofukuji": html("<html><script>var x='西芳寺'</script><h1>東福寺 &amp; 通天橋</h1></html>"),
    }));
    expect(text).toContain("東福寺 & 通天橋");
    expect(text).not.toContain("西芳寺");
  });

  it("decodes pages that declare a Japanese legacy encoding", async () => {
    const bytes = new Uint8Array([0x93, 0x8c, 0x95, 0x9f, 0x8e, 0x9b]); // 東福寺 in Shift_JIS
    const text = await fetchPublicPageText("https://www.ine-kankou.jp/", dependencies({
      "https://www.ine-kankou.jp/": () => new Response(bytes, { headers: { "content-type": "text/html; charset=Shift_JIS" } }),
    }));
    expect(text).toContain("東福寺");
  });

  it("refuses plain HTTP and hosts that resolve to private addresses", async () => {
    const pages = { "https://intranet.example.test/": html("東福寺") };
    expect(await fetchPublicPageText("http://kyoto.travel/", dependencies(pages))).toBeNull();
    const privateHost = dependencies(pages, { "intranet.example.test": ["10.0.0.5"] });
    expect(await fetchPublicPageText("https://intranet.example.test/", privateHost)).toBeNull();
    expect(privateHost.requested).toEqual([]);
  });

  it("re-checks every redirect target before following it", async () => {
    const network = dependencies({
      "https://kyoto.travel/moved": () => new Response(null, { status: 302, headers: { location: "https://metadata.internal/" } }),
    }, { "metadata.internal": ["169.254.169.254"] });
    expect(await fetchPublicPageText("https://kyoto.travel/moved", network)).toBeNull();
    expect(network.requested).toEqual(["https://kyoto.travel/moved"]);
  });

  it("reads at most the size limit and rejects non-text responses", async () => {
    const big = await fetchPublicPageText("https://kyoto.travel/big", dependencies({
      "https://kyoto.travel/big": html(`${"a".repeat(64)}東福寺`),
    }), { maxBytes: 64 });
    expect(big).not.toContain("東福寺");
    expect(await fetchPublicPageText("https://kyoto.travel/file.pdf", dependencies({
      "https://kyoto.travel/file.pdf": html("東福寺", "application/pdf"),
    }))).toBeNull();
  });

  it("finds a place name in page text whatever its separators", () => {
    expect(pageMentions("秋の 東福寺 通天橋", ["東福寺"])).toBe(true);
    expect(pageMentions("Visit Tofuku-ji in autumn", ["Tofukuji"])).toBe(true);
    expect(pageMentions("Visit Tofukuji in autumn", ["Tofuku-ji"])).toBe(true);
    expect(pageMentions("清水寺", ["東福寺"])).toBe(false);
  });

  it("does not find a name inside other words", () => {
    expect(pageMentions("The Kyoto Jidai Matsuri parade", ["To-ji"])).toBe(false);
    expect(pageMentions("Autumn events across the Kansai region", ["Gion"])).toBe(false);
    expect(pageMentions("Book tickets online", ["Ine"])).toBe(false);
    // Two characters are too short to tell a name from part of a longer word.
    expect(pageMentions("関東寺院めぐり", ["東寺"])).toBe(false);
  });

  it("strips unclosed tags from a hostile page in linear time", () => {
    const started = performance.now();
    expect(htmlText(`${"<a".repeat(500_000)}`)).not.toContain("<a");
    expect(htmlText(`東福寺${"<style".repeat(200_000)}`)).toContain("東福寺");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("drops everything after an unclosed script", () => {
    expect(htmlText("<p>東福寺</p><script>var leak = '西芳寺'")).not.toContain("西芳寺");
  });
});
