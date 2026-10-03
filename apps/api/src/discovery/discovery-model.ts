import type { ProviderPlaceCandidateDto } from "@along-the-way/contracts/trip-places";

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

export interface DiscoverySearchPlan {
  queries: string[];
  areas: string[];
  categories: string[];
  exclusions: string[];
  dateRange: { start: string; end: string };
}

export interface DiscoveryPlanResult {
  modelId: string;
  structuredBrief: StructuredDiscoveryBrief;
  unresolvedQuestions: string[];
  searchPlan: DiscoverySearchPlan;
  /** Canonical BCP-47 tag of the brief's language; every AI-written field and place name uses it. */
  outputLanguage: string;
}

export interface DiscoveryWebSource {
  url: string;
  title: string;
}

export interface SynthesizedCandidate {
  providerPlaceId: string;
  recommendation: string;
  matchedNeeds: string[];
  tradeoffs: string[];
  unknowns: string[];
  confidence: "high" | "medium" | "low";
  sourceUrls: string[];
}

export interface DiscoverySynthesisResult {
  modelId: string;
  candidates: SynthesizedCandidate[];
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
  synthesize(input: {
    brief: StructuredDiscoveryBrief;
    searchPlan: DiscoverySearchPlan;
    trip: DiscoveryTripFacts;
    candidates: ProviderPlaceCandidateDto[];
    confirmedFeedback: string[];
    rejectedProviderPlaceIds: string[];
    outputLanguage: string;
  }): Promise<DiscoverySynthesisResult>;
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
