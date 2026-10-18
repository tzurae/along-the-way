import { isRecord } from "./type-guards";

export type FeedbackType = "bug" | "idea" | "other";
export type FeedbackStatus = "new" | "in_progress" | "done" | "wont_do";

export interface CreateFeedbackInput {
  type: FeedbackType;
  body: string;
  page: string | null;
  tripId: string | null;
  contactAllowed: boolean;
  viewport: string | null;
}

export interface CreateFeedbackResponse {
  id: string;
}

export interface FeedbackAdminDto {
  id: string;
  type: FeedbackType;
  body: string;
  page: string | null;
  tripId: string | null;
  tripName: string | null;
  submitterEmail: string | null;
  appVersion: string;
  userAgent: string | null;
  viewport: string | null;
  status: FeedbackStatus;
  adminNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackAdminListResponse {
  feedback: FeedbackAdminDto[];
}

export interface UpdateFeedbackAdminInput {
  status?: FeedbackStatus;
  adminNote?: string | null;
}

export interface GoogleServiceUsageDto {
  service: string;
  displayName: string;
  today: number | null;
  /** null means Monitoring returned no point for that quota day; it must not be displayed as zero. */
  last7Days: Array<{ date: string; count: number | null }>;
}

export interface GoogleQuotaUsageDto {
  service: string;
  quotaMetric: string;
  limitName: string;
  usageToday: number | null;
  limit: number | null;
}

export interface GoogleProjectUsageDto {
  projectId: string;
  label: string;
  dataTime: string | null;
  error: string | null;
  services: GoogleServiceUsageDto[];
  quotas: GoogleQuotaUsageDto[];
}

export interface GoogleUsageDto {
  generatedAt: string;
  cloud: {
    configured: boolean;
    projects: GoogleProjectUsageDto[];
  };
  app: {
    environment: string;
    googlePlacesToday: number;
    googlePlacesLimit: number;
    googleMapsJsToday: number;
    googleMapsJsLimit: number;
    photoMetadataThisHour: number;
    photoMetadataLimit: number;
  };
}

function invalidResponse(): never {
  throw new Error("Invalid API response");
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : invalidResponse();
}

function nullableStringValue(value: unknown) {
  return value === null || typeof value === "string" ? value : invalidResponse();
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : invalidResponse();
}

function nullableNumberValue(value: unknown) {
  return value === null ? null : numberValue(value);
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : invalidResponse();
}

function feedbackTypeValue(value: unknown): FeedbackType {
  return value === "bug" || value === "idea" || value === "other" ? value : invalidResponse();
}

function feedbackStatusValue(value: unknown): FeedbackStatus {
  return value === "new" || value === "in_progress" || value === "done" || value === "wont_do"
    ? value
    : invalidResponse();
}

function feedbackAdminValue(value: unknown): FeedbackAdminDto {
  if (!isRecord(value)) return invalidResponse();
  return {
    id: stringValue(value.id),
    type: feedbackTypeValue(value.type),
    body: stringValue(value.body),
    page: nullableStringValue(value.page),
    tripId: nullableStringValue(value.tripId),
    tripName: nullableStringValue(value.tripName),
    submitterEmail: nullableStringValue(value.submitterEmail),
    appVersion: stringValue(value.appVersion),
    userAgent: nullableStringValue(value.userAgent),
    viewport: nullableStringValue(value.viewport),
    status: feedbackStatusValue(value.status),
    adminNote: nullableStringValue(value.adminNote),
    createdAt: stringValue(value.createdAt),
    updatedAt: stringValue(value.updatedAt),
  };
}

function googleServiceValue(value: unknown): GoogleServiceUsageDto {
  if (!isRecord(value) || !Array.isArray(value.last7Days)) return invalidResponse();
  return {
    service: stringValue(value.service),
    displayName: stringValue(value.displayName),
    today: nullableNumberValue(value.today),
    last7Days: value.last7Days.map((day) => {
      if (!isRecord(day)) return invalidResponse();
      return { date: stringValue(day.date), count: nullableNumberValue(day.count) };
    }),
  };
}

function googleQuotaValue(value: unknown): GoogleQuotaUsageDto {
  if (!isRecord(value)) return invalidResponse();
  return {
    service: stringValue(value.service),
    quotaMetric: stringValue(value.quotaMetric),
    limitName: stringValue(value.limitName),
    usageToday: nullableNumberValue(value.usageToday),
    limit: nullableNumberValue(value.limit),
  };
}

function googleProjectValue(value: unknown): GoogleProjectUsageDto {
  if (!isRecord(value) || !Array.isArray(value.services) || !Array.isArray(value.quotas)) {
    return invalidResponse();
  }
  return {
    projectId: stringValue(value.projectId),
    label: stringValue(value.label),
    dataTime: nullableStringValue(value.dataTime),
    error: nullableStringValue(value.error),
    services: value.services.map(googleServiceValue),
    quotas: value.quotas.map(googleQuotaValue),
  };
}

export function parseCreateFeedbackResponse(value: unknown): CreateFeedbackResponse {
  if (!isRecord(value)) return invalidResponse();
  return { id: stringValue(value.id) };
}

export function parseFeedbackAdminResponse(value: unknown): FeedbackAdminDto {
  return feedbackAdminValue(value);
}

export function parseFeedbackAdminListResponse(value: unknown): FeedbackAdminListResponse {
  if (!isRecord(value) || !Array.isArray(value.feedback)) return invalidResponse();
  return { feedback: value.feedback.map(feedbackAdminValue) };
}

export function parseGoogleUsageResponse(value: unknown): GoogleUsageDto {
  if (!isRecord(value) || !isRecord(value.cloud) || !Array.isArray(value.cloud.projects)
    || !isRecord(value.app)) return invalidResponse();
  return {
    generatedAt: stringValue(value.generatedAt),
    cloud: {
      configured: booleanValue(value.cloud.configured),
      projects: value.cloud.projects.map(googleProjectValue),
    },
    app: {
      environment: stringValue(value.app.environment),
      googlePlacesToday: numberValue(value.app.googlePlacesToday),
      googlePlacesLimit: numberValue(value.app.googlePlacesLimit),
      googleMapsJsToday: numberValue(value.app.googleMapsJsToday),
      googleMapsJsLimit: numberValue(value.app.googleMapsJsLimit),
      photoMetadataThisHour: numberValue(value.app.photoMetadataThisHour),
      photoMetadataLimit: numberValue(value.app.photoMetadataLimit),
    },
  };
}
