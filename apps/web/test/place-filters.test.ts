import { describe, expect, it } from "vitest";

import { placeArea } from "../src/PlaceFilters";

describe("place area derivation", () => {
  it.each([
    ["日本〒605-0862 京都府京都市東山区清水1丁目294", "東山区"],
    ["〒604-8006 京都府京都市中京区下丸屋町", "中京区"],
    ["京都府宇治市宇治蓮華116", "宇治市"],
    ["東京都町田市原町田6丁目12-20", "町田市"],
    ["愛知県名古屋市中村区名駅1丁目1-4", "中村区"],
    ["千葉県市川市八幡2丁目15-10", "市川市"],
    ["三重県四日市市諏訪栄町7-34", "四日市市"],
    ["奈良県大和郡山市北郡山町248-4", "大和郡山市"],
    ["新潟県十日町市本町6丁目1", "十日町市"],
    ["京都府久世郡久御山町島田ミスノ38", "久御山町"],
    ["沖縄県中頭郡読谷村座喜味2901", "読谷村"],
    ["東京都千代田区丸の内1丁目9-1", "千代田区"],
    ["1-chōme-294 Kiyomizu, Higashiyama Ward, Kyoto, 605-0862, Japan", "Higashiyama"],
    ["Higashiyama Ward 605-0862, Kyoto, Japan", "Higashiyama"],
    ["Gionmachi Minamigawa, Higashiyama-ku, Kyoto 605-0074, Japan", "Higashiyama"],
    ["2 Chome-1-1 Nihonbashi Muromachi, Chuo City, Tokyo 103-0022, Japan", "Chuo"],
  ])("returns a clean consistent area for %s", (address, expected) => {
    expect(placeArea(address)).toBe(expected);
  });

  it.each([
    "日本〒605-0981 京都府京都市東山区本町15丁目778",
    "605-0862, Japan",
    "Japan",
  ])("never exposes a country or postal prefix for %s", (address) => {
    const area = placeArea(address);
    expect(area === null || !/Japan|日本|〒|\d{3}-?\d{4}/i.test(area)).toBe(true);
  });
});
