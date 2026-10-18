import { Temporal } from "@js-temporal/polyfill";
import {
  PLANNING_POLICY_VERSION, resolvePlanningSettings, validatePlanningCrossFields,
  type PlanningDrafts, type PlanningOverrideResponse,
} from "@along-the-way/contracts/planning";
import type { PlaceType } from "@along-the-way/contracts/trip-skeleton";
import type { Selectable } from "kysely";
import type { ItineraryEndpointTable } from "../database/database";
import { AppError } from "../private-trips/private-trip-module";
import { dateOnly, isoTimestamp, type DatabaseExecutor } from "../private-trips/postgres-private-trip-store";
import type { PlannerDaySnapshot, PlannerEndpoint, PlannerEstimate, PlannerFrozenEstimates, PlannerInput, PlannerPlace } from "./planner-model";
import type { PlanningRevisionInput } from "./planning-input-revision";
import { planningOverrideFromRow, readPlanningSettings } from "./planning-settings-store";
import { readValidProfiles, readPendingProfileIdentityIds, type ValidPlacePlanningProfile } from "./postgres-place-planning-profile-module";

export const PLACE_ESTIMATE_DEFAULTS_V1: Record<PlaceType, { visitMinutes: number; effortLevel: number }> = {
  activity: { visitMinutes: 120, effortLevel: 3 }, museum: { visitMinutes: 120, effortLevel: 2 },
  worship: { visitMinutes: 60, effortLevel: 2 }, nature: { visitMinutes: 120, effortLevel: 4 },
  cafe: { visitMinutes: 45, effortLevel: 1 }, restaurant: { visitMinutes: 75, effortLevel: 1 },
  shopping: { visitMinutes: 60, effortLevel: 2 }, station: { visitMinutes: 15, effortLevel: 1 },
  other: { visitMinutes: 60, effortLevel: 2 }, lodging: { visitMinutes: 0, effortLevel: 0 }, airport: { visitMinutes: 0, effortLevel: 0 },
};
export interface BuildPlanningSnapshotOptions extends PlanningDrafts {
  useAi: boolean;
  mode?: "keep" | "replan";
  frozenEstimates?: PlannerFrozenEstimates;
}

/** All planning callers share this assignment-independent precedence through the snapshot. */
export function resolvePlanningDayTimeZone(
  date: string,
  night: Selectable<ItineraryEndpointTable> | null,
  previous: Selectable<ItineraryEndpointTable> | null,
  endpointsByItem: ReadonlyMap<string, readonly Selectable<ItineraryEndpointTable>[]>,
  defaultTimeZone: string | null,
): string | null {
  if (night?.time_zone.trim()) return night.time_zone;
  if (previous?.time_zone.trim()) return previous.time_zone;
  const displayed: Selectable<ItineraryEndpointTable>[] = [];
  for (const endpoints of endpointsByItem.values()) {
    const start = endpoints.find((point) => point.endpoint_role === "start");
    const end = endpoints.find((point) => point.endpoint_role === "end");
    const point = start?.local_date_time.slice(0, 10) === date ? start
      : end?.local_date_time.slice(0, 10) === date ? end : null;
    if (point?.time_zone.trim()) displayed.push(point);
  }
  displayed.sort((a, b) => new Date(a.instant).valueOf() - new Date(b.instant).valueOf()
    || (a.itinerary_item_id < b.itinerary_item_id ? -1 : a.itinerary_item_id > b.itinerary_item_id ? 1 : 0));
  return displayed[0]?.time_zone ?? defaultTimeZone;
}

/** Reads only through the caller's executor; never reconciles or writes itinerary data. */
export async function buildPlanningSnapshot(executor: DatabaseExecutor, tripId: string, options: BuildPlanningSnapshotOptions) {
  const [trip, dayRows, placeRows, legacyPlaces, items, endpoints, constraints, assignments, votes, overrideRows, settings] = await Promise.all([
    executor.selectFrom("trips").select(["id", "start_date", "end_date"]).where("id", "=", tripId).executeTakeFirst(),
    executor.selectFrom("trip_days").selectAll().where("trip_id", "=", tripId).orderBy("date").orderBy("id").execute(),
    executor.selectFrom("trip_places as place").innerJoin("place_identities as identity", "identity.id", "place.place_id")
      .selectAll("place").select(["identity.canonical_name", "identity.canonical_type", "identity.latitude as canonical_latitude",
        "identity.longitude as canonical_longitude", "identity.time_zone as canonical_time_zone"])
      .where("place.trip_id", "=", tripId).where("place.archived_at", "is", null).orderBy("place.created_at").orderBy("place.id").execute(),
    executor.selectFrom("places").selectAll().where("trip_id", "=", tripId).orderBy("id").execute(),
    executor.selectFrom("itinerary_items").selectAll().where("trip_id", "=", tripId).orderBy("id").execute(),
    executor.selectFrom("itinerary_endpoints").selectAll().where("trip_id", "=", tripId).orderBy("itinerary_item_id").orderBy("endpoint_role").execute(),
    executor.selectFrom("itinerary_constraints").selectAll().where("trip_id", "=", tripId).orderBy("id").execute(),
    executor.selectFrom("trip_place_day_assignments").selectAll().where("trip_id", "=", tripId).orderBy("trip_place_id").execute(),
    executor.selectFrom("trip_place_votes as vote").innerJoin("trip_members as member", (join) => join.onRef("member.trip_id", "=", "vote.trip_id").onRef("member.user_id", "=", "vote.member_user_id"))
      .select(["vote.trip_place_id", "vote.member_user_id"]).where("vote.trip_id", "=", tripId).where("member.removed_at", "is", null).orderBy("vote.trip_place_id").orderBy("vote.member_user_id").execute(),
    executor.selectFrom("trip_day_planning_overrides").selectAll().where("trip_id", "=", tripId).orderBy("day_id").execute(),
    readPlanningSettings(executor, tripId),
  ]);
  if (!trip) throw new AppError("trip_not_found", "Trip not found", 404);
  const values = options.draftSettings?.values ?? settings.resolved;
  const savedOverrides = new Map(overrideRows.map((row) => [row.day_id, row]));
  const draftOverrides = new Map((options.draftOverrides ?? []).map((draft) => [draft.dayId, draft]));
  const dayIds = new Set(dayRows.map((day) => day.id));
  for (const dayId of draftOverrides.keys()) {
    if (!dayIds.has(dayId)) throw new AppError("validation_error", "Draft override day does not belong to this trip");
  }
  const legacyById = new Map(legacyPlaces.map((place) => [place.id, place]));
  const assignmentByPlace = new Map(assignments.map((assignment) => [assignment.trip_place_id, assignment]));
  const endpointsByItem = new Map<string, Selectable<ItineraryEndpointTable>[]>();
  const scheduledLegacyIds = new Set<string>();
  for (const endpoint of endpoints) {
    const existing = endpointsByItem.get(endpoint.itinerary_item_id);
    if (existing) existing.push(endpoint); else endpointsByItem.set(endpoint.itinerary_item_id, [endpoint]);
    scheduledLegacyIds.add(endpoint.place_id);
  }
  const votesByPlace = new Map<string, string[]>();
  for (const vote of votes) {
    const existing = votesByPlace.get(vote.trip_place_id);
    if (existing) existing.push(vote.member_user_id); else votesByPlace.set(vote.trip_place_id, [vote.member_user_id]);
  }
  const resolved = placeRows.map((row) => {
    const legacy = legacyById.get(row.legacy_place_id);
    // Match the legacy reconciliation without performing its writes during a preview.
    const legacyChanged = legacy !== undefined && legacy.version !== row.legacy_place_version;
    const provider = !legacyChanged && row.facts_source === "provider";
    const latitude = legacyChanged ? legacy.latitude : provider ? row.canonical_latitude : row.latitude;
    const longitude = legacyChanged ? legacy.longitude : provider ? row.canonical_longitude : row.longitude;
    return { row, name: legacyChanged ? legacy.name : provider ? row.canonical_name : row.name,
      type: legacyChanged ? legacy.place_type : provider ? row.canonical_type : row.place_type,
      timeZone: legacyChanged ? legacy.time_zone : provider ? row.canonical_time_zone : row.time_zone,
      coordinates: latitude === null || longitude === null ? null : { latitude, longitude },
      scheduled: scheduledLegacyIds.has(row.legacy_place_id) };
  });
  const selected = resolved.filter((place) => place.row.selected_for_itinerary);
  const identityIds = selected.map((place) => place.row.place_id);
  const profiles: Map<string, ValidPlacePlanningProfile> = options.useAi && !options.frozenEstimates
    ? await readValidProfiles(executor, identityIds) : new Map();
  const pendingProfiles = options.useAi && !options.frozenEstimates
    ? await readPendingProfileIdentityIds(executor, identityIds) : new Set<string>();
  const timeZoneVotes = new Map<string, number>();
  for (const points of endpointsByItem.values()) {
    const timeZone = points.find((point) => point.endpoint_role === "start" && point.time_zone.trim())?.time_zone
      ?? points.find((point) => point.time_zone.trim())?.time_zone;
    if (timeZone) timeZoneVotes.set(timeZone, (timeZoneVotes.get(timeZone) ?? 0) + 1);
  }
  const planningDefaultTimeZone = [...timeZoneVotes].sort(([left, a], [right, b]) => b - a || (left < right ? -1 : left > right ? 1 : 0))[0]?.[0]
    ?? [...selected].filter((place) => place.timeZone?.trim()).sort((a, b) => a.row.place_id < b.row.place_id ? -1 : a.row.place_id > b.row.place_id ? 1 : 0)[0]?.timeZone
    ?? null;
  const resolvedDayTimeZones = new Map<string, string | null>();
  const estimates: PlannerFrozenEstimates = {};
  let aiPending = 0;
  const plannerPlaces = new Map<string, PlannerPlace>();
  for (const place of selected) {
    const row = place.row;
    const defaults = PLACE_ESTIMATE_DEFAULTS_V1[place.type];
    const profile = profiles.get(row.place_id);
    const frozen = options.frozenEstimates?.[row.id];
    const estimate: PlannerEstimate = frozen ? { ...frozen } : { ...defaults, visitSource: "default", effortSource: "default" };
    if (!frozen) {
      if (profile?.visitMinutes != null) {
        estimate.visitMinutes = profile.confidence === "low" ? Math.max(profile.visitMinutes, defaults.visitMinutes) : profile.visitMinutes;
        estimate.visitSource = profile.confidence === "low" && profile.visitMinutes < defaults.visitMinutes ? "default" : "ai";
      }
      if (profile?.effortLevel != null) {
        estimate.effortLevel = profile.confidence === "low" ? Math.max(profile.effortLevel, defaults.effortLevel) : profile.effortLevel;
        estimate.effortSource = profile.confidence === "low" && profile.effortLevel < defaults.effortLevel ? "default" : "ai";
      }
      if (row.duration_minutes !== null) { estimate.visitMinutes = row.duration_minutes; estimate.visitSource = "member"; }
      if (row.effort_level !== null) { estimate.effortLevel = row.effort_level; estimate.effortSource = "member"; }
    }
    if (pendingProfiles.has(row.place_id) && (row.duration_minutes === null || row.effort_level === null)
      && place.type !== "lodging" && place.type !== "airport") aiPending += 1;
    estimates[row.id] = estimate;
    const assignment = assignmentByPlace.get(row.id);
    plannerPlaces.set(row.id, { id: row.id, type: place.type, coordinates: place.coordinates, estimate,
      votes: votesByPlace.get(row.id)?.length ?? 0, assignedDayId: assignment?.trip_day_id ?? null, position: assignment?.day_position ?? null });
  }
  const flexiblePlaces = selected.filter((place) => !place.scheduled && place.type !== "lodging" && place.type !== "airport").map((place) => plannerPlaces.get(place.row.id)!);
  const excludedPlaces = selected.filter((place) => !place.scheduled && (place.type === "lodging" || place.type === "airport")).map((place) => plannerPlaces.get(place.row.id)!);
  const selectedByLegacy = new Map(selected.map((place) => [place.row.legacy_place_id, plannerPlaces.get(place.row.id)!]));
  const endpointPoint = (endpoint: Selectable<ItineraryEndpointTable>): PlannerEndpoint => {
    const place = legacyById.get(endpoint.place_id);
    return { id: endpoint.place_id, coordinates: place?.latitude == null || place.longitude == null ? null : { latitude: place.latitude, longitude: place.longitude } };
  };
  const bookedNight = (date: string) => {
    for (const item of items) {
      if (item.item_type !== "lodging") continue;
      const points = endpointsByItem.get(item.id) ?? [];
      const start = points.find((point) => point.endpoint_role === "start");
      const end = points.find((point) => point.endpoint_role === "end");
      if (start && end && start.local_date_time.slice(0, 10) <= date && end.local_date_time.slice(0, 10) > date) return start;
    }
    return null;
  };
  const overrides: Record<string, PlanningOverrideResponse> = {};
  const days: PlannerDaySnapshot[] = dayRows.map((row) => {
    const date = dateOnly(row.date);
    const plainDate = Temporal.PlainDate.from(date);
    const previous = bookedNight(plainDate.subtract({ days: 1 }).toString());
    const night = bookedNight(date);
    const resolvedTimeZone = resolvePlanningDayTimeZone(date, night, previous, endpointsByItem, planningDefaultTimeZone);
    resolvedDayTimeZones.set(row.id, resolvedTimeZone);
    // UTC is only a diagnostic arithmetic axis; unresolved days are never schedulable.
    const timeZone = resolvedTimeZone ?? "UTC";
    const startOfDay = plainDate.toZonedDateTime(timeZone).epochMilliseconds / 60_000;
    const endOfDay = plainDate.add({ days: 1 }).toZonedDateTime(timeZone).epochMilliseconds / 60_000;
    const anchors: PlannerDaySnapshot["anchors"][number][] = [];
    const occupancy: PlannerDaySnapshot["occupancy"][number][] = [];
    const arrivalEndMinutes: number[] = [];
    const departureStartMinutes: number[] = [];
    const unresolvedItemIds: string[] = resolvedTimeZone === null ? [row.id] : [];
    const fixedSelected = new Map<string, PlannerPlace>();
    const meals: PlannerDaySnapshot["meals"][number][] = [];
    let flightDay = false;
    for (const item of items) {
      const points = endpointsByItem.get(item.id) ?? [];
      const start = points.find((point) => point.endpoint_role === "start");
      const end = points.find((point) => point.endpoint_role === "end");
      const startMinute = start ? new Date(start.instant).valueOf() / 60_000 : NaN;
      const details = typeof item.details === "object" && item.details !== null ? item.details as Record<string, unknown> : {};
      const duration = typeof details.durationMinutes === "number" && Number.isFinite(details.durationMinutes) && details.durationMinutes > 0 ? details.durationMinutes : NaN;
      const usesEndEndpoint = item.item_type === "flight" || item.item_type === "transport" || item.item_type === "lodging";
      const endMinute = usesEndEndpoint ? end ? new Date(end.instant).valueOf() / 60_000 : NaN : startMinute + duration;
      const localMatch = points.some((point) => point.local_date_time.slice(0, 10) === date);
      const overlaps = Number.isFinite(startMinute) && Number.isFinite(endMinute) && startMinute < endOfDay && endMinute > startOfDay;
      const unresolved = !start || !Number.isFinite(startMinute) || !Number.isFinite(endMinute) || endMinute < startMinute;
      // §Definitions: an item belongs to a day through the local date of an endpoint. An item with
      // no endpoints has no resolvable date and anchors no day (it must not poison every day).
      if (!localMatch && !overlaps) continue;
      if (!localMatch) {
        // Spans this day without an endpoint on it (multi-day item, or a cross-zone overnight
        // service): it only occupies time here; it is neither a route anchor nor counted.
        if (!unresolved && item.item_type !== "lodging") occupancy.push({ id: item.id, startMinute, endMinute });
        continue;
      }
      if (item.item_type === "lodging") {
        // Lodging is only an anchor (previous/night lodging), never occupancy or a counted place.
        if (unresolved) unresolvedItemIds.push(item.id);
        continue;
      }
      for (const point of points) {
        const selectedPlace = selectedByLegacy.get(point.place_id);
        // Lodging/airport places are never counted (same rule as pinned non-sightseeing places).
        if (selectedPlace && selectedPlace.type !== "lodging" && selectedPlace.type !== "airport") {
          fixedSelected.set(selectedPlace.id, selectedPlace);
        }
      }
      if (unresolved) unresolvedItemIds.push(item.id);
      if (start && Number.isFinite(startMinute)) {
        const localStart = Temporal.Instant.fromEpochMilliseconds(startMinute * 60_000).toZonedDateTimeISO(timeZone);
        const localDayDifference = plainDate.until(localStart.toPlainDate()).days;
        anchors.push({ id: item.id, startMinute, localStartMinute: localDayDifference * 1440 + localStart.hour * 60 + localStart.minute,
          start: endpointPoint(start), end: endpointPoint(end ?? start) });
      }
      if (!unresolved) occupancy.push({ id: item.id, startMinute, endMinute });
      if (item.item_type === "flight") {
        if (start?.local_date_time.slice(0, 10) === date) { flightDay = true; if (Number.isFinite(startMinute)) departureStartMinutes.push(startMinute); }
        if (end?.local_date_time.slice(0, 10) === date) { flightDay = true; if (Number.isFinite(endMinute)) arrivalEndMinutes.push(endMinute); }
      }
      if (item.item_type === "meal" && !unresolved) {
        const selectedPlace = start ? selectedByLegacy.get(start.place_id) : undefined;
        meals.push({ id: selectedPlace?.id ?? item.id, minutes: Math.max(0, Math.min(endMinute, endOfDay) - Math.max(startMinute, startOfDay)) });
      }
    }
    const saved = savedOverrides.get(row.id);
    const draft = draftOverrides.get(row.id);
    const override = draft ? draft.values : saved ? planningOverrideFromRow(saved) : null;
    try { validatePlanningCrossFields(resolvePlanningSettings(values, override, false)); }
    catch { throw new AppError("validation_error", "Effective planning fields must leave a positive budget with target at most maximum"); }
    const caps = resolvePlanningSettings(values, override, flightDay);
    overrides[row.id] = { dayId: row.id, raw: override, version: saved?.version ?? 0, effective: caps };
    return { id: row.id, date, timeZone, caps, previousLodging: previous ? endpointPoint(previous) : null,
      nightLodging: night ? endpointPoint(night) : null, anchors, occupancy, arrivalEndMinutes, departureStartMinutes,
      unresolvedItemIds, fixedSelected: [...fixedSelected.values()].sort((a, b) => a.id.localeCompare(b.id)),
      pinned: excludedPlaces.filter((place) => place.assignedDayId === row.id), meals };
  });
  const entities: Record<string, unknown> = {};
  entities[tripId] = { settings: settings.raw, settingsVersion: settings.version, planningDefaultTimeZone,
    startDate: dateOnly(trip.start_date), endDate: dateOnly(trip.end_date) };
  for (const day of dayRows) {
    const override = savedOverrides.get(day.id);
    entities[day.id] = { date: dateOnly(day.date), timeZone: resolvedDayTimeZones.get(day.id) ?? null,
      override: override ? planningOverrideFromRow(override) : null, overrideVersion: override?.version ?? 0 };
  }
  for (const place of resolved) {
    const row = place.row;
    const assignment = assignmentByPlace.get(row.id);
    entities[row.id] = { selected: row.selected_for_itinerary, scheduled: place.scheduled, type: place.type, coordinates: place.coordinates,
      timeZone: place.timeZone, memberVisitMinutes: row.duration_minutes, memberEffortLevel: row.effort_level,
      votes: votesByPlace.get(row.id) ?? [], assignment: assignment ? { dayId: assignment.trip_day_id, position: assignment.day_position } : null,
      legacyPlaceId: row.legacy_place_id, identityId: row.place_id };
  }
  for (const item of items) {
    // lockedAt is write protection only (§Definitions), so it is not a solver input.
    entities[item.id] = { type: item.item_type, details: item.details,
      endpoints: (endpointsByItem.get(item.id) ?? []).map((endpoint) => ({ role: endpoint.endpoint_role, placeId: endpoint.place_id,
        localDateTime: endpoint.local_date_time, timeZone: endpoint.time_zone, utcOffsetMinutes: endpoint.utc_offset_minutes, instant: isoTimestamp(endpoint.instant),
        coordinates: endpointPoint(endpoint).coordinates })),
      constraints: constraints.filter((constraint) => constraint.itinerary_item_id === item.id).map((constraint) => ({ id: constraint.id,
        type: constraint.constraint_type, status: constraint.status, minutes: constraint.minimum_buffer_minutes })) };
  }
  const revisionInput: PlanningRevisionInput = { policyVersion: PLANNING_POLICY_VERSION, entities };
  const input: PlannerInput = { policyVersion: PLANNING_POLICY_VERSION, mode: options.mode ?? "replan", days, flexiblePlaces, excludedPlaces };
  return { input, revisionInput, settings, overrides, estimates, aiPending, fixedSelectedCount: selected.filter((place) => place.scheduled).length };
}
