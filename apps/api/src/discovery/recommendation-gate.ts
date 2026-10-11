import type {
  DiscoveryEndorsement,
  DiscoveryShortfallDto,
} from "@along-the-way/contracts/discovery";

import type { BusinessStatus } from "../planning/opening-hours";

/** Below this many reviews a Google rating is too fragile to count, whatever its value. */
export const GOOGLE_MIN_REVIEWS = 200;
export const GOOGLE_MIN_RATING = 4;
/** A recommendation is shown only when this many independent kinds of source vouch for it. */
export const MIN_ENDORSEMENTS = 2;
export const MIN_PER_CATEGORY = 2;

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
    if (decided) {
      shortfalls.push(shortfall(decided, candidate.displayName, named));
      // The decision is the reason given; it still covers its kind only if it could be visited.
      if (endorsements.length >= MIN_ENDORSEMENTS && infeasible(resolution, input.tripCountryCodes) === null) {
        passedDecided.push(place.members);
      }
      continue;
    }
    const ruledOut = infeasible(resolution, input.tripCountryCodes);
    if (ruledOut) {
      shortfalls.push(shortfall(ruledOut, candidate.displayName, named));
      continue;
    }
    if (endorsements.length < MIN_ENDORSEMENTS) {
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
