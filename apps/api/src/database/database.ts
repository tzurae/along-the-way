import {
  Kysely,
  PostgresDialect,
  type ColumnType,
  type Generated,
} from "kysely";
import { Pool } from "pg";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type DateOnly = ColumnType<Date, string, string>;
type BigInteger = ColumnType<string, number, number>;

export interface UserTable {
  id: Generated<string>;
  email: string;
  display_name: string | null;
  status: "active";
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface MagicLinkTokenTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  linked_invite_id: string | null;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  revoked_at: Timestamp | null;
  created_at: Timestamp;
}

export interface SessionTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  expires_at: Timestamp;
  last_seen_at: Timestamp;
  revoked_at: Timestamp | null;
  created_at: Timestamp;
}

export interface TripTable {
  id: Generated<string>;
  name: string;
  start_date: DateOnly;
  end_date: DateOnly;
  time_zone: string;
  currency: string;
  default_currency: string | null;
  status: "planning";
  version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TripDestinationTable {
  id: Generated<string>;
  trip_id: string;
  name: string;
  position: number;
}

export interface TripCountryStopTable {
  id: Generated<string>;
  trip_id: string;
  country_code: string;
  position: number;
  time_zone: string | null;
}

export interface TripDayTable {
  id: Generated<string>;
  trip_id: string;
  date: DateOnly;
  title: string | null;
  /** Planned day window in minutes from local midnight; defaults to 09:00–19:00. */
  day_start_minute: Generated<number>;
  day_end_minute: Generated<number>;
}

export interface PlaceTable {
  id: Generated<string>;
  trip_id: string;
  name: string;
  place_type: "airport" | "station" | "lodging" | "restaurant" | "activity" | "other";
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  time_zone: string | null;
  source_url: string | null;
  notes: string | null;
  version: Generated<number>;
  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface LegacyPlaceOriginTable {
  trip_id: string;
  place_id: string;
  created_by: string;
  source_url: string | null;
  original_note: string | null;
  created_at: Timestamp;
}

export interface PlaceIdentityTable {
  id: Generated<string>;
  provider: "google" | "manual";
  provider_place_id: string | null;
  canonical_name: string;
  canonical_type: "airport" | "station" | "lodging" | "restaurant" | "activity" | "other";
  canonical_address: string | null;
  latitude: number | null;
  longitude: number | null;
  time_zone: string | null;
  provider_observed_at: Timestamp | null;
  provider_expires_at: Timestamp | null;
  provider_attribution: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TripPlaceTable {
  id: Generated<string>;
  trip_id: string;
  place_id: string;
  legacy_place_id: string;
  legacy_place_version: number;
  facts_source: "provider" | "member";
  name: string;
  place_type: "airport" | "station" | "lodging" | "restaurant" | "activity" | "other";
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  time_zone: string | null;
  duration_minutes: number | null;
  budget_amount_minor: BigInteger | null;
  budget_currency: string | null;
  notes: string | null;
  provider_unavailable: Generated<boolean>;
  archived_at: Timestamp | null;
  version: Generated<number>;
  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TripPlaceContributionTable {
  id: Generated<string>;
  trip_id: string;
  trip_place_id: string;
  member_user_id: string;
  intake_method: "google-maps-url" | "search" | "manual";
  source_url: string | null;
  original_note: string | null;
  provider_observed_at: Timestamp | null;
  withdrawn_at: Timestamp | null;
  created_at: Timestamp;
}

export interface MemberPlacePreferenceTable {
  trip_id: string;
  trip_place_id: string;
  member_user_id: string;
  preference: "must" | "want" | "optional" | "neutral" | "dislike";
  version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TripPlaceDayTable {
  trip_id: string;
  trip_place_id: string;
  trip_day_id: string;
}

export interface TripPlaceDayAssignmentTable {
  trip_id: string;
  trip_place_id: string;
  trip_day_id: string;
  assigned_by: string;
  assigned_at: Timestamp;
  /** Applied order within the day; null until a route order is applied. */
  day_position: number | null;
}

export interface TripPlaceDuplicateSuggestionTable {
  id: Generated<string>;
  trip_id: string;
  first_trip_place_id: string;
  second_trip_place_id: string;
  reason: string;
  status: "pending" | "kept-separate";
  decided_by: string | null;
  decided_at: Timestamp | null;
  created_at: Timestamp;
}

export interface DiscoveryBriefTable {
  trip_id: string;
  original_text: string;
  structured_brief: unknown | null;
  unresolved_questions: unknown;
  question_answers: Generated<unknown>;
  version: Generated<number>;
  updated_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DiscoveryRunTable {
  id: Generated<string>;
  trip_id: string;
  brief_version: number;
  policy_version: string;
  model_id: string;
  status: "completed" | "failed";
  search_plan: unknown;
  error_code: string | null;
  created_by: string;
  created_at: Timestamp;
  completed_at: Timestamp;
  /** DiscoveryShortfallDto[]; empty for runs from before shortfalls were recorded. */
  shortfalls: Generated<unknown>;
}

export interface DiscoveryEvidenceTable {
  id: Generated<string>;
  trip_id: string;
  run_id: string;
  evidence_kind: "google-place" | "web-source";
  provider_place_id: string | null;
  source_url: string;
  title: string;
  attribution: string;
  observed_at: Timestamp;
  expires_at: Timestamp | null;
  facts: unknown;
}

export interface CandidateProposalTable {
  id: Generated<string>;
  trip_id: string;
  run_id: string;
  provider_place_id: string;
  name: string;
  place_type: "airport" | "station" | "lodging" | "restaurant" | "activity" | "other";
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  source_url: string | null;
  recommendation: string;
  matched_needs: unknown;
  tradeoffs: unknown;
  unknowns: unknown;
  confidence: "high" | "medium" | "low";
  status: "pending" | "accepting" | "accepted" | "rejected";
  accepted_trip_place_id: string | null;
  decided_by: string | null;
  decided_at: Timestamp | null;
  version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
  category: string | null;
  /** DiscoveryEndorsement[]; empty for proposals from before endorsements were recorded. */
  endorsements: Generated<unknown>;
  /** DiscoveryClaimSentenceDto[]; null for proposals created before sentence attribution. */
  recommendation_sentences: Generated<unknown | null>;
  /** DiscoveryClaimSentenceDto[]; null for proposals created before sentence attribution. */
  tradeoff_sentences: Generated<unknown | null>;
}
export interface DiscoveryProposalPreferenceTable {
  trip_id: string;
  proposal_id: string;
  member_user_id: string;
  preference: "must" | "want" | "optional" | "neutral" | "dislike";
  version: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}


export interface CandidateProposalEvidenceTable {
  proposal_id: string;
  evidence_id: string;
}

export interface DiscoveryFeedbackTable {
  id: Generated<string>;
  trip_id: string;
  proposal_id: string | null;
  actor_id: string;
  original_text: string;
  interpretation: unknown;
  interpretation_edited: Generated<boolean>;
  status: "pending" | "confirmed" | "rejected";
  version: Generated<number>;
  decided_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ItineraryItemTable {
  id: Generated<string>;
  trip_id: string;
  item_type:
    | "flight"
    | "lodging"
    | "transport"
    | "reservation"
    | "meal"
    | "activity"
    | "free-time";
  title: string;
  notes: string | null;
  source_url: string | null;
  amount_minor: BigInteger | null;
  currency: string | null;
  details: unknown;
  locked_at: Timestamp | null;
  locked_by: string | null;
  version: Generated<number>;
  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ItineraryItemParticipantTable {
  trip_id: string;
  itinerary_item_id: string;
  member_id: string;
}

export interface ItineraryEndpointTable {
  itinerary_item_id: string;
  trip_id: string;
  endpoint_role: "start" | "end";
  country_stop_id: string | null;
  place_id: string;
  local_date_time: string;
  time_zone: string;
  utc_offset_minutes: number;
  instant: Timestamp;
}

export interface ItineraryConstraintTable {
  id: Generated<string>;
  trip_id: string;
  itinerary_item_id: string;
  constraint_type: "fixed_time" | "immovable" | "minimum_buffer";
  status: "confirmed" | "unknown" | "conflicted";
  minimum_buffer_minutes: number | null;
  version: Generated<number>;
  created_by: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TripMemberTable {
  id: Generated<string>;
  trip_id: string;
  user_id: string;
  role: "owner" | "editor";
  joined_at: Timestamp;
  removed_at: Timestamp | null;
}

export interface InviteTable {
  id: Generated<string>;
  trip_id: string;
  email: string;
  role: "editor";
  token_hash: string;
  expires_at: Timestamp;
  accepted_at: Timestamp | null;
  accepted_by: string | null;
  revoked_at: Timestamp | null;
  invited_by: string;
  created_at: Timestamp;
}

export interface MutationRequestTable {
  actor_id: string;
  operation: string;
  idempotency_key: string;
  response: unknown;
  created_at: Timestamp;
}

export interface EmailJobTable {
  id: Generated<string>;
  kind: "magic_link" | "trip_invite";
  recipient: string;
  magic_link_token_id: string | null;
  invite_id: string | null;
  attempt_count: Generated<number>;
  available_at: Timestamp;
  delivered_at: Timestamp | null;
  created_at: Timestamp;
}

export interface RateLimitWindowTable {
  scope: string;
  key_hash: string;
  window_start: Timestamp;
  request_count: number;
}

export interface WorkerHeartbeatTable {
  worker_name: string;
  last_seen_at: Timestamp;
}

export interface ChangeEventTable {
  id: Generated<string>;
  trip_id: string;
  actor_id: string;
  event_type: string;
  target_type: string;
  target_id: string;
  summary: string;
  created_at: Timestamp;
}

export interface AlongTheWayDatabase {
  users: UserTable;
  magic_link_tokens: MagicLinkTokenTable;
  sessions: SessionTable;
  trips: TripTable;
  trip_destinations: TripDestinationTable;
  trip_country_stops: TripCountryStopTable;
  trip_days: TripDayTable;
  places: PlaceTable;
  legacy_place_origins: LegacyPlaceOriginTable;
  place_identities: PlaceIdentityTable;
  trip_places: TripPlaceTable;
  trip_place_contributions: TripPlaceContributionTable;
  member_place_preferences: MemberPlacePreferenceTable;
  trip_place_desired_days: TripPlaceDayTable;
  trip_place_excluded_days: TripPlaceDayTable;
  trip_place_day_assignments: TripPlaceDayAssignmentTable;
  trip_place_duplicate_suggestions: TripPlaceDuplicateSuggestionTable;
  discovery_briefs: DiscoveryBriefTable;
  discovery_runs: DiscoveryRunTable;
  discovery_evidence: DiscoveryEvidenceTable;
  candidate_proposals: CandidateProposalTable;
  candidate_proposal_evidence: CandidateProposalEvidenceTable;
  discovery_proposal_preferences: DiscoveryProposalPreferenceTable;
  discovery_feedback: DiscoveryFeedbackTable;
  itinerary_items: ItineraryItemTable;
  itinerary_item_participants: ItineraryItemParticipantTable;
  itinerary_endpoints: ItineraryEndpointTable;
  itinerary_constraints: ItineraryConstraintTable;
  trip_members: TripMemberTable;
  invites: InviteTable;
  mutation_requests: MutationRequestTable;
  change_events: ChangeEventTable;
  email_jobs: EmailJobTable;
  rate_limit_windows: RateLimitWindowTable;
  worker_heartbeats: WorkerHeartbeatTable;
}

export function createDatabase(databaseUrl: string) {
  return new Kysely<AlongTheWayDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 30_000,
        max: 10,
        query_timeout: 5_000,
        statement_timeout: 5_000,
      }),
    }),
  });
}

export function requireDatabaseUrl(
  environment: Record<string, string | undefined> = process.env,
) {
  const databaseUrl = environment.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  return databaseUrl;
}
