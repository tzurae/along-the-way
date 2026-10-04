/**
 * Comparable form: compatibility-normalized, without diacritics, case-folded, and without
 * spaces, punctuation or symbols ("Café" and "cafe", "東福寺 " and "東福寺" compare equal).
 */
export function normalizePlaceName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

// Google often appends an alternate name: "東寺(教王護國寺)", "Kaisan-do (Joraku-an)".
const PARENTHESES = /[(（]([^)）]*)[)）]/g;

/** The name as written, without its parenthesized part, and each parenthesized alternate. */
function variants(value: string) {
  const alternates = [...value.matchAll(PARENTHESES)].map((match) => match[1]!);
  return [value, value.replace(PARENTHESES, " "), ...alternates]
    .map(normalizePlaceName)
    .filter((name) => [...name].length >= 2);
}

/**
 * A researched name that adds a little to the other name is still that place: the model's
 * "伊根舟屋群" for Google's "伊根舟屋" (4 of 5 characters). The other way round is a different
 * facility beside it: Google's "伏見稲荷駅" (the station) or "롯데월드몰" (the mall) for a
 * researched "伏見稲荷" or "롯데월드". "Takao" in "Takao Kanko Hotel" fails both ways.
 */
const SAME_PLACE_SHARE = 0.8;

export type NameMatch = "exact" | "close";

/**
 * How one of the researched names agrees with another name (Google's or a guide's), or null
 * when they denote different places. Names one character apart ("Ginkaku-ji" and
 * "Kinkaku-ji", "道頓堀本店" and "道頓堀東店") never match: only equality, or a researched
 * name that is the other name plus a little, does.
 */
export function placeNameMatch(researchedNames: readonly string[], otherName: string): NameMatch | null {
  const others = variants(otherName);
  let close = false;
  for (const raw of researchedNames) {
    for (const name of variants(raw)) {
      for (const other of others) {
        if (name === other) return "exact";
        if (name.includes(other) && [...other].length / [...name].length >= SAME_PLACE_SHARE) close = true;
      }
    }
  }
  return close ? "close" : null;
}

export function placeNamesMatch(researchedNames: readonly string[], otherName: string) {
  return placeNameMatch(researchedNames, otherName) !== null;
}
