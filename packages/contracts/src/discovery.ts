import { isRecord } from "./type-guards";
import type { PlaceType } from "./trip-skeleton";

export type DiscoveryConfidence = "high" | "medium" | "low";
export type DiscoveryProposalStatus = "pending" | "accepting" | "accepted" | "rejected";
export type DiscoveryFeedbackStatus = "pending" | "confirmed" | "rejected";
/** Independent kinds of source that can vouch for a recommendation. */
export type DiscoveryEndorsement = "google_reviews" | "wikivoyage" | "official_tourism";
export type DiscoveryShortfallCode =
  | "not_researched"
  | "not_found"
  | "name_mismatch"
  | "single_source"
  | "category_short";

export interface StructuredDiscoveryBriefDto {
  interests: string[];
  pace: string | null;
  budget: string | null;
  exclusions: string[];
  areas: string[];
}

export interface DiscoveryBriefDto {
  originalText: string;
  structured: StructuredDiscoveryBriefDto | null;
  unresolvedQuestions: string[];
  version: number;
  updatedAt: string;
}

export interface DiscoverySearchPlanDto {
  /** Google lookups actually made, one short "area name" query per researched place. */
  queries: string[];
  areas: string[];
  /** Kinds of place the traveler asked for, or the defaults when they asked for none. */
  categories: string[];
  defaultCategories: boolean;
  /** Places the traveler named; each is always researched. */
  namedPlaces: string[];
  /** Arrangements the traveler already made; never recommended. */
  alreadyArranged: string[];
  exclusions: string[];
  dateRange: { start: string; end: string };
}

/** Why something the traveler would expect is missing from the shortlist. */
export interface DiscoveryShortfallDto {
  code: DiscoveryShortfallCode;
  /** Place name, or the kind of place for category_short. */
  subject: string;
  named: boolean;
  /** Sources that did vouch, for single_source. */
  endorsements: DiscoveryEndorsement[];
  /** Places shown for the kind, for category_short. */
  count: number | null;
}

export interface DiscoveryEvidenceDto {
  id: string;
  kind: "google-place" | "web-source";
  providerPlaceId: string | null;
  sourceUrl: string;
  title: string;
  attribution: string;
  observedAt: string;
  expiresAt: string | null;
}

export interface CandidateProposalDto {
  id: string;
  runId: string;
  providerPlaceId: string;
  name: string;
  type: PlaceType;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  sourceUrl: string | null;
  recommendation: string;
  matchedNeeds: string[];
  tradeoffs: string[];
  unknowns: string[];
  confidence: DiscoveryConfidence;
  status: DiscoveryProposalStatus;
  evidence: DiscoveryEvidenceDto[];
  acceptedTripPlaceId: string | null;
  version: number;
  /** Kind of place it answers; null for proposals from before kinds were recorded. */
  category: string | null;
  /** Independent sources that vouched for it; empty for older proposals. */
  endorsements: DiscoveryEndorsement[];
}

export interface DiscoveryRunDto {
  id: string;
  status: "completed" | "failed";
  modelId: string;
  policyVersion: string;
  briefVersion: number;
  searchPlan: DiscoverySearchPlanDto;
  generatedAt: string;
  errorCode: string | null;
  shortfalls: DiscoveryShortfallDto[];
}

export interface DiscoveryFeedbackDto {
  id: string;
  proposalId: string | null;
  originalText: string;
  interpretation: {
    interests: string[];
    exclusions: string[];
    pace: string | null;
    budget: string | null;
    summary: string;
  };
  status: DiscoveryFeedbackStatus;
  version: number;
  createdAt: string;
}

export interface DiscoveryWorkspaceDto {
  brief: DiscoveryBriefDto | null;
  latestRun: DiscoveryRunDto | null;
  proposals: CandidateProposalDto[];
  feedback: DiscoveryFeedbackDto[];
  modelAvailable: boolean;
  placeProviderAvailable: boolean;
}

export interface DiscoveryWorkspaceResponse {
  discovery: DiscoveryWorkspaceDto;
}

export interface SaveDiscoveryBriefInput {
  originalText: string;
  expectedVersion?: number | null;
}

export interface GenerateDiscoveryInput {
  expectedBriefVersion: number;
}

export interface DecideCandidateProposalInput {
  expectedVersion: number;
}

export interface CreateDiscoveryFeedbackInput {
  originalText: string;
  proposalId?: string | null;
}

export interface DecideDiscoveryFeedbackInput {
  expectedVersion: number;
  decision: "confirm" | "reject";
}

function invalid(): never {
  throw new Error("Invalid discovery response");
}

function record(value: unknown) {
  return isRecord(value) ? value : invalid();
}

function text(value: unknown) {
  return typeof value === "string" ? value : invalid();
}

function nullableText(value: unknown) {
  return value === null ? null : text(value);
}

function integer(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : invalid();
}

function nullableNumber(value: unknown, minimum: number, maximum: number) {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : invalid();
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.map(text) : invalid();
}

function endorsements(value: unknown): DiscoveryEndorsement[] {
  return strings(value).map((entry) =>
    entry === "google_reviews" || entry === "wikivoyage" || entry === "official_tourism" ? entry : invalid()
  );
}

const SHORTFALL_CODES: readonly DiscoveryShortfallCode[] = [
  "not_researched", "not_found", "name_mismatch", "single_source", "category_short",
];

function shortfall(value: unknown): DiscoveryShortfallDto {
  const item = record(value);
  const code = SHORTFALL_CODES.find((entry) => entry === item.code) ?? invalid();
  return {
    code,
    subject: text(item.subject),
    named: typeof item.named === "boolean" ? item.named : invalid(),
    endorsements: endorsements(item.endorsements),
    count: item.count === null ? null : integer(item.count),
  };
}

function placeType(value: unknown): PlaceType {
  if (["airport", "station", "lodging", "restaurant", "activity", "other"].includes(String(value))) {
    return value as PlaceType;
  }
  return invalid();
}

function structuredBrief(value: unknown): StructuredDiscoveryBriefDto {
  const item = record(value);
  return {
    interests: strings(item.interests),
    pace: nullableText(item.pace),
    budget: nullableText(item.budget),
    exclusions: strings(item.exclusions),
    areas: strings(item.areas),
  };
}

function searchPlan(value: unknown): DiscoverySearchPlanDto {
  const item = record(value);
  const dateRange = record(item.dateRange);
  return {
    queries: strings(item.queries),
    areas: strings(item.areas),
    categories: strings(item.categories),
    defaultCategories: typeof item.defaultCategories === "boolean" ? item.defaultCategories : invalid(),
    namedPlaces: strings(item.namedPlaces),
    alreadyArranged: strings(item.alreadyArranged),
    exclusions: strings(item.exclusions),
    dateRange: { start: text(dateRange.start), end: text(dateRange.end) },
  };
}

function evidence(value: unknown): DiscoveryEvidenceDto {
  const item = record(value);
  if (item.kind !== "google-place" && item.kind !== "web-source") invalid();
  return {
    id: text(item.id),
    kind: item.kind,
    providerPlaceId: nullableText(item.providerPlaceId),
    sourceUrl: text(item.sourceUrl),
    title: text(item.title),
    attribution: text(item.attribution),
    observedAt: text(item.observedAt),
    expiresAt: nullableText(item.expiresAt),
  };
}

function proposal(value: unknown): CandidateProposalDto {
  const item = record(value);
  if (!["high", "medium", "low"].includes(String(item.confidence))) invalid();
  if (!["pending", "accepting", "accepted", "rejected"].includes(String(item.status))) invalid();
  return {
    id: text(item.id),
    runId: text(item.runId),
    providerPlaceId: text(item.providerPlaceId),
    name: text(item.name),
    type: placeType(item.type),
    address: nullableText(item.address),
    latitude: nullableNumber(item.latitude, -90, 90),
    longitude: nullableNumber(item.longitude, -180, 180),
    sourceUrl: nullableText(item.sourceUrl),
    recommendation: text(item.recommendation),
    matchedNeeds: strings(item.matchedNeeds),
    tradeoffs: strings(item.tradeoffs),
    unknowns: strings(item.unknowns),
    confidence: item.confidence as DiscoveryConfidence,
    status: item.status as DiscoveryProposalStatus,
    evidence: Array.isArray(item.evidence) ? item.evidence.map(evidence) : invalid(),
    acceptedTripPlaceId: nullableText(item.acceptedTripPlaceId),
    version: integer(item.version),
    category: nullableText(item.category),
    endorsements: endorsements(item.endorsements),
  };
}

function feedback(value: unknown): DiscoveryFeedbackDto {
  const item = record(value);
  const interpretation = record(item.interpretation);
  if (!["pending", "confirmed", "rejected"].includes(String(item.status))) invalid();
  return {
    id: text(item.id),
    proposalId: nullableText(item.proposalId),
    originalText: text(item.originalText),
    interpretation: {
      interests: strings(interpretation.interests),
      exclusions: strings(interpretation.exclusions),
      pace: nullableText(interpretation.pace),
      budget: nullableText(interpretation.budget),
      summary: text(interpretation.summary),
    },
    status: item.status as DiscoveryFeedbackStatus,
    version: integer(item.version),
    createdAt: text(item.createdAt),
  };
}

export function parseDiscoveryWorkspaceResponse(value: unknown): DiscoveryWorkspaceResponse {
  const root = record(record(value).discovery);
  const briefValue = root.brief;
  const runValue = root.latestRun;
  let brief: DiscoveryBriefDto | null = null;
  if (briefValue !== null) {
    const item = record(briefValue);
    brief = {
      originalText: text(item.originalText),
      structured: item.structured === null ? null : structuredBrief(item.structured),
      unresolvedQuestions: strings(item.unresolvedQuestions),
      version: integer(item.version),
      updatedAt: text(item.updatedAt),
    };
  }
  let latestRun: DiscoveryRunDto | null = null;
  if (runValue !== null) {
    const item = record(runValue);
    if (item.status !== "completed" && item.status !== "failed") invalid();
    latestRun = {
      id: text(item.id),
      status: item.status,
      modelId: text(item.modelId),
      policyVersion: text(item.policyVersion),
      briefVersion: integer(item.briefVersion),
      searchPlan: searchPlan(item.searchPlan),
      generatedAt: text(item.generatedAt),
      errorCode: nullableText(item.errorCode),
      shortfalls: Array.isArray(item.shortfalls) ? item.shortfalls.map(shortfall) : invalid(),
    };
  }
  return {
    discovery: {
      brief,
      latestRun,
      proposals: Array.isArray(root.proposals) ? root.proposals.map(proposal) : invalid(),
      feedback: Array.isArray(root.feedback) ? root.feedback.map(feedback) : invalid(),
      modelAvailable: typeof root.modelAvailable === "boolean" ? root.modelAvailable : invalid(),
      placeProviderAvailable: typeof root.placeProviderAvailable === "boolean" ? root.placeProviderAvailable : invalid(),
    },
  };
}
