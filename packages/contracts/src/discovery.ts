import { parseMemberVote, type MemberVoteDto } from "./trip-places";
import { isRecord } from "./type-guards";
import { isPlaceType, type PlaceType } from "./trip-skeleton";
export type DiscoveryProposalStatus = "pending" | "accepting" | "accepted" | "rejected";
/** Independent kinds of source that can vouch for a recommendation. */
export type DiscoveryEndorsement = "google_reviews" | "wikivoyage" | "official_tourism";
/** Google reviews vouch for a place only from this many reviews and this rating; the card states both. */
export const GOOGLE_MIN_REVIEWS = 200;
export const GOOGLE_MIN_RATING = 4;
export type DiscoveryShortfallCode =
  | "not_researched"
  | "not_found"
  | "name_mismatch"
  /** Its verified sources were not enough: none, or Wikivoyage alone (the name is historical). */
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
  /** Restoring a rejection names the version it undoes, so a stale undo cannot reopen a newer decision. */
  version: number;
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


export type DiscoveryClarifyVerdict = "sufficient" | "insufficient" | "unreasonable" | "unknown";

/** One checklist question. `answer` null with `skipped` false means not answered yet. */
export interface DiscoveryClarifyItemDto {
  id: string;
  text: string;
  /** One plain sentence: what this answer changes in the recommendations. */
  why: string;
  options: string[];
  allowOther: boolean;
  multiple: boolean;
  required: boolean;
  answer: string | null;
  skipped: boolean;
  /** The reviewer's judgement of the latest answer; null before review. */
  verdict: DiscoveryClarifyVerdict | null;
  /** Why more is needed (shown under the question); null when sufficient. */
  reason: string | null;
  /** Times the reviewer asked back about this question; capped at maxFollowUps. */
  followUps: number;
}

export interface DiscoveryClarificationDto {
  briefVersion: number;
  /** ready: every required answer was accepted, research may start. */
  status: "asking" | "ready";
  items: DiscoveryClarifyItemDto[];
  maxFollowUps: number;
  version: number;
}

export type DiscoveryStage = "plan" | "discover" | "research" | "verify" | "save" | "photos";
export const DISCOVERY_STAGES: readonly DiscoveryStage[] = ["plan", "discover", "research", "verify", "save", "photos"];
export type DiscoveryStageState = "pending" | "running" | "done" | "partial" | "failed";

export interface DiscoveryJobDto {
  id: string;
  briefVersion: number;
  status: "queued" | "running" | "succeeded" | "failed";
  stage: DiscoveryStage | null;
  stages: Record<DiscoveryStage, { state: DiscoveryStageState; startedAt: string | null; endedAt: string | null }>;
  errorCode: string | null;
  /** New places added by this job; set when the save stage finishes. */
  addedCount: number | null;
  createdAt: string;
  finishedAt: string | null;
  /** The requesting member already saw the finished result. */
  acknowledged: boolean;
}

export interface DiscoveryJobResponse {
  job: DiscoveryJobDto | null;
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
  /** The checklist for the current brief version; null until 調查 starts it. */
  clarification: DiscoveryClarificationDto | null;
  /** The trip's newest research job, so a reload resumes its progress. */
  latestJob: DiscoveryJobDto | null;
  modelAvailable: boolean;
  placeProviderAvailable: boolean;
  /**
   * Where the 調查 request that returned this workspace searched around. Set only on the
   * clarification and research start responses, for the member who sent them; null elsewhere.
   * Never carries coordinates.
   */
  searchCenter: DiscoverySearchCenterDto | null;
}

/** The phone's position the client sends with a 調查 start; rounded to 3 decimals, never stored. */
export interface DiscoveryNearInput {
  latitude: number;
  longitude: number;
}

export interface DiscoverySearchCenterDto {
  /** device: the member's current position; lodging: tonight's booked stay. */
  source: "device" | "lodging";
  /** The lodging's name; null for the device position. */
  label: string | null;
  /**
   * The lodging's map position (a trip place every member already sees), so the requesting phone
   * can show each result's distance from it. Null for the device: the phone knows its own.
   */
  position: DiscoveryNearInput | null;
}

/** How the traveler gets around from the search center (調查 asks before research). */
export type DiscoveryReachMode = "walk" | "transit" | "taxi";
export const DISCOVERY_REACH_MODES: readonly DiscoveryReachMode[] = ["walk", "transit", "taxi"];
/** Upper bound of 「5 分鐘以內」「6–10 分鐘」「15 分鐘以內」; null is 「都可以」. */
export type DiscoveryReachMinutes = 5 | 10 | 15;
export const DISCOVERY_REACH_MINUTES: readonly DiscoveryReachMinutes[] = [5, 10, 15];

export interface DiscoveryReachInput {
  mode: DiscoveryReachMode;
  /** null: no time limit (the search keeps its usual ~2 km bias and no distance filter). */
  maxMinutes: DiscoveryReachMinutes | null;
}

/**
 * Straight-line meters covered per minute: an ESTIMATE, not a route time. Walking ~3.6 km/h of
 * map distance; transit and taxi include waiting and street detours. 5/10/15 minutes therefore
 * mean walk 300/600/900 m, transit 925/1850/2775 m, taxi 1250/2500/3750 m from the center.
 */
export const DISCOVERY_REACH_METERS_PER_MINUTE: Readonly<Record<DiscoveryReachMode, number>> = {
  walk: 60,
  transit: 185,
  taxi: 250,
};

/** The straight-line radius a reach allows; null when the traveler chose 「都可以」. */
export function discoveryReachRadiusMeters(reach: DiscoveryReachInput): number | null {
  return reach.maxMinutes === null ? null : reach.maxMinutes * DISCOVERY_REACH_METERS_PER_MINUTE[reach.mode];
}

/** Estimated minutes for a straight-line distance by this mode, rounded up. */
export function discoveryReachEstimatedMinutes(mode: DiscoveryReachMode, meters: number) {
  return Math.max(1, Math.ceil(meters / DISCOVERY_REACH_METERS_PER_MINUTE[mode]));
}

export interface DiscoveryWorkspaceResponse {
  discovery: DiscoveryWorkspaceDto;
}

export interface SaveDiscoveryBriefInput {
  originalText: string;
  expectedVersion?: number | null;
}
export interface StartDiscoveryClarificationInput {
  expectedBriefVersion: number;
  near?: DiscoveryNearInput | null;
}

export interface AnswerDiscoveryClarificationInput {
  expectedVersion: number;
  /** null skips an optional question; required questions need text. */
  answers: Array<{ id: string; answer: string | null }>;
}

export interface StartDiscoveryResearchInput {
  expectedBriefVersion: number;
  near?: DiscoveryNearInput | null;
  /** Required whenever the server finds a search center (phone position or tonight's lodging). */
  reach?: DiscoveryReachInput | null;
}

export interface DecideCandidateProposalInput {
  expectedVersion: number;
}

export interface ScheduleDiscoveryProposalsInput {
  tripDayId: string;
  /** Between 1 and 100 distinct proposals; accepted proposals still require their current version. */
  proposals: Array<{ proposalId: string; expectedVersion: number }>;
}

export type ScheduleDiscoveryProposalsResponse = DiscoveryWorkspaceResponse;

export interface UpdateCandidateProposalVoteInput {
  voted: boolean;
}

export interface UpdateCandidateProposalVoteResponse {
  proposal: CandidateProposalDto;
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
    version: integer(item.version),
  };
}

function placeType(value: unknown): PlaceType {
  if (isPlaceType(value)) return value;
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
      // Replays stored before 調查 existed carry neither field.
      clarification: root.clarification == null ? null : parseDiscoveryClarification(root.clarification),
      latestJob: root.latestJob == null ? null : parseDiscoveryJob(root.latestJob),
      modelAvailable: typeof root.modelAvailable === "boolean" ? root.modelAvailable : invalid(),
      placeProviderAvailable: typeof root.placeProviderAvailable === "boolean" ? root.placeProviderAvailable : invalid(),
      // Responses other than the 調查 starts, and replays stored before it existed, carry none.
      searchCenter: root.searchCenter == null ? null : searchCenter(root.searchCenter),
    },
  };
}

function searchCenter(value: unknown): DiscoverySearchCenterDto {
  const item = record(value);
  if (item.source !== "device" && item.source !== "lodging") invalid();
  // Responses from before the position existed carry none.
  const position = item.position == null ? null : record(item.position);
  return {
    source: item.source,
    label: nullableText(item.label),
    position: position && typeof position.latitude === "number" && Number.isFinite(position.latitude)
      && typeof position.longitude === "number" && Number.isFinite(position.longitude)
      ? { latitude: position.latitude, longitude: position.longitude } : null,
  };
}

const CLARIFY_VERDICTS: readonly DiscoveryClarifyVerdict[] = ["sufficient", "insufficient", "unreasonable", "unknown"];
const STAGE_STATES: readonly DiscoveryStageState[] = ["pending", "running", "done", "partial", "failed"];

function boolean(value: unknown) {
  return typeof value === "boolean" ? value : invalid();
}

export function parseDiscoveryClarification(value: unknown): DiscoveryClarificationDto {
  const item = record(value);
  if (item.status !== "asking" && item.status !== "ready") invalid();
  if (!Array.isArray(item.items) || item.items.length > 5) invalid();
  return {
    briefVersion: integer(item.briefVersion),
    status: item.status,
    items: item.items.map((raw) => {
      const question = record(raw);
      const verdict = question.verdict === null ? null
        : CLARIFY_VERDICTS.includes(question.verdict as DiscoveryClarifyVerdict) ? question.verdict as DiscoveryClarifyVerdict : invalid();
      return {
        id: text(question.id),
        text: text(question.text),
        why: text(question.why),
        options: strings(question.options),
        allowOther: boolean(question.allowOther),
        multiple: boolean(question.multiple),
        required: boolean(question.required),
        answer: nullableText(question.answer),
        skipped: boolean(question.skipped),
        verdict,
        reason: nullableText(question.reason),
        followUps: integer(question.followUps),
      };
    }),
    maxFollowUps: integer(item.maxFollowUps),
    version: integer(item.version),
  };
}

export function parseDiscoveryJob(value: unknown): DiscoveryJobDto {
  const item = record(value);
  if (!["queued", "running", "succeeded", "failed"].includes(String(item.status))) invalid();
  const stage = item.stage === null ? null
    : DISCOVERY_STAGES.includes(item.stage as DiscoveryStage) ? item.stage as DiscoveryStage : invalid();
  const rawStages = record(item.stages);
  const stages = Object.fromEntries(DISCOVERY_STAGES.map((name) => {
    const entry = record(rawStages[name]);
    const state = STAGE_STATES.includes(entry.state as DiscoveryStageState) ? entry.state as DiscoveryStageState : invalid();
    return [name, { state, startedAt: nullableText(entry.startedAt), endedAt: nullableText(entry.endedAt) }];
  })) as DiscoveryJobDto["stages"];
  return {
    id: text(item.id),
    briefVersion: integer(item.briefVersion),
    status: item.status as DiscoveryJobDto["status"],
    stage,
    stages,
    errorCode: nullableText(item.errorCode),
    addedCount: item.addedCount === null ? null : integer(item.addedCount),
    createdAt: text(item.createdAt),
    finishedAt: nullableText(item.finishedAt),
    acknowledged: boolean(item.acknowledged),
  };
}

export function parseDiscoveryJobResponse(value: unknown): DiscoveryJobResponse {
  const root = record(value);
  return { job: root.job === null ? null : parseDiscoveryJob(root.job) };
}

export function parseScheduleDiscoveryProposalsResponse(value: unknown): ScheduleDiscoveryProposalsResponse {
  return parseDiscoveryWorkspaceResponse(value);
}

export function parseUpdateCandidateProposalVoteResponse(value: unknown): UpdateCandidateProposalVoteResponse {
  return { proposal: proposal(record(value).proposal) };
}
