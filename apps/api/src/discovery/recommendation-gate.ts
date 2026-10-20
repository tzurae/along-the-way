import {
  GOOGLE_MIN_RATING,
  GOOGLE_MIN_REVIEWS,
  type DiscoveryEndorsement,
  type DiscoveryShortfallDto,
} from "@along-the-way/contracts/discovery";

import type { BusinessStatus } from "../planning/opening-hours";

export { GOOGLE_MIN_RATING, GOOGLE_MIN_REVIEWS };
/**
 * Owner decision 2026-10-20: one verified source is enough to show a place, because every place
 * is now a real Google Maps result; the card says which sources were verified. Wikivoyage alone
 * is not enough yet: its matcher still mistakes bold words for listings (喜兵衛 → Kihei, Maui).
 */
export const SINGLE_SOURCE_ENDORSEMENTS: readonly DiscoveryEndorsement[] = ["google_reviews", "official_tourism"];
export const MIN_PER_CATEGORY = 2;

/**
 * Whether these verified sources are enough to show a place. Wikivoyage never decides it: with
 * only three kinds, any two include Google reviews or an official page.
 */
export function enoughEndorsements(endorsements: readonly DiscoveryEndorsement[]) {
  return endorsements.some((endorsement) => SINGLE_SOURCE_ENDORSEMENTS.includes(endorsement));
}

export type GateResolution =
  | { status: "not_found" }
  | { status: "name_mismatch" }
  | {
      status: "resolved";
      providerPlaceId: string;
      rating: number | null;
      userRatingCount: number | null;
      /** Google's business status; null when Google gave none. */
      businessStatus: BusinessStatus | null;
      /** Country of the place's address; null when Google gave none. */
      countryCode: string | null;
      /** Google gave coordinates for the place. */
      located: boolean;
    };

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
  /** Places a member rejected in an earlier run. */
  rejectedProviderPlaceIds: ReadonlySet<string>;
  /** Places already on the trip's shared wishlist, however they got there. */
  wishlistProviderPlaceIds: ReadonlySet<string>;
  /** Places already on this trip's 幫我找 list (one suggestion per place); never added twice. */
  suggestedProviderPlaceIds: ReadonlySet<string>;
  /** Country codes of the trip's stops; a place in another country is never proposed. */
  tripCountryCodes: ReadonlySet<string>;
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

/** Google's facts about a place that can rule it out of a trip. */
export interface PlaceFacts {
  businessStatus: BusinessStatus | null;
  countryCode: string | null;
  located: boolean;
}

/** Why Google's facts rule the place out of this trip, whatever its sources say; null when nothing does. */
export function infeasible(facts: PlaceFacts, tripCountryCodes: ReadonlySet<string>): DiscoveryShortfallDto["code"] | null {
  if (facts.businessStatus === "closed_permanently") return "permanently_closed";
  if (facts.businessStatus === "closed_temporarily") return "temporarily_closed";
  if (!facts.located) return "no_location";
  // An unknown country cannot rule a place out.
  if (facts.countryCode !== null && !tripCountryCodes.has(facts.countryCode)) return "outside_trip";
  return null;
}

/**
 * Deterministic quality rules: what may be shown, and why anything the traveler
 * would expect is missing. Never consults the model.
 */
export function gateRecommendations(input: GateInput): GateResult {
  const order = input.candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => Number(right.candidate.namedPlace !== null) - Number(left.candidate.namedPlace !== null));
  // A place the members already decided on is never proposed again; the wishlist wins when both apply.
  const decidedAs = (providerPlaceId: string) => input.wishlistProviderPlaceIds.has(providerPlaceId)
    ? "in_wishlist" as const
    : input.rejectedProviderPlaceIds.has(providerPlaceId) ? "rejected" as const : null;
  // Researched entries that resolve to one Google place are one place: their sources add up,
  // and the first (a traveler-named one when there is one) represents it.
  const places = new Map<string, { index: number; members: number[]; endorsements: Set<DiscoveryEndorsement> }>();
  for (const { candidate, index } of order) {
    const { resolution } = candidate;
    if (resolution.status !== "resolved") continue;
    const place = places.get(resolution.providerPlaceId) ?? { index, members: [], endorsements: new Set() };
    place.members.push(index);
    if (googleReviewsEndorse(resolution.rating, resolution.userRatingCount)) place.endorsements.add("google_reviews");
    if (candidate.wikivoyage) place.endorsements.add("wikivoyage");
    if (candidate.officialTourism) place.endorsements.add("official_tourism");
    places.set(resolution.providerPlaceId, place);
  }

  const shown: GateResult["shown"] = [];
  const shortfalls: DiscoveryShortfallDto[] = [];
  // Already-decided places that pass the checks: not shown again, but not quality failures either.
  const passedDecided: number[][] = [];
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
    // One entry per place, however many researched entries resolved to it.
    if (!place || place.index !== index) continue;
    const endorsements = (["google_reviews", "wikivoyage", "official_tourism"] as const)
      .filter((endorsement) => place.endorsements.has(endorsement));
    const decided = decidedAs(resolution.providerPlaceId);
    const alreadySuggested = !decided && input.suggestedProviderPlaceIds.has(resolution.providerPlaceId);
    if (decided || alreadySuggested) {
      // Already listed: not a quality failure, so no shortfall; a decision still explains itself.
      if (decided) shortfalls.push(shortfall(decided, candidate.displayName, named));
      // The decision is the reason given; it still covers its kind only if it could be visited.
      if (enoughEndorsements(endorsements) && infeasible(resolution, input.tripCountryCodes) === null) {
        passedDecided.push(place.members);
      }
      continue;
    }
    const ruledOut = infeasible(resolution, input.tripCountryCodes);
    if (ruledOut) {
      shortfalls.push(shortfall(ruledOut, candidate.displayName, named));
      continue;
    }
    if (!enoughEndorsements(endorsements)) {
      shortfalls.push(shortfall("single_source", candidate.displayName, named, endorsements));
      continue;
    }
    shown.push({ index, members: place.members, endorsements });
  }
  // A place that passed answers every kind any of its merged entries was researched for.
  const passed = [...shown.map(({ members }) => members), ...passedDecided];
  for (const category of input.categories) {
    const count = passed.filter((members) =>
      members.some((member) => input.candidates[member]!.category === category)).length;
    if (count < MIN_PER_CATEGORY) shortfalls.push(shortfall("category_short", category, false, [], count));
  }
  return { shown, shortfalls };
}
