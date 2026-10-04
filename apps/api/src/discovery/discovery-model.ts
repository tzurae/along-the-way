import type { DiscoveryConfidence } from "@along-the-way/contracts/discovery";

export interface DiscoveryTripFacts {
  name: string;
  startDate: string;
  endDate: string;
  timeZone: string;
  currency: string;
  countries: Array<{ code: string; position: number }>;
}

export interface StructuredDiscoveryBrief {
  interests: string[];
  pace: string | null;
  budget: string | null;
  exclusions: string[];
  areas: string[];
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
  /** Canonical BCP-47 tag of the brief's language; every AI-written field and place name uses it. */
  outputLanguage: string;
}

export interface DiscoveryWebSource {
  url: string;
  title: string;
}

/** What the research model says a cited page is; checked against the host before it counts. */
export type WebSourceType = "government" | "tourism_board" | "wikivoyage" | "place_official" | "other";

export interface ResearchedCandidate {
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
  recommendation: string;
  matchedNeeds: string[];
  tradeoffs: string[];
  unknowns: string[];
  confidence: DiscoveryConfidence;
  /** Only URLs web search actually returned. */
  sources: Array<{ url: string; type: WebSourceType }>;
}

export interface DiscoveryResearchResult {
  modelId: string;
  candidates: ResearchedCandidate[];
  sources: DiscoveryWebSource[];
}

export interface InterpretedDiscoveryFeedback {
  modelId: string;
  interests: string[];
  exclusions: string[];
  pace: string | null;
  budget: string | null;
  summary: string;
}

export interface DiscoveryModel {
  readonly available: boolean;
  readonly modelId: string;
  plan(input: {
    brief: string;
    trip: DiscoveryTripFacts;
    confirmedFeedback: string[];
  }): Promise<DiscoveryPlanResult>;
  research(input: {
    brief: StructuredDiscoveryBrief;
    request: DiscoveryRequest;
    trip: DiscoveryTripFacts;
    confirmedFeedback: string[];
    /** Names of places the traveler already rejected. */
    rejectedPlaces: string[];
    outputLanguage: string;
  }): Promise<DiscoveryResearchResult>;
  interpretFeedback(input: {
    text: string;
    proposalName: string | null;
  }): Promise<InterpretedDiscoveryFeedback>;
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
