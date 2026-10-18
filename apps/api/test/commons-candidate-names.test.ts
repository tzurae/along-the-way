import { describe, expect, it } from "vitest";
import type { PlaceType } from "@along-the-way/contracts/trip-skeleton";
import { namesExactlyEqual, namesRelated, typeCompatible } from "../src/place-details/commons-photo-candidates";

// Owner-reviewed pairs from CandidateApi2 / CandidateReview, not generated from the matcher.
const keep: Array<[string, PlaceType, string[], boolean]> = [
  ["三十三間堂", "worship", ["三十三間堂"], true],
  ["京都御苑", "nature", ["京都御苑"], true],
  ["南禪寺", "worship", ["南禅寺"], true],
  ["船岡溫泉", "activity", ["船岡温泉"], true],
  ["伊根舟屋", "activity", ["伊根の舟屋"], true],
  ["天橋立車站", "station", ["天橋立駅"], true],
  ["琵琶湖", "nature", ["琵琶湖"], true],
  ["永觀堂(禪林寺)", "worship", ["永観堂", "禅林寺"], false],
  ["西芳寺", "worship", ["西芳寺"], true],
  ["Tōfuku-ji Temple", "worship", ["東福寺", "Tōfuku-ji Temple"], true],
  ["東福寺", "station", ["東福寺駅"], true],
  ["京都國立博物館", "museum", ["京都国立博物館"], true],
  ["寶泉院", "worship", ["宝泉院"], true],
  ["鞍馬寺", "worship", ["鞍馬寺"], true],
  ["無鄰菴", "nature", ["無鄰菴"], true],
];
const drop: Array<[string, PlaceType, string[]]> = [
  ["La Voiture", "cafe", ["旧武徳殿", "Butokuden"]],
  ["藍瓶咖啡 京都店", "cafe", ["西福寺"]],
  ["New Babe Kyoto", "restaurant", ["住吉神社"]],
  ["Kitchen Papa", "restaurant", ["石像寺"]],
  ["咖啡館 Cafe du pin", "cafe", ["智恩寺", "Chion-ji Temple"]],
  ["Yoshino Chaya", "restaurant", ["智恩寺", "Chion-ji Temple"]],
  ["迴旋橋", "activity", ["智恩寺", "Chion-ji Temple"]],
  ["風風之湯", "activity", ["嵐山駅"]],
  ["愛海宝(akaho)", "restaurant", ["丹波口駅"]],
  ["西尾八橋之里（西尾八橋別邸）", "restaurant", ["聖護院"]],
  ["Funaya Biyori", "cafe", ["道の駅舟屋の里 伊根", "道之驛舟屋之里 伊根", "Roadside station Funaya-no-sato Ine"]],
  ["天橋立傘松公園", "nature", ["天橋立鋼索鉄道"]],
  ["Tetsugaku No Michi", "activity", ["安楽寺"]],
];

describe("Commons candidate names keep the owner-reviewed subjects without nearby false matches", () => {
  it.each(keep)("keeps %s related with the reviewed exact-name outcome", (name, type, values, exact) => {
    const names = values.map((value) => ({ lang: "ja", value }));
    expect(namesRelated(name, type, names)).toBe(true);
    expect(namesExactlyEqual(name, type, names)).toBe(exact);
  });

  it.each(drop)("drops %s even when nearby or sharing scattered Latin letters", (name, type, values) => {
    const names = values.map((value) => ({ lang: "ja", value }));
    expect(namesRelated(name, type, names)).toBe(false);
    expect(namesExactlyEqual(name, type, names)).toBe(false);
  });

  it.each([
    { name: "舟屋之里公園", type: "nature" as const, names: ["道の駅舟屋の里 伊根"], instance: { id: "Q185697", label: "roadside station" }, compatible: false },
    { name: "琵琶湖湖中鳥居（白鬚神社）", type: "worship" as const, names: ["白鬚神社"], instance: { id: "Q34627", label: "Shinto shrine" }, compatible: true },
  ])("keeps $name for manual review without promoting relatedness to exact equality", ({ name, type, names, instance, compatible }) => {
    const candidates = names.map((value) => ({ lang: "ja", value }));
    expect(namesRelated(name, type, candidates)).toBe(true);
    expect(namesExactlyEqual(name, type, candidates)).toBe(false);
    expect(typeCompatible(type, [instance])).toBe(compatible);
  });
});
