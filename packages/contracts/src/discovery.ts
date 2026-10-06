import { parseMemberVote, type MemberVoteDto } from "./trip-places";
import { isRecord } from "./type-guards";
import type { PlaceType } from "./trip-skeleton";
export type DiscoveryProposalStatus = "pending" | "accepting" | "accepted" | "rejected";
export type DiscoveryFeedbackStatus = "pending" | "confirmed" | "rejected";
/** Independent kinds of source that can vouch for a recommendation. */
export type DiscoveryEndorsement = "google_reviews" | "wikivoyage" | "official_tourism";
export type DiscoveryShortfallCode =
  | "not_researched"
  | "not_found"
  | "name_mismatch"
  | "single_source"
  | "category_short"
  /** Already on the trip's shared wishlist, so not proposed again. */
  | "in_wishlist"
  /** A member rejected it in an earlier research run. */
  | "rejected"
  /** Google Maps lists it as permanently closed. */
  | "permanently_closed"
  /** Google Maps lists it as temporarily closed. */
  | "temporarily_closed"
  /** Its address is in none of the trip's countries. */
  | "outside_trip"
  /** Google Maps has no coordinates for it. */
  | "no_location";

export interface StructuredDiscoveryBriefDto {
  interests: string[];
  pace: string | null;
  budget: string | null;
  exclusions: string[];
  areas: string[];
}
export interface DiscoveryQuestionAnswerDto {
  question: string;
  /** Null means the traveler explicitly skipped this question and it remains unknown. */
  answer: string | null;
}


export interface DiscoveryBriefDto {
  originalText: string;
  structured: StructuredDiscoveryBriefDto | null;
  unresolvedQuestions: string[];
  questionAnswers: DiscoveryQuestionAnswerDto[];
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

export interface DiscoveryClaimSentenceDto {
  text: string;
  evidenceIds: string[];
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
  isStale: boolean;
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
  /** Sentence-level recommendation attribution; null for proposals created before this contract. */
  recommendationSentences: DiscoveryClaimSentenceDto[] | null;
  matchedNeeds: string[];
  tradeoffs: string[];
  /** Sentence-level tradeoff attribution; null for proposals created before this contract. */
  tradeoffSentences: DiscoveryClaimSentenceDto[] | null;
  unknowns: string[];
  status: DiscoveryProposalStatus;
  evidence: DiscoveryEvidenceDto[];
  voters: MemberVoteDto[];
  voteCount: number;
  ownVote: boolean;
  votingAvailable: boolean;
  acceptedTripPlaceId: string | null;
  version: number;
  /** Kind of place it answers; null for proposals from before kinds were recorded. */
  category: string | null;
  /** Independent sources that vouched for it; empty for older proposals. */
  endorsements: DiscoveryEndorsement[];
}

/** A proposal from an earlier research run that a member accepted or rejected. */
export interface DiscoveryDecisionDto {
  proposalId: string;
  providerPlaceId: string;
  name: string;
  status: "accepted" | "rejected";
  decidedAt: string;
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

export interface DiscoveryFeedbackInterpretationDto {
  interests: string[];
  exclusions: string[];
  pace: string | null;
  budget: string | null;
  summary: string;
}

export interface DiscoveryFeedbackDto {
  id: string;
  proposalId: string | null;
  proposalName: string | null;
  originalText: string;
  interpretation: DiscoveryFeedbackInterpretationDto;
  interpretationEdited: boolean;
  isOwn: boolean;
  status: DiscoveryFeedbackStatus;
  version: number;
  createdAt: string;
}

export interface DiscoveryWorkspaceDto {
  brief: DiscoveryBriefDto | null;
  latestRun: DiscoveryRunDto | null;
  proposals: CandidateProposalDto[];
  /**
   * Accepted or rejected places not among the latest run's proposals, newest decision first,
   * one per place; a new run replaces earlier undecided proposals.
   */
  decided: DiscoveryDecisionDto[];
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
export interface SaveDiscoveryQuestionAnswersInput {
  expectedVersion: number;
  answers: DiscoveryQuestionAnswerDto[];
}


export interface GenerateDiscoveryInput {
  expectedBriefVersion: number;
}

export interface DecideCandidateProposalInput {
  expectedVersion: number;
}
export interface UpdateCandidateProposalVoteInput {
  voted: boolean;
}


export interface CreateDiscoveryFeedbackInput {
  originalText: string;
}

export interface DecideDiscoveryFeedbackInput {
  expectedVersion: number;
  decision: "confirm" | "reject";
  interpretation?: DiscoveryFeedbackInterpretationDto;
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

function questionAnswer(value: unknown): DiscoveryQuestionAnswerDto {
  const item = record(value);
  return {
    question: text(item.question),
    answer: nullableText(item.answer),
  };
}

function feedbackInterpretation(value: unknown): DiscoveryFeedbackInterpretationDto {
  const item = record(value);
  return {
    interests: strings(item.interests),
    exclusions: strings(item.exclusions),
    pace: nullableText(item.pace),
    budget: nullableText(item.budget),
    summary: text(item.summary),
  };
}

function endorsements(value: unknown): DiscoveryEndorsement[] {
  return strings(value).map((entry) =>
    entry === "google_reviews" || entry === "wikivoyage" || entry === "official_tourism" ? entry : invalid()
  );
}


const SHORTFALL_CODES: readonly DiscoveryShortfallCode[] = [
  "not_researched", "not_found", "name_mismatch", "single_source", "category_short", "in_wishlist", "rejected",
  "permanently_closed", "temporarily_closed", "outside_trip", "no_location",
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

function decision(value: unknown): DiscoveryDecisionDto {
  const item = record(value);
  if (item.status !== "accepted" && item.status !== "rejected") invalid();
  return {
    proposalId: text(item.proposalId),
    providerPlaceId: text(item.providerPlaceId),
    name: text(item.name),
    status: item.status,
    decidedAt: text(item.decidedAt),
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

function claimSentence(value: unknown): DiscoveryClaimSentenceDto {
  const item = record(value);
  return {
    text: text(item.text),
    evidenceIds: strings(item.evidenceIds),
  };
}

function nullableClaimSentences(value: unknown) {
  return value === null
    ? null
    : Array.isArray(value)
      ? value.map(claimSentence)
      : invalid();
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
    isStale: typeof item.isStale === "boolean" ? item.isStale : invalid(),
  };
}

function proposal(value: unknown): CandidateProposalDto {
  const item = record(value);
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
    recommendationSentences: nullableClaimSentences(item.recommendationSentences),
    matchedNeeds: strings(item.matchedNeeds),
    tradeoffs: strings(item.tradeoffs),
    tradeoffSentences: nullableClaimSentences(item.tradeoffSentences),
    unknowns: strings(item.unknowns),
    status: item.status as DiscoveryProposalStatus,
    evidence: Array.isArray(item.evidence) ? item.evidence.map(evidence) : invalid(),
    voters: Array.isArray(item.voters) ? item.voters.map(parseMemberVote) : invalid(),
    voteCount: integer(item.voteCount),
    ownVote: typeof item.ownVote === "boolean" ? item.ownVote : invalid(),
    votingAvailable: typeof item.votingAvailable === "boolean" ? item.votingAvailable : invalid(),
    acceptedTripPlaceId: nullableText(item.acceptedTripPlaceId),
    version: integer(item.version),
    category: nullableText(item.category),
    endorsements: endorsements(item.endorsements),
  };
}

function feedback(value: unknown): DiscoveryFeedbackDto {
  const item = record(value);
  if (!["pending", "confirmed", "rejected"].includes(String(item.status))) invalid();
  return {
    id: text(item.id),
    proposalId: nullableText(item.proposalId),
    proposalName: nullableText(item.proposalName),
    originalText: text(item.originalText),
    interpretation: feedbackInterpretation(item.interpretation),
    interpretationEdited: typeof item.interpretationEdited === "boolean" ? item.interpretationEdited : invalid(),
    isOwn: typeof item.isOwn === "boolean" ? item.isOwn : invalid(),
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
      questionAnswers: Array.isArray(item.questionAnswers)
        ? item.questionAnswers.map(questionAnswer)
        : invalid(),
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
      decided: Array.isArray(root.decided) ? root.decided.map(decision) : invalid(),
      feedback: Array.isArray(root.feedback) ? root.feedback.map(feedback) : invalid(),
      modelAvailable: typeof root.modelAvailable === "boolean" ? root.modelAvailable : invalid(),
      placeProviderAvailable: typeof root.placeProviderAvailable === "boolean" ? root.placeProviderAvailable : invalid(),
    },
  };
}
