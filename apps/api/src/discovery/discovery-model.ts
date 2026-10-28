import type { DiscoveryReachInput } from "@along-the-way/contracts/discovery";

export interface DiscoveryTripFacts {
  name: string;
  startDate: string;
  endDate: string;
  timeZone: string;
  currency: string;
  countries: Array<{ code: string; position: number }>;
}

/**
 * Where 調查 searches around: the member's phone position, else tonight's booked lodging. The
 * coordinates reach the models and Google only; they are never stored or logged.
 */
export interface DiscoverySearchCenter {
  source: "device" | "lodging";
  /** The lodging's name; null for the phone position. */
  label: string | null;
  latitude: number;
  longitude: number;
  /**
   * How and how far the traveler will go (research only; absent while clarifying). radiusMeters
   * is the straight-line limit it allows, null for 「都可以」.
   */
  reach?: DiscoveryReachInput & { radiusMeters: number | null };
}

/** "Nearby" means walking distance (owner decision 2026-10-22); the bias when no time limit was chosen. */
export const SEARCH_CENTER_RADIUS_METERS = 2_000;

export interface StructuredDiscoveryBrief {
  interests: string[];
  pace: string | null;
  budget: string | null;
  exclusions: string[];
  areas: string[];
}
export interface DiscoveryQuestionAnswer {
  question: string;
  /** Null means explicitly skipped: keep this unknown and do not infer an answer. */
  answer: string | null;
}


/** What the traveler asked for, as the model understood it. */
export interface DiscoveryRequest {
  /** Places the traveler named, in their wording, with the area each is in. */
  namedPlaces: Array<{ name: string; area: string }>;
  /** Kinds of place to recommend; the localized defaults when the traveler asked for none. */
  categories: string[];
  defaultCategories: boolean;
  /** Arrangements already made (for example where they stay); never recommended. */
  alreadyArranged: string[];
  areas: string[];
  exclusions: string[];
  /** BCP-47 tag of the destination's language, used to search local guides. */
  localLanguage: string;
  /** Google Maps searches that find the real places research may pick from. */
  searchQueries: DiscoverySearchQuery[];
}

/** One Google Maps search the plan asks for, in the destination's language. */
export interface DiscoverySearchQuery {
  query: string;
  area: string;
  /** The request category this search serves; null for a traveler-named place. */
  category: string | null;
  /** The traveler-named place this search looks for, exactly as in the request, or null. */
  namedPlace: string | null;
}

/**
 * The real places one search found. `summary` is Google Maps Content: it identifies the places
 * for the research model during this run and is never stored.
 */
export interface DiscoveredPlaceGroup extends DiscoverySearchQuery {
  summary: string;
  /**
   * Place IDs in the order the summary cites them ("[0]" is the first); null where the place is
   * one the trip already has or rejected, so it cannot be picked again.
   */
  placeIds: Array<string | null>;
  /**
   * With a search center: each place's straight-line distance from it in meters, aligned with
   * placeIds (null when Google gave no position), so research can prefer walking distance.
   */
  distancesMeters?: Array<number | null>;
}

/** Persisted per run and shown as the search plan. */
export interface DiscoverySearchPlan {
  queries: string[];
  areas: string[];
  categories: string[];
  defaultCategories: boolean;
  namedPlaces: string[];
  alreadyArranged: string[];
  exclusions: string[];
  dateRange: { start: string; end: string };
}

export interface DiscoveryPlanResult {
  modelId: string;
  structuredBrief: StructuredDiscoveryBrief;
  unresolvedQuestions: string[];
  request: DiscoveryRequest;
  /** Always APP_LANGUAGE (zh-TW): every AI-written field and place name uses it, whatever the brief's language. */
  outputLanguage: string;
}

export interface DiscoveryWebSource {
  url: string;
  title: string;
}

/** What the research model says a cited page is; checked against the host before it counts. */
export type WebSourceType = "government" | "tourism_board" | "wikivoyage" | "place_official" | "other";

export interface DiscoveryClaimSentence {
  text: string;
  /** Only URLs returned by web search during this research request. */
  sourceUrls: string[];
}

export interface ResearchedCandidate {
  /** The Google Place ID picked from the discovered places; never written by the model freely. */
  providerPlaceId: string;
  /** Name in the output language. */
  name: string;
  /** Name in the destination's language, and in English, when known; used to look it up and verify it. */
  localName: string | null;
  englishName: string | null;
  /** City or area to look the place up in. */
  area: string;
  /** One of the request's categories; null only for a traveler-named place that fits none. */
  category: string | null;
  /** The traveler-named place this answers, exactly as in the request, or null. */
  namedPlace: string | null;
  recommendationSentences: DiscoveryClaimSentence[];
  matchedNeeds: string[];
  tradeoffSentences: DiscoveryClaimSentence[];
  unknowns: string[];
  /** Only URLs web search actually returned. */
  sources: Array<{ url: string; type: WebSourceType }>;
}

export interface DiscoveryResearchResult {
  modelId: string;
  candidates: ResearchedCandidate[];
  sources: DiscoveryWebSource[];
}

/** One checklist question as the clarifying worker proposes it; the server assigns ids. */
export interface ClarifyQuestionDraft {
  text: string;
  why: string;
  options: string[];
  allowOther: boolean;
  multiple: boolean;
  required: boolean;
}

export interface ClarifyReviewItem {
  id: string;
  text: string;
  options: string[];
  required: boolean;
  /** null: the traveler skipped an optional question. */
  answer: string | null;
}

export interface ClarifyReviewVerdict {
  id: string;
  verdict: "sufficient" | "insufficient" | "unreasonable";
  /** Plain ask-back shown to the traveler; null when sufficient. */
  reason: string | null;
  /** The answer restated as one explicit statement for research; null when nothing usable. */
  interpretation: string | null;
}

export interface DiscoveryModel {
  readonly available: boolean;
  readonly modelId: string;
  plan(input: {
    brief: string;
    trip: DiscoveryTripFacts;
    questionAnswers: DiscoveryQuestionAnswer[];
    /** Absent or null: no center, search the brief's areas as before. */
    searchCenter?: DiscoverySearchCenter | null;
    /** 範圍 region: also plan the destination's common same-day-trip towns. Absent: false. */
    dayTrips?: boolean;
  }): Promise<DiscoveryPlanResult>;
  research(input: {
    brief: StructuredDiscoveryBrief;
    request: DiscoveryRequest;
    trip: DiscoveryTripFacts;
    questionAnswers: DiscoveryQuestionAnswer[];
    /** Real places to pick from; places the trip already has or rejected are removed beforehand. */
    discovered: DiscoveredPlaceGroup[];
    outputLanguage: string;
    searchCenter?: DiscoverySearchCenter | null;
    /** 範圍 region: the plan's areas include day-trip towns the traveler wants. Absent: false. */
    dayTrips?: boolean;
  }): Promise<DiscoveryResearchResult>;
  /** Worker: at most five questions whose answers materially change the recommendations. */
  clarify(input: {
    brief: string;
    trip: DiscoveryTripFacts;
    /** Set: the worker must not ask where the traveler is or stays. */
    searchCenter?: DiscoverySearchCenter | null;
  }): Promise<{ modelId: string; questions: ClarifyQuestionDraft[] }>;
  /** Reviewer: judges whether each required answer is sufficient and reasonable. */
  reviewAnswers(input: { brief: string; trip: DiscoveryTripFacts; items: ClarifyReviewItem[] }): Promise<{ verdicts: ClarifyReviewVerdict[] }>;
}

export class DiscoveryModelUnavailableError extends Error {
  constructor(message = "AI discovery is temporarily unavailable") {
    super(message);
  }
}

export class DiscoveryModelResponseError extends Error {
  constructor(message = "AI discovery returned an invalid structured response") {
    super(message);
  }
}
