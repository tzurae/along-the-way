import { parseDayTimeline, type DayTimeline } from "./day-timeline";
import { isRecord } from "./type-guards";

export type PacePreset = "chill" | "balanced" | "packed" | "custom";
export type TravelProfile = "walk" | "transit" | "car" | "custom";
export type PlanningEstimateSource = "member" | "ai" | "default";
export interface PlanningSettings {
  pacePreset: PacePreset;
  targetPlacesPerDay: number;
  maxPlacesPerDay: number;
  dayStart: string;
  dayEnd: string;
  maxEffortPerDay: number;
  mealReserveMinutes: number;
  restMinutes: number;
  slackPercent: number;
  travelProfile: TravelProfile;
  speedKmh: number;
  detourFactor: number;
  perLegMinutes: number;
  lightTravelDays: boolean;
}
export const OVERRIDABLE_PLANNING_FIELDS = [
  "targetPlacesPerDay", "maxPlacesPerDay", "dayStart", "dayEnd", "maxEffortPerDay",
  "mealReserveMinutes", "restMinutes", "slackPercent",
] as const;
export type PlanningOverrideField = typeof OVERRIDABLE_PLANNING_FIELDS[number];
export type PlanningOverride = { [K in PlanningOverrideField]: PlanningSettings[K] | null };
export const EMPTY_PLANNING_OVERRIDE: PlanningOverride = {
  targetPlacesPerDay: null, maxPlacesPerDay: null, dayStart: null, dayEnd: null,
  maxEffortPerDay: null,
  mealReserveMinutes: null, restMinutes: null, slackPercent: null,
};
export const TRAVEL_PROFILES = {
  walk: { speedKmh: 4, detourFactor: 1.3, perLegMinutes: 0 },
  transit: { speedKmh: 15, detourFactor: 1.35, perLegMinutes: 10 },
  car: { speedKmh: 25, detourFactor: 1.4, perLegMinutes: 5 },
} as const;
export const PACE_PRESETS = {
  chill: { targetPlacesPerDay: 2, maxPlacesPerDay: 3, dayStart: "10:00", dayEnd: "18:00", maxEffortPerDay: 6, mealReserveMinutes: 60, restMinutes: 60, slackPercent: 20 },
  balanced: { targetPlacesPerDay: 3, maxPlacesPerDay: 4, dayStart: "09:00", dayEnd: "19:00", maxEffortPerDay: 10, mealReserveMinutes: 60, restMinutes: 30, slackPercent: 15 },
  packed: { targetPlacesPerDay: 5, maxPlacesPerDay: 6, dayStart: "08:00", dayEnd: "21:00", maxEffortPerDay: 15, mealReserveMinutes: 45, restMinutes: 15, slackPercent: 10 },
} as const;
export const DEFAULT_PLANNING_SETTINGS: PlanningSettings = {
  pacePreset: "balanced", ...PACE_PRESETS.balanced,
  travelProfile: "transit", ...TRAVEL_PROFILES.transit, lightTravelDays: true,
};
export interface PlanningSettingsResponse {
  raw: PlanningSettings | null;
  resolved: PlanningSettings;
  defaults: PlanningSettings;
  version: number;
}
export interface PlanningOverrideResponse {
  dayId: string;
  raw: PlanningOverride | null;
  effective: PlanningSettings;
  version: number;
}
export interface PutPlanningSettingsInput { expectedVersion: number; values: PlanningSettings }
export interface PutPlanningOverrideInput { expectedVersion: number; values: PlanningOverride }
export interface DeletePlanningOverrideInput { expectedVersion: number }
export interface PlanningDraftOverride { dayId: string; expectedVersion: number; values: PlanningOverride | null }
export interface PlanningDrafts {
  draftSettings?: PutPlanningSettingsInput;
  draftOverrides?: PlanningDraftOverride[];
}
export interface PlanningEstimateDto {
  visitMinutes: number;
  effortLevel: number;
  visitSource: PlanningEstimateSource;
  effortSource: PlanningEstimateSource;
}
// v2 (2026-10-19): the straight-line km caps were removed; v1 proposals become stale.
export const PLANNING_POLICY_VERSION = "whole-trip-planner-v2";

function invalid(field = "response"): never { throw new Error(`Invalid planning ${field}`); }
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : invalid(); }
function text(value: unknown): string { return typeof value === "string" ? value : invalid(); }
function number(value: unknown, min: number, max: number, integer = false): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    && (!integer || Number.isSafeInteger(value)) ? value : invalid();
}
function version(value: unknown): number { return number(value, 0, Number.MAX_SAFE_INTEGER, true); }
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  return typeof value === "string" && choices.includes(value as T) ? value as T : invalid();
}
function clock(value: unknown, allowMidnight = false): string {
  return typeof value === "string" && (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) || (allowMidnight && value === "24:00")) ? value : invalid();
}
export function planningClockMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour! * 60 + minute!;
}
export function validatePlanningCrossFields(value: PlanningSettings): void {
  const window = planningClockMinutes(value.dayEnd) - planningClockMinutes(value.dayStart);
  if (value.targetPlacesPerDay > value.maxPlacesPerDay || window <= 0
    || window - value.mealReserveMinutes - value.restMinutes - Math.ceil(window * value.slackPercent / 100) <= 0) invalid("cross-field values");
}
function fields(value: Record<string, unknown>): Pick<PlanningSettings, PlanningOverrideField> {
  return {
    targetPlacesPerDay: number(value.targetPlacesPerDay, 0, 10, true),
    maxPlacesPerDay: number(value.maxPlacesPerDay, 1, 12, true),
    dayStart: clock(value.dayStart), dayEnd: clock(value.dayEnd, true),
    maxEffortPerDay: number(value.maxEffortPerDay, 1, 25, true),
    mealReserveMinutes: number(value.mealReserveMinutes, 0, 180, true),
    restMinutes: number(value.restMinutes, 0, 180, true),
    slackPercent: number(value.slackPercent, 0, 40, true),
  };
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid("field");
}
export function parsePlanningSettings(value: unknown): PlanningSettings {
  const row = record(value);
  exactKeys(row, Object.keys(DEFAULT_PLANNING_SETTINGS));
  const settings: PlanningSettings = {
    ...fields(row), pacePreset: oneOf(row.pacePreset, ["chill", "balanced", "packed", "custom"]),
    travelProfile: oneOf(row.travelProfile, ["walk", "transit", "car", "custom"]),
    speedKmh: number(row.speedKmh, 2.5, 60), detourFactor: number(row.detourFactor, 1, 2),
    perLegMinutes: number(row.perLegMinutes, 0, 30, true),
    lightTravelDays: typeof row.lightTravelDays === "boolean" ? row.lightTravelDays : invalid(),
  };
  validatePlanningCrossFields(settings);
  return settings;
}
export function parsePlanningOverride(value: unknown): PlanningOverride {
  const row = record(value);
  exactKeys(row, OVERRIDABLE_PLANNING_FIELDS);
  const nonNull = fields({ ...PACE_PRESETS.balanced, ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null)) });
  const result = { ...EMPTY_PLANNING_OVERRIDE };
  for (const key of OVERRIDABLE_PLANNING_FIELDS) {
    if (!(key in row)) invalid(key);
    Object.assign(result, { [key]: row[key] === null ? null : nonNull[key] });
  }
  return result;
}
/** Flight reductions are independent per field; they intentionally may put a soft target above its hard cap. */
export function resolvePlanningSettings(settings: PlanningSettings, override: PlanningOverride | null, flightDay: boolean): PlanningSettings {
  const result = { ...settings };
  if (settings.lightTravelDays && flightDay) {
    if (override?.maxPlacesPerDay == null) result.maxPlacesPerDay = Math.max(1, Math.floor(result.maxPlacesPerDay / 2));
    if (override?.maxEffortPerDay == null) result.maxEffortPerDay = Math.max(1, Math.floor(result.maxEffortPerDay / 2));
  }
  for (const key of OVERRIDABLE_PLANNING_FIELDS) {
    if (override?.[key] != null) Object.assign(result, { [key]: override[key] });
  }
  return result;
}
export function parsePutPlanningSettingsInput(value: unknown): PutPlanningSettingsInput {
  const row = record(value); exactKeys(row, ["expectedVersion", "values"]);
  return { expectedVersion: version(row.expectedVersion), values: parsePlanningSettings(row.values) };
}
export function parsePutPlanningOverrideInput(value: unknown): PutPlanningOverrideInput {
  const row = record(value); exactKeys(row, ["expectedVersion", "values"]);
  return { expectedVersion: version(row.expectedVersion), values: parsePlanningOverride(row.values) };
}
export function parseDeletePlanningOverrideInput(value: unknown): DeletePlanningOverrideInput {
  const row = record(value); exactKeys(row, ["expectedVersion"]);
  return { expectedVersion: version(row.expectedVersion) };
}
export function parsePlanningSettingsResponse(value: unknown): PlanningSettingsResponse {
  const row = record(value);
  return { raw: row.raw === null ? null : parsePlanningSettings(row.raw), resolved: parsePlanningSettings(row.resolved), defaults: parsePlanningSettings(row.defaults), version: version(row.version) };
}
export function parsePlanningOverrideResponse(value: unknown): PlanningOverrideResponse {
  const row = record(value);
  // Effective caps can have a soft target above the flight-reduced hard cap.
  const effective = record(row.effective);
  const parsed = parsePlanningSettings({ ...effective, targetPlacesPerDay: Math.min(number(effective.targetPlacesPerDay, 0, 10, true), number(effective.maxPlacesPerDay, 1, 12, true)) });
  parsed.targetPlacesPerDay = number(effective.targetPlacesPerDay, 0, 10, true);
  return { dayId: text(row.dayId), raw: row.raw === null ? null : parsePlanningOverride(row.raw), effective: parsed, version: version(row.version) };
}

export type PlanningDayStatus = "valid" | "over_cap" | "unverifiable_distance" | "baseline_unverifiable";
export type PlanningCheckCode = "count" | "effort" | "budget" | "unverifiable_distance" | "baseline_unverifiable";
export interface PlanningBlockingCheckDto {
  dayId: string; code: PlanningCheckCode; current: number; added: number; cap: number;
}
export interface PlanningEndpointDto { id: string; coordinates: { latitude: number; longitude: number } | null }
export interface PlanningRouteNodeDto { id: string; kind: "lodging" | "anchor" | "flexible" | "pinned"; start: PlanningEndpointDto; end: PlanningEndpointDto }
export interface PlanningDayLoadDto {
  dayId: string; date?: string; status: PlanningDayStatus; caps: PlanningSettings;
  override?: PlanningOverride | null; overrideVersion?: number;
  windowStartMinute: number; windowEndMinute: number; windowMinutes: number;
  fixedOccupancyMinutes: number; mealReserveMinutes: number; restMinutes: number; slackMinutes: number;
  budgetMinutes: number; visitMinutes: number; travelMinutes: number; loadMinutes: number; totalMinutes: number;
  count: number; effort: number; straightMetres: number; utilisation: number;
  noLodging: boolean; missingCoordinateIds: string[]; unresolvedItemIds: string[];
  route: PlanningRouteNodeDto[];
  legs: { fromId: string; toId: string; metres: number; travelMinutes: number }[];
  checks: PlanningBlockingCheckDto[];
}
export interface PlanningLoadResponse {
  days: PlanningDayLoadDto[];
  estimates: Record<string, PlanningEstimateDto>;
  counts: { flexible: number; fixedSelected: number; days: number; aiPending: number };
  settingsVersion: number;
}
export type WholeTripPlanStatus = "complete" | "baseline_conflict" | "proven_infeasible" | "search_incomplete";
export type PlanningConflictCode = "fixed_baseline_over_cap" | "baseline_unverifiable"
  | "existing_count_over_cap" | "existing_effort_over_cap" | "existing_budget_over_cap"
  | "existing_unverifiable_distance"
  | "missing_coordinates" | "total_capacity" | "place_exceeds_every_day";
export interface WholeTripPlanResultDto {
  status: WholeTripPlanStatus;
  /** timeline: the day's straight-line timeline (f5 1a); absent on older drafts, null for a day without stops. */
  days: { dayId: string; orderedPlaceIds: string[]; load: PlanningDayLoadDto; timeline?: DayTimeline | null }[];
  conflicts: { code: PlanningConflictCode; dayId?: string; placeId?: string; checks: PlanningBlockingCheckDto[] }[];
  unplaced: { placeId: string; reasons: PlanningBlockingCheckDto[] }[];
  excludedPlaceIds: string[];
  suggestions: { placeId: string; dayId: string; overrides: Partial<PlanningOverride>; relativeIncrease: number; fieldsChanged: number }[];
}
export interface WholeTripPlanPreviewInput extends PlanningDrafts { mode: "keep" | "replan"; useAi: boolean }
export interface WholeTripPlanProposalDto extends WholeTripPlanPreviewInput {
  id: string; tripId: string; createdAt: string; expiresAt: string; inputRevision: string;
  estimates: Record<string, PlanningEstimateDto>; result: WholeTripPlanResultDto;
}
export interface WholeTripPlanProposalResponse { proposal: WholeTripPlanProposalDto }
export interface ApplyWholeTripPlanResponse { proposalId: string; placedCount: number; dayIds: string[] }

function array<T>(value: unknown, parse: (item: unknown) => T): T[] {
  return Array.isArray(value) ? value.map(parse) : invalid();
}
function boolean(value: unknown): boolean { return typeof value === "boolean" ? value : invalid(); }
function finite(value: unknown): number { return number(value, -Number.MAX_VALUE, Number.MAX_VALUE); }
function estimate(value: unknown): PlanningEstimateDto {
  const row = record(value);
  return { visitMinutes: number(row.visitMinutes, 0, 10_080, true), effortLevel: number(row.effortLevel, 0, 5, true),
    visitSource: oneOf(row.visitSource, ["member", "ai", "default"]), effortSource: oneOf(row.effortSource, ["member", "ai", "default"]) };
}
function estimates(value: unknown): Record<string, PlanningEstimateDto> {
  return Object.fromEntries(Object.entries(record(value)).map(([key, entry]) => [key, estimate(entry)]));
}
function check(value: unknown): PlanningBlockingCheckDto {
  const row = record(value);
  return { dayId: text(row.dayId), code: oneOf(row.code, ["count", "effort", "budget", "unverifiable_distance", "baseline_unverifiable"]),
    current: finite(row.current), added: finite(row.added), cap: finite(row.cap) };
}
function endpoint(value: unknown): PlanningEndpointDto {
  const row = record(value);
  const coordinates = row.coordinates === null ? null : record(row.coordinates);
  return { id: text(row.id), coordinates: coordinates === null ? null : {
    latitude: number(coordinates.latitude, -90, 90), longitude: number(coordinates.longitude, -180, 180) } };
}
export function parsePlanningDayLoad(value: unknown): PlanningDayLoadDto {
  const row = record(value);
  const caps = parsePlanningOverrideResponse({ dayId: row.dayId, raw: null, version: 0, effective: row.caps }).effective;
  return {
    dayId: text(row.dayId), ...(row.date === undefined ? {} : { date: text(row.date) }),
    ...(row.override === undefined ? {} : { override: row.override === null ? null : parsePlanningOverride(row.override) }),
    ...(row.overrideVersion === undefined ? {} : { overrideVersion: version(row.overrideVersion) }),
    status: oneOf(row.status, ["valid", "over_cap", "unverifiable_distance", "baseline_unverifiable"]), caps,
    windowStartMinute: finite(row.windowStartMinute), windowEndMinute: finite(row.windowEndMinute),
    windowMinutes: finite(row.windowMinutes), fixedOccupancyMinutes: finite(row.fixedOccupancyMinutes),
    mealReserveMinutes: finite(row.mealReserveMinutes), restMinutes: finite(row.restMinutes), slackMinutes: finite(row.slackMinutes),
    budgetMinutes: finite(row.budgetMinutes), visitMinutes: finite(row.visitMinutes), travelMinutes: finite(row.travelMinutes),
    loadMinutes: finite(row.loadMinutes), totalMinutes: finite(row.totalMinutes), count: version(row.count), effort: version(row.effort),
    straightMetres: version(row.straightMetres), utilisation: finite(row.utilisation),
    noLodging: boolean(row.noLodging), missingCoordinateIds: array(row.missingCoordinateIds, text), unresolvedItemIds: array(row.unresolvedItemIds, text),
    route: array(row.route, (value) => { const node = record(value); return { id: text(node.id), kind: oneOf(node.kind, ["lodging", "anchor", "flexible", "pinned"] as const), start: endpoint(node.start), end: endpoint(node.end) }; }),
    legs: array(row.legs, (value) => { const leg = record(value); return { fromId: text(leg.fromId), toId: text(leg.toId), metres: version(leg.metres), travelMinutes: version(leg.travelMinutes) }; }),
    checks: array(row.checks, check),
  };
}
export function parsePlanningLoadResponse(value: unknown): PlanningLoadResponse {
  const row = record(value); const counts = record(row.counts);
  return { days: array(row.days, parsePlanningDayLoad), estimates: estimates(row.estimates), settingsVersion: version(row.settingsVersion),
    counts: { flexible: version(counts.flexible), fixedSelected: version(counts.fixedSelected), days: version(counts.days), aiPending: version(counts.aiPending) } };
}
export function parseWholeTripPlanPreviewInput(value: unknown): WholeTripPlanPreviewInput {
  const row = record(value); exactKeys(row, ["mode", "useAi", "draftSettings", "draftOverrides"]);
  const draftOverrides = row.draftOverrides === undefined ? undefined : array(row.draftOverrides, (value) => {
    const draft = record(value); exactKeys(draft, ["dayId", "expectedVersion", "values"]);
    const dayId = text(draft.dayId).toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(dayId)) invalid("dayId");
    return { dayId, expectedVersion: version(draft.expectedVersion), values: draft.values === null ? null : parsePlanningOverride(draft.values) };
  });
  if (draftOverrides && new Set(draftOverrides.map((entry) => entry.dayId)).size !== draftOverrides.length) invalid("duplicate day");
  return { mode: oneOf(row.mode, ["keep", "replan"]), useAi: boolean(row.useAi),
    ...(row.draftSettings === undefined ? {} : { draftSettings: parsePutPlanningSettingsInput(row.draftSettings) }),
    ...(draftOverrides === undefined ? {} : { draftOverrides }) };
}
export function parseWholeTripPlanResult(value: unknown): WholeTripPlanResultDto {
  const row = record(value);
  return {
    status: oneOf(row.status, ["complete", "baseline_conflict", "proven_infeasible", "search_incomplete"]),
    days: array(row.days, (value) => {
      const day = record(value);
      return { dayId: text(day.dayId), orderedPlaceIds: array(day.orderedPlaceIds, text), load: parsePlanningDayLoad(day.load),
        ...(day.timeline === undefined ? {} : { timeline: day.timeline === null ? null : parseDayTimeline(day.timeline) }) };
    }),
    conflicts: array(row.conflicts, (value) => {
      const conflict = record(value);
      return { code: oneOf(conflict.code, ["fixed_baseline_over_cap", "baseline_unverifiable", "existing_count_over_cap", "existing_effort_over_cap", "existing_budget_over_cap", "existing_unverifiable_distance", "missing_coordinates", "total_capacity", "place_exceeds_every_day"] as const),
        ...(conflict.dayId === undefined ? {} : { dayId: text(conflict.dayId) }), ...(conflict.placeId === undefined ? {} : { placeId: text(conflict.placeId) }), checks: array(conflict.checks, check) };
    }),
    unplaced: array(row.unplaced, (value) => { const place = record(value); return { placeId: text(place.placeId), reasons: array(place.reasons, check) }; }),
    excludedPlaceIds: array(row.excludedPlaceIds, text),
    suggestions: array(row.suggestions, (value) => {
      const suggestion = record(value); const raw = record(suggestion.overrides);
      const parsed = parsePlanningOverride({ ...EMPTY_PLANNING_OVERRIDE, ...raw });
      return { placeId: text(suggestion.placeId), dayId: text(suggestion.dayId),
        overrides: Object.fromEntries(Object.keys(raw).map((key) => [key, parsed[key as PlanningOverrideField]])),
        relativeIncrease: number(suggestion.relativeIncrease, 0, Number.MAX_VALUE), fieldsChanged: version(suggestion.fieldsChanged) };
    }),
  };
}
export function parseWholeTripPlanProposalResponse(value: unknown): WholeTripPlanProposalResponse {
  const row = record(record(value).proposal);
  const input = parseWholeTripPlanPreviewInput({ mode: row.mode, useAi: row.useAi,
    ...(row.draftSettings === undefined ? {} : { draftSettings: row.draftSettings }), ...(row.draftOverrides === undefined ? {} : { draftOverrides: row.draftOverrides }) });
  return { proposal: { ...input, id: text(row.id), tripId: text(row.tripId), createdAt: text(row.createdAt), expiresAt: text(row.expiresAt),
    inputRevision: text(row.inputRevision), estimates: estimates(row.estimates), result: parseWholeTripPlanResult(row.result) } };
}
export function parseApplyWholeTripPlanResponse(value: unknown): ApplyWholeTripPlanResponse {
  const row = record(value);
  return { proposalId: text(row.proposalId), placedCount: version(row.placedCount), dayIds: array(row.dayIds, text) };
}

export function parsePlanningDrafts(value: unknown): PlanningDrafts {
  const row = record(value);
  exactKeys(row, ["draftSettings", "draftOverrides"]);
  const { mode: _mode, useAi: _useAi, ...drafts } = parseWholeTripPlanPreviewInput({ ...row, mode: "replan", useAi: false });
  return drafts;
}
