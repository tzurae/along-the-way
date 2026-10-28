import type { DayRouteOrderBasis, DayRouteOrderReason } from "@along-the-way/contracts/day-plans";
import type { DayTimeline } from "@along-the-way/contracts/day-timeline";
import type { PlanningOverride, PlanningSettings } from "@along-the-way/contracts/planning";
import type { TripPlaceMealRole } from "@along-the-way/contracts/trip-places";
import type { ItineraryItemType, PlaceType } from "@along-the-way/contracts/trip-skeleton";

export const PLANNER_MAX_DAYS = 30;
export const PLANNER_MAX_FLEXIBLE_PLACES = 150;

export interface PlannerCoordinates {
  latitude: number;
  longitude: number;
}

export interface PlannerEstimate {
  visitMinutes: number;
  effortLevel: number;
  visitSource: "member" | "ai" | "default";
  effortSource: "member" | "ai" | "default";
}

/** Frozen by proposal storage; AI publications cannot change an existing proposal. */
export type PlannerFrozenEstimates = Record<string, PlannerEstimate>;
export type PlannerEffectiveCaps = PlanningSettings;

export interface PlannerPlace {
  id: string;
  type: PlaceType;
  coordinates: PlannerCoordinates | null;
  estimate: PlannerEstimate;
  /** 哪一餐 (f5 §2.1): the member's mark; null leaves the meal to the timeline's automatic rule. */
  mealRole: TripPlaceMealRole | null;
  votes: number;
  assignedDayId: string | null;
  position: number | null;
  /** Index among the trip's selected places (created_at, id ascending): unpositioned stops of a day are ordered newest first by it (p9 §2.1). */
  selectedIndex: number;
}

export interface PlannerEndpoint {
  id: string;
  coordinates: PlannerCoordinates | null;
}

/** All instant values use UTC epoch minutes, not local clock minutes. */
export interface PlannerAnchor {
  id: string;
  startMinute: number;
  localStartMinute: number;
  /** Local minutes after the day's midnight, like localStartMinute; NaN when the end is unresolved. */
  localEndMinute: number;
  itemType: ItineraryItemType;
  start: PlannerEndpoint;
  end: PlannerEndpoint;
}

export interface PlannerOccupancy {
  id: string;
  startMinute: number;
  endMinute: number;
}

export interface PlannerMealContribution {
  /** The same meal and its selected place use the same key. Duplicates take max. */
  id: string;
  minutes: number;
}

export interface PlannerDaySnapshot {
  id: string;
  date: string;
  timeZone: string;
  caps: PlannerEffectiveCaps;
  previousLodging: PlannerEndpoint | null;
  nightLodging: PlannerEndpoint | null;
  anchors: readonly PlannerAnchor[];
  occupancy: readonly PlannerOccupancy[];
  arrivalEndMinutes: readonly number[];
  departureStartMinutes: readonly number[];
  /** An unresolved fixed item's id makes the baseline unverifiable. */
  unresolvedItemIds: readonly string[];
  fixedSelected: readonly PlannerPlace[];
  pinned: readonly PlannerPlace[];
  meals: readonly PlannerMealContribution[];
}

export interface PlannerInput {
  policyVersion: string;
  mode: "keep" | "replan";
  days: readonly PlannerDaySnapshot[];
  flexiblePlaces: readonly PlannerPlace[];
  /** Includes unassigned lodging/airport places, which never count as unplaced. */
  excludedPlaces: readonly PlannerPlace[];
}

export type PlannerDayStatus = "valid" | "over_cap" | "unverifiable_distance" | "baseline_unverifiable";
export type PlannerCheckCode = "count" | "effort" | "budget" | "unverifiable_distance" | "baseline_unverifiable";

export interface PlannerBlockingCheck {
  dayId: string;
  code: PlannerCheckCode;
  current: number;
  added: number;
  cap: number;
}

export interface PlannerLeg {
  fromId: string;
  toId: string;
  metres: number;
  travelMinutes: number;
}

export interface PlannerRouteNode {
  id: string;
  kind: "lodging" | "anchor" | "flexible" | "pinned";
  start: PlannerEndpoint;
  end: PlannerEndpoint;
}

export interface PlannerDayLoad {
  dayId: string;
  status: PlannerDayStatus;
  caps: PlannerEffectiveCaps;
  windowStartMinute: number;
  windowEndMinute: number;
  windowMinutes: number;
  fixedOccupancyMinutes: number;
  mealReserveMinutes: number;
  restMinutes: number;
  slackMinutes: number;
  budgetMinutes: number;
  visitMinutes: number;
  travelMinutes: number;
  loadMinutes: number;
  totalMinutes: number;
  count: number;
  effort: number;
  straightMetres: number;
  utilisation: number;
  noLodging: boolean;
  missingCoordinateIds: string[];
  unresolvedItemIds: string[];
  route: PlannerRouteNode[];
  legs: PlannerLeg[];
  checks: PlannerBlockingCheck[];
}

export interface PlannerOutputDay {
  dayId: string;
  /** Only the middle segment: flexible plus pinned, never fixed-selected. */
  orderedPlaceIds: string[];
  load: PlannerDayLoad;
  /** Straight-line timeline stored with a draft (f5 1a); absent on older drafts, null for a day without stops. */
  timeline?: DayTimeline | null;
  /** How this day's order was chosen (p9 §2.6); absent on drafts written before P2. */
  orderBasis?: DayRouteOrderBasis;
  orderReason?: DayRouteOrderReason;
}

export type PlannerConflictCode = "fixed_baseline_over_cap" | "baseline_unverifiable"
  | "existing_count_over_cap" | "existing_effort_over_cap" | "existing_budget_over_cap"
  | "existing_unverifiable_distance"
  | "missing_coordinates" | "total_capacity" | "place_exceeds_every_day";

export interface PlannerConflict {
  code: PlannerConflictCode;
  dayId?: string;
  placeId?: string;
  checks: PlannerBlockingCheck[];
}

export interface PlannerSuggestion {
  placeId: string;
  dayId: string;
  overrides: Partial<PlanningOverride>;
  relativeIncrease: number;
  fieldsChanged: number;
}

export interface PlannerUnplaced {
  placeId: string;
  reasons: PlannerBlockingCheck[];
}

export interface PlannerResult {
  status: "complete" | "baseline_conflict" | "proven_infeasible" | "search_incomplete";
  /** Empty on baseline conflict; invalid baselines are diagnostics, never output days. */
  days: PlannerOutputDay[];
  conflicts: PlannerConflict[];
  unplaced: PlannerUnplaced[];
  excludedPlaceIds: string[];
  suggestions: PlannerSuggestion[];
}

export interface PlannerValidation {
  valid: boolean;
  errors: string[];
  days: PlannerOutputDay[];
}
