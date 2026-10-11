import { describe, expect, it } from "vitest";

import { placeNameMatch, placeNamesMatch } from "../src/discovery/place-names";

describe("place name matching", () => {
  it("matches Google names that append an alternate name in parentheses", () => {
    expect(placeNameMatch(["永觀堂"], "永觀堂(禪林寺)")).toBe("exact");
    expect(placeNameMatch(["教王護國寺"], "東寺（教王護國寺）")).toBe("exact");
    expect(placeNameMatch(["Kaisando"], "Kaisan-do (Joraku-an)")).toBe("exact");
  });

  it("ignores spacing, punctuation, case and accents", () => {
    expect(placeNameMatch(["Seongsu-dong Cafe Street"], "Seongsu-dong Café Street")).toBe("exact");
    expect(placeNameMatch(["德壽宮石牆路"], "德壽宮 石牆路")).toBe("exact");
  });

  it("accepts a name that is nearly all of the other as a close match", () => {
    expect(placeNameMatch(["伊根舟屋群"], "伊根舟屋")).toBe("close");
  });

  it("rejects a name that is only part of a different place's name", () => {
    expect(placeNamesMatch(["高雄", "Takao"], "Takao Kanko Hotel")).toBe(false);
    expect(placeNamesMatch(["湯豆腐"], "湯豆腐 嵯峨野")).toBe(false);
    expect(placeNamesMatch(["Hilton Tokyo"], "Hilton Tokyo Bay")).toBe(false);
  });

  it("rejects the station, mall or tower beside a place even when the name adds only a little", () => {
    expect(placeNamesMatch(["伏見稲荷"], "伏見稲荷駅")).toBe(false);
    expect(placeNamesMatch(["明治神宮"], "明治神宮前")).toBe(false);
    expect(placeNamesMatch(["롯데월드"], "롯데월드몰")).toBe(false);
    expect(placeNamesMatch(["Tokyo Tower"], "Tokyo Towers")).toBe(false);
  });

  it("rejects different places whose names differ by one letter or character", () => {
    expect(placeNamesMatch(["Ginkaku-ji"], "Kinkaku-ji")).toBe(false);
    expect(placeNamesMatch(["Sanzen-in"], "Nanzen-in")).toBe(false);
    expect(placeNamesMatch(["Kyoto National Museum"], "Tokyo National Museum")).toBe(false);
    expect(placeNamesMatch(["かに道楽 道頓堀本店"], "かに道楽 道頓堀東店")).toBe(false);
    expect(placeNamesMatch(["時代祭", "Jidai Matsuri"], "Aoi Matsuri")).toBe(false);
  });

  it("matches when any of the researched names in any language agrees", () => {
    expect(placeNamesMatch(["廣藏市場", "광장시장", "Gwangjang Market"], "광장시장")).toBe(true);
  });
});
