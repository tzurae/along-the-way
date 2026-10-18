import { describe, expect, it } from "vitest";
import type { PlaceType } from "@along-the-way/contracts/trip-skeleton";
import { namesRelated } from "../src/place-details/commons-photo-candidates";

// Owner-reviewed pairs from CandidateApi2 / CandidateReview, not generated from the matcher.
const keep: Array<[string, PlaceType, string[]]> = [
  ["三十三間堂", "worship", ["三十三間堂"]],
  ["京都御苑", "nature", ["京都御苑"]],
  ["南禪寺", "worship", ["南禅寺"]],
  ["船岡溫泉", "activity", ["船岡温泉"]],
  ["伊根舟屋", "activity", ["伊根の舟屋"]],
  ["天橋立車站", "station", ["天橋立駅"]],
  ["琵琶湖", "nature", ["琵琶湖"]],
  ["永觀堂(禪林寺)", "worship", ["永観堂", "禅林寺"]],
  ["西芳寺", "worship", ["西芳寺"]],
  ["Tōfuku-ji Temple", "worship", ["東福寺", "Tōfuku-ji Temple"]],
  ["東福寺", "station", ["東福寺駅"]],
  ["京都國立博物館", "museum", ["京都国立博物館"]],
  ["寶泉院", "worship", ["宝泉院"]],
  ["鞍馬寺", "worship", ["鞍馬寺"]],
  ["無鄰菴", "nature", ["無鄰菴"]],
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
  it.each(keep)("keeps %s related", (name, type, values) => {
    const names = values.map((value) => ({ lang: "ja", value }));
    expect(namesRelated(name, type, names)).toBe(true);
  });

  it.each(drop)("drops %s even when nearby or sharing scattered Latin letters", (name, type, values) => {
    const names = values.map((value) => ({ lang: "ja", value }));
    expect(namesRelated(name, type, names)).toBe(false);
  });
});
