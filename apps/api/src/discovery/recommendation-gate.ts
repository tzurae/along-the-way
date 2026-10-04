import type {
  DiscoveryEndorsement,
  DiscoveryShortfallDto,
} from "@along-the-way/contracts/discovery";

/** Below this many reviews a Google rating is too fragile to count, whatever its value. */
export const GOOGLE_MIN_REVIEWS = 200;
export const GOOGLE_MIN_RATING = 4;
/** A recommendation is shown only when this many independent kinds of source vouch for it. */
export const MIN_ENDORSEMENTS = 2;
export const MIN_PER_CATEGORY = 2;

export type GateResolution =
  | { status: "not_found" }
  | { status: "name_mismatch" }
  | { status: "resolved"; providerPlaceId: string; rating: number | null; userRatingCount: number | null };

export interface GateCandidate {
  displayName: string;
  /**
   * One of the plan's categories, or null for a traveler-named place that is none of the
   * requested kinds; a null category never counts toward a kind.
   */
  category: string | null;
  /** The traveler-named place this candidate answers, exactly as it appears in the plan. */
  namedPlace: string | null;
  resolution: GateResolution;
  /** A Wikivoyage guide verifiably lists the place. */
  wikivoyage: boolean;
  /** An official tourism page verifiably mentions the place. */
  officialTourism: boolean;
}

export interface GateInput {
  candidates: readonly GateCandidate[];
  namedPlaces: readonly string[];
  categories: readonly string[];
  rejectedProviderPlaceIds: ReadonlySet<string>;
}

export interface GateResult {
  /**
   * Places to show, traveler-named first: the representative candidate index, every candidate
   * index that resolved to the same place (whose evidence also applies), and its endorsements.
   */
  shown: Array<{ index: number; members: number[]; endorsements: DiscoveryEndorsement[] }>;
  shortfalls: DiscoveryShortfallDto[];
}

export function googleReviewsEndorse(rating: number | null, userRatingCount: number | null) {
  return rating !== null && userRatingCount !== null
    && userRatingCount >= GOOGLE_MIN_REVIEWS && rating >= GOOGLE_MIN_RATING;
}

function shortfall(
  code: DiscoveryShortfallDto["code"],
  subject: string,
  named: boolean,
  endorsements: DiscoveryEndorsement[] = [],
  count: number | null = null,
): DiscoveryShortfallDto {
  return { code, subject, named, endorsements, count };
}

/**
 * Deterministic quality rules: what may be shown, and why anything the traveler
 * would expect is missing. Never consults the model.
 */
export function gateRecommendations(input: GateInput): GateResult {
  const order = input.candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => Number(right.candidate.namedPlace !== null) - Number(left.candidate.namedPlace !== null));
  // Researched entries that resolve to one Google place are one place: their sources add up,
  // and the first (a traveler-named one when there is one) represents it.
  const places = new Map<string, { index: number; members: number[]; endorsements: Set<DiscoveryEndorsement> }>();
  for (const { candidate, index } of order) {
    const { resolution } = candidate;
    if (resolution.status !== "resolved" || input.rejectedProviderPlaceIds.has(resolution.providerPlaceId)) continue;
    const place = places.get(resolution.providerPlaceId) ?? { index, members: [], endorsements: new Set() };
    place.members.push(index);
    if (googleReviewsEndorse(resolution.rating, resolution.userRatingCount)) place.endorsements.add("google_reviews");
    if (candidate.wikivoyage) place.endorsements.add("wikivoyage");
    if (candidate.officialTourism) place.endorsements.add("official_tourism");
    places.set(resolution.providerPlaceId, place);
  }

  const shown: GateResult["shown"] = [];
  const shortfalls: DiscoveryShortfallDto[] = [];
  for (const named of input.namedPlaces) {
    if (!input.candidates.some((candidate) => candidate.namedPlace === named)) {
      shortfalls.push(shortfall("not_researched", named, true));
    }
  }
  for (const { candidate, index } of order) {
    const named = candidate.namedPlace !== null;
    const { resolution } = candidate;
    if (resolution.status !== "resolved") {
      shortfalls.push(shortfall(resolution.status, candidate.displayName, named));
      continue;
    }
    const place = places.get(resolution.providerPlaceId);
    if (!place || place.index !== index) continue;
    const endorsements = (["google_reviews", "wikivoyage", "official_tourism"] as const)
      .filter((endorsement) => place.endorsements.has(endorsement));
    if (endorsements.length < MIN_ENDORSEMENTS) {
      shortfalls.push(shortfall("single_source", candidate.displayName, named, endorsements));
      continue;
    }
    shown.push({ index, members: place.members, endorsements });
  }
  // A shown place answers every kind any of its merged entries was researched for.
  for (const category of input.categories) {
    const count = shown.filter(({ members }) =>
      members.some((member) => input.candidates[member]!.category === category)).length;
    if (count < MIN_PER_CATEGORY) shortfalls.push(shortfall("category_short", category, false, [], count));
  }
  return { shown, shortfalls };
}
