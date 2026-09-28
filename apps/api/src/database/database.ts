import {
  Kysely,
  PostgresDialect,
  type ColumnType,
  type Generated,
} from "kysely";
import { Pool } from "pg";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type DateOnly = ColumnType<Date, string, string>;

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
}

export interface TripMemberTable {
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
