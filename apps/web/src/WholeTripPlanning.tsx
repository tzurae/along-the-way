import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  EMPTY_PLANNING_OVERRIDE,
  OVERRIDABLE_PLANNING_FIELDS,
  parseApplyWholeTripPlanResponse,
  parsePlanningLoadResponse,
  parsePlanningOverrideResponse,
  parsePlanningSettingsResponse,
  parseWholeTripPlanProposalResponse,
  planningClockMinutes,
  resolvePlanningSettings,
  type ApplyWholeTripPlanResponse,
  type PlanningBlockingCheckDto,
  type PlanningDayLoadDto,
  type PlanningDraftOverride,
  type PlanningLoadResponse,
  type PlanningOverride,
  type PlanningOverrideField,
  type PlanningSettings,
  type PlanningSettingsResponse,
  type WholeTripPlanPreviewInput,
  type WholeTripPlanProposalDto,
} from "@along-the-way/contracts/planning";
import {
  BedDouble,
  ChevronRight,
  Lock,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiRequestError } from "./api-error";
import { notify } from "./AppToaster";
import { useI18n, type Messages } from "./i18n";
import { PlaceDetailSheet } from "./PlaceDetailSheet";
import "./whole-trip-planner.css";

interface RequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}

type JsonRequest = <T>(url: string, options?: RequestOptions) => Promise<T>;

export interface WholeTripPlannerLaunch {
  draftSettings?: WholeTripPlanPreviewInput["draftSettings"];
  draftOverrides?: PlanningDraftOverride[];
}

interface DayReference {
  id: string;
  date: string;
}

interface WholeTripPlanningProviderProps {
  tripId: string;
  request: JsonRequest;
  days: DayReference[];
  flightDayIds: ReadonlySet<string>;
  entityNames: ReadonlyMap<string, string>;
  hasSelectedPlaces: boolean;
  canArrange: boolean;
  refreshToken: number;
  plannerLaunch?: WholeTripPlannerLaunch | null;
  onPlannerLaunchConsumed?(): void;
  onEditPlace(placeId: string): void;
  onApplied(): Promise<void> | void;
  children: ReactNode;
}

type PlannerDialogStep = "closed" | "scope" | "loading" | "preview" | "stale";
type ShortcutKind = "inherit" | "relaxed" | "heavier" | "custom";

interface PlanningContextValue {
  load: PlanningLoadResponse | null;
  loadError: string;
  canArrange: boolean;
  online: boolean;
  dialogStep: PlannerDialogStep;
  scopeMode: "keep" | "replan";
  useAi: boolean;
  loadingStep: number;
  plannerError: string;
  proposal: WholeTripPlanProposalDto | null;
  previewInput: WholeTripPlanPreviewInput | null;
  applying: boolean;
  names: ReadonlyMap<string, string>;
  days: DayReference[];
  inheritedSettings: ReadonlyMap<string, PlanningSettings>;
  /** Trip settings before flight-day reduction; the API checks override cross-fields against these. */
  tripSettings: PlanningSettings | null;
  overrideDayId: string | null;
  confirmDiscard: boolean;
  setScopeMode(value: "keep" | "replan"): void;
  setUseAi(value: boolean): void;
  openPlanner(): void;
  closePlanner(): void;
  createPreview(input?: WholeTripPlanPreviewInput): Promise<void>;
  applyProposal(): Promise<void>;
  applySuggestion(placeId: string, dayId: string, overrides: Partial<PlanningOverride>): Promise<void>;
  previewOverride(dayId: string, expectedVersion: number, values: PlanningOverride | null): Promise<PlanningDayLoadDto | null>;
  saveOverride(dayId: string, expectedVersion: number, values: PlanningOverride | null, idempotencyKey: string): Promise<void>;
  editPlace(placeId: string): void;
  openOverride(dayId: string): void;
  closeOverride(): void;
  refresh(): Promise<void>;
  setConfirmDiscard(value: boolean): void;
}

const PlanningContext = createContext<PlanningContextValue | null>(null);

function usePlanning() {
  const value = useContext(PlanningContext);
  if (!value) throw new Error("WholeTripPlanning components need WholeTripPlanningProvider");
  return value;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function addClockHours(value: string, hours: number) {
  const adjusted = clamp(planningClockMinutes(value) + hours * 60, 0, 24 * 60);
  if (adjusted === 24 * 60) return "24:00";
  return `${String(Math.floor(adjusted / 60)).padStart(2, "0")}:${String(adjusted % 60).padStart(2, "0")}`;
}

function shortcutOverride(effective: PlanningSettings, kind: "relaxed" | "heavier"): PlanningOverride {
  const relaxed = kind === "relaxed";
  const maxPlacesPerDay = clamp(effective.maxPlacesPerDay + (relaxed ? -1 : 2), 1, 12);
  return {
    ...EMPTY_PLANNING_OVERRIDE,
    // Lowering max below the soft target would fail target ≤ max, so 放輕鬆 lowers the target with it.
    targetPlacesPerDay: relaxed && effective.targetPlacesPerDay > maxPlacesPerDay ? maxPlacesPerDay : null,
    maxPlacesPerDay,
    maxEffortPerDay: clamp(effective.maxEffortPerDay + (relaxed ? -3 : 5), 1, 25),
    dayEnd: addClockHours(effective.dayEnd, relaxed ? -1 : 2),
    maxDailyStraightKm: clamp(effective.maxDailyStraightKm + (relaxed ? -8 : 10), 1, 100),
    restMinutes: clamp(effective.restMinutes + (relaxed ? 15 : -15), 0, 180),
  };
}

function sameOverride(left: PlanningOverride | null | undefined, right: PlanningOverride) {
  return left != null && OVERRIDABLE_PLANNING_FIELDS.every((field) => left[field] === right[field]);
}

function shortcutFor(raw: PlanningOverride | null | undefined, inherited: PlanningSettings): ShortcutKind {
  if (!raw || OVERRIDABLE_PLANNING_FIELDS.every((field) => raw[field] === null)) return "inherit";
  if (sameOverride(raw, shortcutOverride(inherited, "relaxed"))) return "relaxed";
  if (sameOverride(raw, shortcutOverride(inherited, "heavier"))) return "heavier";
  return "custom";
}

function durationLabel(minutes: number) {
  const rounded = Math.max(0, Math.round(minutes));
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  if (hours === 0) return `${remainder} 分`;
  return remainder === 0 ? `${hours} 小時` : `${hours} 小時 ${remainder} 分`;
}

function distanceLabel(metres: number) {
  const kilometres = metres / 1000;
  return `${kilometres < 10 ? kilometres.toFixed(1) : Math.round(kilometres)} 公里`;
}

function dateLabel(date: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", weekday: "short", timeZone: "UTC" })
    .format(new Date(`${date}T00:00:00Z`));
}

function statusLevel(actual: number, cap: number, unverifiable = false): "ok" | "near" | "over" | "unverifiable" {
  if (unverifiable) return "unverifiable";
  if (actual > cap) return "over";
  if (cap > 0 && actual / cap >= 0.9) return "near";
  return "ok";
}

function displayError(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

export function WholeTripPlanningProvider({
  tripId,
  request,
  days,
  flightDayIds,
  entityNames,
  hasSelectedPlaces,
  canArrange,
  refreshToken,
  plannerLaunch,
  onPlannerLaunchConsumed,
  onEditPlace,
  onApplied,
  children,
}: WholeTripPlanningProviderProps) {
  const { t } = useI18n();
  const copy = t.wholeTripPlanner;
  const [load, setLoad] = useState<PlanningLoadResponse | null>(null);
  const [settings, setSettings] = useState<PlanningSettingsResponse | null>(null);
  const [loadError, setLoadError] = useState("");
  const [online, setOnline] = useState(() => navigator.onLine);
  const [dialogStep, setDialogStep] = useState<PlannerDialogStep>("closed");
  const [scopeMode, setScopeMode] = useState<"keep" | "replan">("replan");
  const [useAi, setUseAi] = useState(true);
  const [loadingStep, setLoadingStep] = useState(0);
  const [plannerError, setPlannerError] = useState("");
  const [proposal, setProposal] = useState<WholeTripPlanProposalDto | null>(null);
  const [previewInput, setPreviewInput] = useState<WholeTripPlanPreviewInput | null>(null);
  const [applying, setApplying] = useState(false);
  const [overrideDayId, setOverrideDayId] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const generation = useRef(0);
  const loadingTimer = useRef<number | undefined>(undefined);
  const applyKeys = useRef(new Map<string, string>());
  const consumedLaunch = useRef<WholeTripPlannerLaunch | null>(null);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const [nextLoad, nextSettings] = await Promise.all([
        request<PlanningLoadResponse>(`/api/trips/${tripId}/planning-load`, { parse: parsePlanningLoadResponse }),
        request<PlanningSettingsResponse>(`/api/trips/${tripId}/planning-settings`, { parse: parsePlanningSettingsResponse }),
      ]);
      if (current !== generation.current) return;
      setLoad(nextLoad);
      setSettings(nextSettings);
      setLoadError("");
    } catch (reason) {
      if (current !== generation.current) return;
      setLoadError(displayError(reason, copy.meters.loadError));
    }
  }, [copy.meters.loadError, request, tripId]);

  useEffect(() => {
    setLoad(null);
    setSettings(null);
    setProposal(null);
    setDialogStep("closed");
  }, [tripId]);

  useEffect(() => {
    if (refreshToken >= 0) void refresh();
  }, [refresh, refreshToken]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => () => {
    clearInterval(loadingTimer.current);
  }, []);

  const createPreview = useCallback(async (explicitInput?: WholeTripPlanPreviewInput) => {
    const input = explicitInput ?? {
      mode: scopeMode,
      useAi,
      ...(plannerLaunch?.draftSettings ? { draftSettings: plannerLaunch.draftSettings } : {}),
      ...(plannerLaunch?.draftOverrides ? { draftOverrides: plannerLaunch.draftOverrides } : {}),
    };
    setPreviewInput(input);
    setPlannerError("");
    setDialogStep("loading");
    setLoadingStep(0);
    clearInterval(loadingTimer.current);
    loadingTimer.current = window.setInterval(() => setLoadingStep((current) => Math.min(3, current + 1)), 700);
    try {
      const response = await request<{ proposal: WholeTripPlanProposalDto }>(
        `/api/trips/${tripId}/whole-trip-plan/preview`,
        {
          method: "POST",
          body: JSON.stringify(input),
          parse: parseWholeTripPlanProposalResponse,
        },
      );
      setProposal(response.proposal);
      setDialogStep("preview");
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.code === "planner_input_too_large") {
        setPlannerError(copy.planner.inputTooLarge);
      } else {
        setPlannerError(displayError(reason, copy.planner.previewError));
      }
      setDialogStep("scope");
    } finally {
      clearInterval(loadingTimer.current);
      loadingTimer.current = undefined;
      setLoadingStep(3);
    }
  }, [copy.planner.inputTooLarge, copy.planner.previewError, plannerLaunch?.draftOverrides, plannerLaunch?.draftSettings, request, scopeMode, tripId, useAi]);

  useEffect(() => {
    if (!plannerLaunch || consumedLaunch.current === plannerLaunch || !load || !settings || !canArrange) return;
    consumedLaunch.current = plannerLaunch;
    onPlannerLaunchConsumed?.();
    void createPreview({ mode: "replan", useAi: true, ...plannerLaunch });
  }, [canArrange, createPreview, load, onPlannerLaunchConsumed, plannerLaunch, settings]);

  const closePlanner = useCallback(() => {
    if (applying) return;
    setDialogStep("closed");
    setPlannerError("");
    setProposal(null);
    setConfirmDiscard(false);
  }, [applying]);

  const applyProposal = useCallback(async () => {
    if (!proposal || proposal.result.status !== "complete" || !online) return;
    setApplying(true);
    setPlannerError("");
    const key = applyKeys.current.get(proposal.id) ?? crypto.randomUUID();
    applyKeys.current.set(proposal.id, key);
    try {
      const result = await request<ApplyWholeTripPlanResponse>(
        `/api/trips/${tripId}/whole-trip-plan/proposals/${proposal.id}/apply`,
        {
          method: "POST",
          headers: { "Idempotency-Key": key },
          body: JSON.stringify({}),
          parse: parseApplyWholeTripPlanResponse,
        },
      );
      applyKeys.current.delete(proposal.id);
      notify("success", copy.planner.applied(result.placedCount, result.dayIds.length));
      setDialogStep("closed");
      setProposal(null);
      await Promise.resolve(onApplied());
      await refresh();
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.code === "plan_stale") {
        setDialogStep("stale");
      } else if (reason instanceof ApiRequestError && (reason.code === "forbidden" || reason.status === 403)) {
        setPlannerError(copy.planner.permissionChanged);
      } else {
        setPlannerError(displayError(reason, copy.planner.applyError));
      }
    } finally {
      setApplying(false);
    }
  }, [copy.planner, onApplied, online, proposal, refresh, request, tripId]);

  const applySuggestion = useCallback(async (placeId: string, dayId: string, overrides: Partial<PlanningOverride>) => {
    if (!previewInput || !load) return;
    const loadedDay = load.days.find((day) => day.dayId === dayId);
    if (!loadedDay || loadedDay.overrideVersion === undefined) return;
    const existing = previewInput.draftOverrides?.find((entry) => entry.dayId === dayId);
    const values = { ...(existing?.values ?? loadedDay.override ?? EMPTY_PLANNING_OVERRIDE), ...overrides };
    const draft: PlanningDraftOverride = {
      dayId,
      expectedVersion: existing?.expectedVersion ?? loadedDay.overrideVersion,
      values,
    };
    const draftOverrides = [
      ...(previewInput.draftOverrides ?? []).filter((entry) => entry.dayId !== dayId),
      draft,
    ];
    await createPreview({ ...previewInput, draftOverrides });
  }, [createPreview, load, previewInput]);

  const saveOverride = useCallback(async (
    dayId: string,
    expectedVersion: number,
    values: PlanningOverride | null,
    idempotencyKey: string,
  ) => {
    await request(
      `/api/trips/${tripId}/days/${dayId}/planning-override`,
      {
        method: values === null ? "DELETE" : "PUT",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(values === null ? { expectedVersion } : { expectedVersion, values }),
        parse: parsePlanningOverrideResponse,
      },
    );
  }, [request, tripId]);

  const previewOverride = useCallback(async (
    dayId: string,
    expectedVersion: number,
    values: PlanningOverride | null,
  ) => {
    const response = await request<PlanningLoadResponse>(
      `/api/trips/${tripId}/planning-load`,
      {
        method: "POST",
        body: JSON.stringify({ draftOverrides: [{ dayId, expectedVersion, values }] }),
        parse: parsePlanningLoadResponse,
      },
    );
    return response.days.find((day) => day.dayId === dayId) ?? null;
  }, [request, tripId]);

  const inheritedSettings = useMemo(() => {
    const result = new Map<string, PlanningSettings>();
    if (!settings || !load) return result;
    for (const day of load.days) {
      result.set(day.dayId, resolvePlanningSettings(settings.resolved, null, flightDayIds.has(day.dayId)));
    }
    return result;
  }, [flightDayIds, load, settings]);

  const context = useMemo<PlanningContextValue>(() => ({
    load,
    loadError,
    canArrange,
    online,
    dialogStep,
    scopeMode,
    useAi,
    loadingStep,
    plannerError,
    proposal,
    previewInput,
    applying,
    names: entityNames,
    days,
    inheritedSettings,
    tripSettings: settings?.resolved ?? null,
    overrideDayId,
    confirmDiscard,
    setScopeMode,
    setUseAi,
    openPlanner() {
      if (!canArrange || !hasSelectedPlaces || !online) return;
      setPlannerError("");
      setDialogStep("scope");
    },
    closePlanner,
    createPreview,
    applyProposal,
    applySuggestion,
    previewOverride,
    saveOverride,
    editPlace(placeId) {
      closePlanner();
      onEditPlace(placeId);
    },
    openOverride(dayId) { if (canArrange) setOverrideDayId(dayId); },
    closeOverride() { setOverrideDayId(null); },
    refresh,
    setConfirmDiscard,
  }), [
    applyProposal,
    applySuggestion,
    applying,
    canArrange,
    closePlanner,
    confirmDiscard,
    createPreview,
    days,
    dialogStep,
    entityNames,
    hasSelectedPlaces,
    inheritedSettings,
    settings,
    load,
    loadError,
    loadingStep,
    onEditPlace,
    online,
    overrideDayId,
    plannerError,
    previewInput,
    previewOverride,
    proposal,
    refresh,
    saveOverride,
    scopeMode,
    useAi,
  ]);

  return <PlanningContext.Provider value={context}>{children}</PlanningContext.Provider>;
}

function PlanningMeter({ label, actual, cap, display, level }: {
  label: string;
  actual: number;
  cap: number;
  display: string;
  level: "ok" | "near" | "over" | "unverifiable";
}) {
  const { t } = useI18n();
  const status = level === "ok"
    ? t.wholeTripPlanner.meters.statuses.ok
    : level === "near"
      ? t.wholeTripPlanner.meters.statuses.near
      : level === "over"
        ? t.wholeTripPlanner.meters.statuses.over
        : t.wholeTripPlanner.meters.statuses.unverifiable;
  return (
    <div className="planning-meter" data-level={level}>
      <div className="planning-meter__top">
        <span className="planning-meter__label">{label}</span>
        <span className="planning-meter__value">{display}</span>
      </div>
      <meter min={0} max={Math.max(1, cap)} value={Math.min(Math.max(0, actual), Math.max(1, cap))} aria-label={`${label} ${display}・${status}`} />
      <span className="planning-meter__status">{status}</span>
    </div>
  );
}

export function PlanningMeters({ day }: { day: PlanningDayLoadDto }) {
  const { t } = useI18n();
  const copy = t.wholeTripPlanner.meters;
  const distanceUnverifiable = day.status === "unverifiable_distance" || day.missingCoordinateIds.length > 0;
  const meters = [
    {
      label: copy.places,
      actual: day.count,
      cap: day.caps.maxPlacesPerDay,
      display: `${day.count} / ${day.caps.maxPlacesPerDay} 個`,
      level: statusLevel(day.count, day.caps.maxPlacesPerDay),
    },
    {
      label: copy.effort,
      actual: day.effort,
      cap: day.caps.maxEffortPerDay,
      display: `${day.effort} / ${day.caps.maxEffortPerDay} 點`,
      level: statusLevel(day.effort, day.caps.maxEffortPerDay),
    },
    {
      label: copy.estimatedTotal,
      actual: day.totalMinutes,
      cap: day.windowMinutes,
      display: `${durationLabel(day.totalMinutes)} / ${durationLabel(day.windowMinutes)}`,
      level: statusLevel(day.totalMinutes, day.windowMinutes),
    },
    {
      label: copy.straightDistance,
      actual: day.straightMetres,
      cap: day.caps.maxDailyStraightKm * 1000,
      display: distanceUnverifiable ? "—" : `${distanceLabel(day.straightMetres)} / ${day.caps.maxDailyStraightKm} 公里`,
      level: statusLevel(day.straightMetres, day.caps.maxDailyStraightKm * 1000, distanceUnverifiable),
    },
  ] as const;
  return (
    <>
      <div className="planning-meters">
        {meters.map((meter) => <PlanningMeter key={meter.label} {...meter} />)}
      </div>
      <details className="planning-load-details">
        <summary><ChevronRight aria-hidden="true" /> {copy.expand}</summary>
        <dl className="planning-load-parts">
          <div><dt>{copy.parts.visit}</dt><dd>{durationLabel(day.visitMinutes)}</dd></div>
          <div><dt>{copy.parts.travel}</dt><dd>{durationLabel(day.travelMinutes)}</dd></div>
          <div><dt>{copy.parts.fixed}</dt><dd>{durationLabel(day.fixedOccupancyMinutes)}</dd></div>
          <div><dt>{copy.parts.meal}</dt><dd>{durationLabel(day.mealReserveMinutes)}</dd></div>
          <div><dt>{copy.parts.rest}</dt><dd>{durationLabel(day.restMinutes)}</dd></div>
          <div><dt>{copy.parts.slack}</dt><dd>{durationLabel(day.slackMinutes)}</dd></div>
          <div><dt>{copy.longestHop}</dt><dd>{distanceUnverifiable ? "—" : `${distanceLabel(day.maxHopMetres)} / ${day.caps.maxHopStraightKm} 公里`}</dd></div>
          <div><dt>{copy.parts.window}</dt><dd>{durationLabel(day.windowMinutes)}</dd></div>
          <p className="planning-load-note">{copy.straightLineNote}</p>
          {day.noLodging ? <p className="planning-load-note">{copy.noLodging}</p> : null}
        </dl>
      </details>
    </>
  );
}

export function WholeTripPlannerButton() {
  const { t } = useI18n();
  const { load, loadError, canArrange, online, openPlanner } = usePlanning();
  if (!canArrange) return null;
  const hasFlexible = (load?.counts.flexible ?? 0) > 0;
  const disabled = !online || !hasFlexible || Boolean(loadError);
  const note = !online ? t.wholeTripPlanner.planner.offline : !hasFlexible ? t.wholeTripPlanner.planner.noPlaces : "";
  return (
    <div className="whole-trip-open-wrap">
      <button type="button" className="whole-trip-open" disabled={disabled} onClick={openPlanner}>
        <Sparkles aria-hidden="true" />
        {t.wholeTripPlanner.planner.open}
      </button>
      {note ? <p className="whole-trip-open-note">{note}</p> : null}
    </div>
  );
}

export function PlanningDaySummary({ dayId }: { dayId: string }) {
  const { t } = useI18n();
  const { load, loadError, inheritedSettings, canArrange, openOverride } = usePlanning();
  const day = load?.days.find((entry) => entry.dayId === dayId);
  const inherited = inheritedSettings.get(dayId);
  if (loadError) return <p className="planning-load-error" role="alert">{loadError}</p>;
  if (!day || !inherited) return <p className="planning-load-error" role="status">{t.wholeTripPlanner.meters.loading}</p>;
  const kind = shortcutFor(day.override, inherited);
  const over = day.status === "over_cap";
  const unverifiable = day.status === "baseline_unverifiable";
  const chip = over ? t.wholeTripPlanner.override.chip.over
    : unverifiable ? t.wholeTripPlanner.meters.statuses.baselineUnverifiable
    : t.wholeTripPlanner.override.chip[kind];
  const contents = (
    <>
      {over || unverifiable ? <TriangleAlert aria-hidden="true" /> : <SlidersHorizontal aria-hidden="true" />}
      {chip}
    </>
  );
  return (
    <div className="planning-day-summary">
      {canArrange ? (
        <button
          type="button"
          className="planning-override-chip"
          data-status={over || unverifiable ? "over" : kind}
          aria-label={`${t.wholeTripPlanner.override.open}：${chip}`}
          onClick={() => openOverride(dayId)}
        >
          {contents}
        </button>
      ) : <span className="planning-override-chip" data-status={over || unverifiable ? "over" : kind}>{contents}</span>}
      <PlanningMeters day={day} />
    </div>
  );
}

interface OverrideFieldDefinition {
  key: PlanningOverrideField;
  minimum?: number;
  maximum?: number;
  step?: number;
  unit: "places" | "effort" | "km" | "minutes" | "percent" | "time";
}

const OVERRIDE_FIELDS: OverrideFieldDefinition[] = [
  { key: "targetPlacesPerDay", minimum: 0, maximum: 10, step: 1, unit: "places" },
  { key: "maxPlacesPerDay", minimum: 1, maximum: 12, step: 1, unit: "places" },
  { key: "dayStart", unit: "time" },
  { key: "dayEnd", unit: "time" },
  { key: "maxEffortPerDay", minimum: 1, maximum: 25, step: 1, unit: "effort" },
  { key: "maxDailyStraightKm", minimum: 1, maximum: 100, step: 0.5, unit: "km" },
  { key: "maxHopStraightKm", minimum: 0.5, maximum: 50, step: 0.5, unit: "km" },
  { key: "mealReserveMinutes", minimum: 0, maximum: 180, step: 15, unit: "minutes" },
  { key: "restMinutes", minimum: 0, maximum: 180, step: 15, unit: "minutes" },
  { key: "slackPercent", minimum: 0, maximum: 40, step: 1, unit: "percent" },
];

type OverrideCopy = Messages["wholeTripPlanner"]["override"];
type PlannerCopy = Messages["wholeTripPlanner"]["planner"];

function valueWithUnit(value: PlanningSettings[PlanningOverrideField], unit: OverrideFieldDefinition["unit"], copy: OverrideCopy) {
  if (unit === "time") return String(value);
  return `${value} ${copy.units[unit]}`;
}

function OverrideSheet() {
  const { t } = useI18n();
  const {
    overrideDayId,
    closeOverride,
    load,
    days,
    inheritedSettings,
    tripSettings,
    previewOverride,
    saveOverride,
    createPreview,
    refresh,
  } = usePlanning();
  const copy = t.wholeTripPlanner.override;
  const day = load?.days.find((entry) => entry.dayId === overrideDayId);
  const dayRef = days.find((entry) => entry.id === overrideDayId);
  const inherited = overrideDayId ? inheritedSettings.get(overrideDayId) : undefined;
  const [draft, setDraft] = useState<PlanningOverride>(EMPTY_PLANNING_OVERRIDE);
  const [kind, setKind] = useState<ShortcutKind>("inherit");
  const [impact, setImpact] = useState<PlanningDayLoadDto | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const saveKey = useRef<string | null>(null);

  useEffect(() => {
    if (!day || !inherited) return;
    setDraft(day.override ?? EMPTY_PLANNING_OVERRIDE);
    setKind(shortcutFor(day.override, inherited));
    setImpact(null);
    setError("");
    saveKey.current = null;
  }, [day, inherited, overrideDayId]);

  if (!overrideDayId || !day || !dayRef || !inherited) return null;
  const effective = resolvePlanningSettings(inherited, draft, false);
  // Hoisted function declarations below do not keep the guard's narrowing; bind the narrowed values.
  const openDayId: string = overrideDayId;
  const openDay: PlanningDayLoadDto = day;

  function chooseShortcut(next: ShortcutKind) {
    setKind(next);
    setError("");
    setImpact(null);
    if (next === "inherit") setDraft(EMPTY_PLANNING_OVERRIDE);
    if (next === "relaxed" || next === "heavier") {
      // §1: absolute values from the day's current (saved) effective caps, not the live draft, so
      // pressing twice never compounds. Fields the shortcut does not touch keep their saved
      // override, otherwise dropping e.g. a saved lower hop cap would raise it back.
      const saved = openDay.override ?? EMPTY_PLANNING_OVERRIDE;
      const shortcut = shortcutOverride(openDay.caps, next);
      setDraft(Object.fromEntries(OVERRIDABLE_PLANNING_FIELDS.map((field) => [field, shortcut[field] ?? saved[field]])) as PlanningOverride);
    }
  }

  function setField(field: PlanningOverrideField, value: PlanningOverride[PlanningOverrideField]) {
    setKind("custom");
    setDraft((current) => Object.assign({ ...current }, { [field]: value }));
    setImpact(null);
    setError("");
  }

  function validationMessage() {
    // Mirror the API: cross-field rules use trip settings + this override before flight-day
    // reduction (light travel days may legitimately leave the soft target above the reduced max).
    const checked = tripSettings ? resolvePlanningSettings(tripSettings, draft, false) : effective;
    if (checked.targetPlacesPerDay > checked.maxPlacesPerDay) return "希望地點不能多於最多地點。";
    const window = planningClockMinutes(checked.dayEnd) - planningClockMinutes(checked.dayStart);
    if (window <= 0) return "回住宿時間必須晚於出門時間。";
    if (window - checked.mealReserveMinutes - checked.restMinutes - Math.ceil(window * checked.slackPercent / 100) <= 0) {
      return "用餐、休息和餘裕必須留下一些可用時間。";
    }
    return "";
  }

  async function save(force = false) {
    const validation = validationMessage();
    if (validation) { setError(validation); return; }
    setSaving(true);
    setError("");
    const reset = OVERRIDABLE_PLANNING_FIELDS.every((field) => draft[field] === null);
    const values = reset ? null : draft;
    try {
      if (!force) {
        const preview = await previewOverride(openDayId, openDay.overrideVersion ?? 0, values);
        if (preview && preview.status !== "valid") {
          setImpact(preview);
          return;
        }
      }
      if (!saveKey.current) saveKey.current = crypto.randomUUID();
      await saveOverride(openDayId, openDay.overrideVersion ?? 0, values, saveKey.current);
      notify("success", reset ? "這天已改回沿用旅程設定。" : "已儲存這天的設定。");
      closeOverride();
      await refresh();
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.code === "conflict") setError(copy.conflict);
      else setError(displayError(reason, copy.saveError));
    } finally {
      setSaving(false);
    }
  }

  async function replanWithDraft() {
    const reset = OVERRIDABLE_PLANNING_FIELDS.every((field) => draft[field] === null);
    closeOverride();
    await createPreview({
      mode: "replan",
      useAi: true,
      draftOverrides: [{ dayId: openDayId, expectedVersion: openDay.overrideVersion ?? 0, values: reset ? null : draft }],
    });
  }

  return (
    <PlaceDetailSheet
      appearance="workspace"
      open
      title={copy.title(dateLabel(dayRef.date, "zh-TW"))}
      description={copy.description}
      onClose={closeOverride}
      footer={(
        <div className="planning-override-footer">
          <button type="button" className="planning-override-footer__cancel" disabled={saving} onClick={closeOverride}>{copy.cancel}</button>
          <button type="button" className="planning-override-footer__save" disabled={saving} onClick={() => void save()}>{saving ? copy.saving : copy.save}</button>
        </div>
      )}
    >
      <div className="planning-override-form">
        <fieldset className="planning-override-shortcuts">
          <legend>快速調整</legend>
          {(["inherit", "relaxed", "heavier", "custom"] as ShortcutKind[]).map((shortcut) => (
            <label className="planning-shortcut" key={shortcut}>
              <input type="radio" name="planning-day-shortcut" checked={kind === shortcut} onChange={() => chooseShortcut(shortcut)} />
              <strong>{copy.shortcuts[shortcut]}</strong>
              <small>{copy.shortcuts[`${shortcut}Description` as keyof typeof copy.shortcuts]}</small>
            </label>
          ))}
        </fieldset>
        <div className="planning-override-fields">
          {OVERRIDE_FIELDS.map((field) => {
            const overridden = draft[field.key] !== null;
            const shownValue = overridden ? draft[field.key]! : effective[field.key];
            const label = copy.fields[field.key];
            return (
              <div className="planning-override-field" key={field.key}>
                <div className="planning-override-field__copy">
                  <strong>{label}</strong>
                  <small>
                    {overridden ? copy.overrideBadge(valueWithUnit(shownValue, field.unit, copy)) : copy.inheritBadge(valueWithUnit(shownValue, field.unit, copy))}
                    {overridden ? `・${copy.tripBaseline(valueWithUnit(inherited[field.key], field.unit, copy))}` : ""}
                  </small>
                </div>
                <label className="planning-field-switch">
                  <input
                    type="checkbox"
                    checked={overridden}
                    aria-label={copy.switchLabel(label)}
                    onChange={(event) => setField(field.key, event.target.checked ? effective[field.key] : null)}
                  />
                  這天另外設定
                </label>
                <div className="planning-override-field__control">
                  {field.unit === "time" ? (
                    <input
                      type="time"
                      value={String(shownValue)}
                      disabled={!overridden}
                      onChange={(event) => setField(field.key, event.target.value)}
                    />
                  ) : (
                    <>
                      <input
                        type="range"
                        min={field.minimum}
                        max={field.maximum}
                        step={field.step}
                        value={Number(shownValue)}
                        disabled={!overridden}
                        aria-label={label}
                        onChange={(event) => setField(field.key, Number(event.target.value))}
                      />
                      <input
                        type="number"
                        min={field.minimum}
                        max={field.maximum}
                        step={field.step}
                        value={Number(shownValue)}
                        disabled={!overridden}
                        aria-label={`${label}數值`}
                        onChange={(event) => setField(
                          field.key,
                          clamp(Number(event.target.value), field.minimum!, field.maximum!),
                        )}
                      />
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p className="planning-effective-summary">
          {copy.effectiveSummary(
            effective.maxPlacesPerDay,
            effective.maxEffortPerDay,
            durationLabel(planningClockMinutes(effective.dayEnd) - planningClockMinutes(effective.dayStart)),
            effective.maxDailyStraightKm,
          )}
        </p>
        {impact ? (
          <section className="whole-trip-alert" aria-labelledby="planning-override-impact-heading">
            <h3 id="planning-override-impact-heading">{copy.impactTitle}</h3>
            <p>{copy.impactDescription}</p>
            <PlanningMeters day={impact} />
            <div className="planning-impact-actions">
              <button type="button" onClick={() => setImpact(null)}>{copy.impactBack}</button>
              <button type="button" onClick={() => void replanWithDraft()}>{copy.impactReplan}</button>
              <button type="button" onClick={() => void save(true)}>{copy.impactSaveAnyway}</button>
            </div>
          </section>
        ) : null}
        {error ? <p role="alert" className="planning-override-error">{error}</p> : null}
      </div>
    </PlaceDetailSheet>
  );
}

function reasonLabel(check: PlanningBlockingCheckDto, copy: PlannerCopy) {
  if (check.code === "count") return `${copy.reasons.max_places}（${check.current} + ${check.added} / ${check.cap} 個）`;
  if (check.code === "effort") return `${copy.reasons.effort}（${check.current} + ${check.added} / ${check.cap} 點）`;
  if (check.code === "budget") return `${copy.reasons.budget}（${durationLabel(check.current)} + ${durationLabel(check.added)} / ${durationLabel(check.cap)}）`;
  if (check.code === "daily_km") return `${copy.reasons.daily_km}（${(check.current / 1000).toFixed(1)} + ${(check.added / 1000).toFixed(1)} / ${(check.cap / 1000).toFixed(1)} 公里）`;
  if (check.code === "max_hop") return `${copy.reasons.max_hop}（${check.km?.toFixed(1) ?? (check.added / 1000).toFixed(1)} / ${check.cap / 1000} 公里）`;
  if (check.code === "unverifiable_distance") return copy.reasons.missing_coordinates;
  return copy.reasons.baseline_unverifiable;
}

function suggestionLabel(overrides: Partial<PlanningOverride>, copy: OverrideCopy) {
  const labels = Object.entries(overrides).map(([key, value]) => {
    const field = OVERRIDE_FIELDS.find((entry) => entry.key === key);
    if (!field || value == null) return "";
    return `${copy.fields[field.key]}改成 ${valueWithUnit(value, field.unit, copy)}`;
  }).filter(Boolean);
  return labels.join("、");
}

function PlannerDialog() {
  const { t, locale } = useI18n();
  const copy = t.wholeTripPlanner.planner;
  const {
    load,
    dialogStep,
    scopeMode,
    useAi,
    loadingStep,
    plannerError,
    proposal,
    previewInput,
    applying,
    online,
    names,
    days,
    inheritedSettings,
    setScopeMode,
    setUseAi,
    closePlanner,
    createPreview,
    applyProposal,
    applySuggestion,
    editPlace,
    openOverride,
    setConfirmDiscard,
  } = usePlanning();
  const open = dialogStep !== "closed";
  const status = proposal?.result.status;
  const placed = proposal?.result.days.reduce((count, day) => count + day.orderedPlaceIds.length, 0) ?? 0;
  const total = load?.counts.flexible ?? placed + (proposal?.result.unplaced.length ?? 0);
  const remaining = Math.max(total - placed, proposal?.result.unplaced.length ?? 0);
  const hasDrafts = Boolean(proposal?.draftSettings || proposal?.draftOverrides?.length);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (dialogStep === "stale") titleRef.current?.focus();
  }, [dialogStep]);

  function discard() {
    if (hasDrafts) setConfirmDiscard(true);
    else closePlanner();
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && dialogStep !== "loading" && !applying) discard(); }}>
      <DialogContent
        className="whole-trip-dialog"
        showCloseButton={dialogStep !== "loading" && !applying}
        initialFocus={titleRef}
      >
        <DialogHeader className="whole-trip-dialog__header">
          <DialogTitle ref={titleRef} tabIndex={-1}>
            {dialogStep === "scope" ? copy.scopeTitle
              : dialogStep === "loading" ? copy.loadingTitle
                : dialogStep === "stale" ? copy.staleTitle
                  : copy.previewTitle}
          </DialogTitle>
          <DialogDescription>
            {dialogStep === "scope" ? copy.scopeDescription
              : dialogStep === "loading" ? copy.loadingNote
                : dialogStep === "stale" ? copy.staleDescription
                  : status ? copy.status[status] : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="whole-trip-dialog__body">
          {dialogStep === "scope" ? (
            <>
              <div className="whole-trip-facts" aria-label="排程範圍">
                <div>{copy.counts.flexible(load?.counts.flexible ?? 0)}</div>
                <div>{copy.counts.fixed(load?.counts.fixedSelected ?? 0)}</div>
                <div>{copy.counts.days(load?.counts.days ?? days.length)}</div>
                <div>{copy.counts.aiPending(load?.counts.aiPending ?? 0)}</div>
              </div>
              <fieldset className="whole-trip-scope">
                <legend>{copy.modeLegend}</legend>
                <label className="whole-trip-choice">
                  <input type="radio" name="whole-trip-mode" checked={scopeMode === "replan"} onChange={() => setScopeMode("replan")} />
                  <strong>{copy.modes.replan}<span className="whole-trip-recommended">{copy.modes.recommended}</span></strong>
                  <small>{copy.modes.replanDescription}</small>
                </label>
                <label className="whole-trip-choice">
                  <input type="radio" name="whole-trip-mode" checked={scopeMode === "keep"} onChange={() => setScopeMode("keep")} />
                  <strong>{copy.modes.keep}</strong>
                  <small>{copy.modes.keepDescription}</small>
                </label>
              </fieldset>
              <p className="whole-trip-fixed-note">{copy.fixedNote}</p>
              <label className="whole-trip-ai">
                <input type="checkbox" checked={useAi} onChange={(event) => setUseAi(event.target.checked)} />
                <strong>{copy.aiLabel}</strong>
                <small>{copy.aiDescription}</small>
              </label>
              <p className="whole-trip-unchanged-note">{copy.unchangedNote}</p>
              {plannerError ? <p role="alert" className="planning-override-error">{plannerError}</p> : null}
            </>
          ) : null}
          {dialogStep === "loading" ? (
            <div className="whole-trip-loading" role="status" aria-live="polite">
              <ol className="whole-trip-loading-list">
                {copy.loadingSteps.map((step, index) => (
                  <li key={step} data-state={index < loadingStep ? "done" : index === loadingStep ? "active" : "pending"}>{step}</li>
                ))}
              </ol>
              <p className="whole-trip-unchanged-note">{copy.loadingNote}</p>
            </div>
          ) : null}
          {dialogStep === "stale" ? (
            <div className="whole-trip-stale" role="alert">
              <TriangleAlert aria-hidden="true" className="mx-auto size-8 text-destructive" />
              <h3>{copy.staleTitle}</h3>
              <p>{copy.staleDescription}</p>
            </div>
          ) : null}
          {dialogStep === "preview" && proposal ? (
            <>
              <div className="whole-trip-preview-head">
                <p className="whole-trip-preview-summary">
                  {status === "complete"
                    ? copy.summaryComplete(placed, total, proposal.result.days.length)
                    : copy.summaryIncomplete(placed, total, remaining)}
                </p>
                <span className="whole-trip-draft-badge">{copy.unsaved}</span>
                <details className="whole-trip-calculation">
                  <summary>{copy.calculationDisclosure}</summary>
                  <p>{copy.calculationNote}</p>
                </details>
              </div>
              {proposal.result.conflicts.length > 0 ? (
                <section className="whole-trip-alert" aria-labelledby="whole-trip-conflicts-heading">
                  <h3 id="whole-trip-conflicts-heading">{copy.baselineTitle}</h3>
                  <p>{copy.baselineDescription}</p>
                  <ul>
                    {proposal.result.conflicts.map((conflict, index) => (
                      <li key={`${conflict.code}-${conflict.dayId ?? conflict.placeId ?? index}`}>
                        {copy.reasons[conflict.code]}
                        {conflict.dayId
                          ? `・${days.find((day) => day.id === conflict.dayId)
                            ? dateLabel(days.find((day) => day.id === conflict.dayId)!.date, locale)
                            : conflict.dayId}`
                          : ""}
                        {conflict.dayId ? (
                          <button
                            type="button"
                            className="whole-trip-inline-action"
                            onClick={() => {
                              closePlanner();
                              openOverride(conflict.dayId!);
                            }}
                          >
                            {t.wholeTripPlanner.override.open}
                          </button>
                        ) : conflict.placeId && conflict.code === "missing_coordinates" ? (
                          <button type="button" className="whole-trip-inline-action" onClick={() => editPlace(conflict.placeId!)}>
                            {t.tripSkeleton.completeLocation}
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <div className="whole-trip-days">
                {proposal.result.days.map((resultDay, index) => {
                  const dayRef = days.find((day) => day.id === resultDay.dayId);
                  const day = resultDay.load;
                  const invalid = day.status !== "valid";
                  const near = !invalid && day.utilisation >= .9;
                  const draftOverride = proposal.draftOverrides?.find((entry) => entry.dayId === resultDay.dayId);
                  const rawOverride = draftOverride
                    ? draftOverride.values
                    : load?.days.find((entry) => entry.dayId === resultDay.dayId)?.override;
                  const previewShortcut = shortcutFor(rawOverride, inheritedSettings.get(resultDay.dayId) ?? day.caps);
                  const dayStatus = day.status === "unverifiable_distance"
                    ? copy.dayStatus.unverifiable
                    : day.status === "baseline_unverifiable"
                      ? copy.dayStatus.baselineUnverifiable
                      : invalid
                      ? copy.dayStatus.invalid
                      : near
                        ? copy.dayStatus.near
                        : copy.dayStatus.valid;
                  return (
                    <details className="whole-trip-day" key={resultDay.dayId} open={index === 0}>
                      <summary>
                        <span className="whole-trip-day__heading">
                          <strong>{copy.dayTitle(index + 1, dateLabel(dayRef?.date ?? day.date ?? "", locale))}</strong>
                          <small>{dayStatus}</small>
                        </span>
                        <span className="planning-override-chip">{t.wholeTripPlanner.override.chip[previewShortcut]}</span>
                      </summary>
                      <div className="whole-trip-day__body">
                        <ol className="whole-trip-day__route">
                          {day.route.map((node, routeIndex) => {
                            const estimate = proposal.estimates[node.id];
                            const nodeName = names.get(node.id) ?? (node.kind === "lodging" ? copy.lodging : node.id);
                            return (
                              <li key={`${node.id}-${routeIndex}`}>
                                <span>
                                  {node.kind === "lodging" ? <BedDouble aria-hidden="true" className="mr-2 inline size-4" /> : null}
                                  {node.kind === "anchor" ? <Lock aria-hidden="true" className="mr-2 inline size-4" /> : null}
                                  <strong>{nodeName}</strong>
                                  {node.kind === "anchor" ? <span className="ml-2 planning-override-chip">{copy.fixed}</span> : null}
                                </span>
                                {estimate ? (
                                  <small>
                                    停留 {durationLabel(estimate.visitMinutes)}・<span className="whole-trip-source">{copy.source[estimate.visitSource]}</span><br />
                                    體力 {estimate.effortLevel} 點・<span className="whole-trip-source">{copy.source[estimate.effortSource]}</span>
                                  </small>
                                ) : null}
                              </li>
                            );
                          })}
                        </ol>
                        <PlanningMeters day={day} />
                      </div>
                    </details>
                  );
                })}
              </div>
              {proposal.result.unplaced.length > 0 ? (
                <details className="whole-trip-unplaced" open>
                  <summary>
                    <strong>{copy.unplacedTitle(proposal.result.unplaced.length)}</strong>
                    <small>{copy.unplacedDescription}</small>
                  </summary>
                  <ul className="whole-trip-unplaced__list">
                    {proposal.result.unplaced.map((place) => {
                      const suggestion = proposal.result.suggestions.find((entry) => entry.placeId === place.placeId);
                      return (
                        <li key={place.placeId}>
                          <strong>{names.get(place.placeId) ?? place.placeId}</strong>
                          <ul className="whole-trip-unplaced__reasons">
                            {place.reasons.map((reason, index) => <li key={`${reason.dayId}-${reason.code}-${index}`}>{reasonLabel(reason, copy)}</li>)}
                          </ul>
                          {place.reasons.some((reason) => reason.code === "unverifiable_distance") ? (
                            <button type="button" className="whole-trip-inline-action" onClick={() => editPlace(place.placeId)}>
                              {t.tripSkeleton.completeLocation}
                            </button>
                          ) : null}
                          {suggestion ? (
                            <div className="whole-trip-suggestion">
                              <span><strong>{copy.suggestion}：</strong>{suggestionLabel(suggestion.overrides, t.wholeTripPlanner.override)}</span>
                              <button type="button" onClick={() => void applySuggestion(place.placeId, suggestion.dayId, suggestion.overrides)}>{copy.applySuggestion}</button>
                            </div>
                          ) : <p className="whole-trip-unchanged-note">{copy.noSuggestion}</p>}
                        </li>
                      );
                    })}
                  </ul>
                </details>
              ) : null}
              {proposal.result.excludedPlaceIds.length > 0 ? (
                <details className="whole-trip-excluded">
                  <summary>{copy.noAutoParticipation}</summary>
                  <ul>{proposal.result.excludedPlaceIds.map((id) => <li key={id}>{names.get(id) ?? id}</li>)}</ul>
                </details>
              ) : null}
              {plannerError ? <p role="alert" className="planning-override-error">{plannerError}</p> : null}
            </>
          ) : null}
        </div>
        {dialogStep !== "loading" ? (
          <DialogFooter className="whole-trip-dialog__footer">
            {dialogStep === "scope" ? (
              <>
                <Button variant="outline" onClick={closePlanner}>{copy.cancel}</Button>
                <Button disabled={!online || !load} onClick={() => void createPreview()}>{copy.create}</Button>
              </>
            ) : dialogStep === "stale" ? (
              <>
                <Button variant="outline" onClick={closePlanner}>{copy.closeToOverview}</Button>
                <Button disabled={!online || !previewInput} onClick={() => previewInput && void createPreview(previewInput)}>{copy.rebuild}</Button>
              </>
            ) : dialogStep === "preview" ? (
              <>
                <Button variant="outline" disabled={applying} onClick={discard}>{copy.discard}</Button>
                <Button disabled={status !== "complete" || applying || !online} onClick={() => void applyProposal()}>
                  {applying ? copy.applying : hasDrafts ? copy.applyWithDrafts : copy.apply(total)}
                </Button>
              </>
            ) : null}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DiscardDialog() {
  const { t } = useI18n();
  const { confirmDiscard, setConfirmDiscard, closePlanner } = usePlanning();
  const copy = t.wholeTripPlanner.planner;
  return (
    <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.discardTitle}</DialogTitle>
          <DialogDescription>{copy.discardDescription}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmDiscard(false)}>{copy.keepDraft}</Button>
          <Button variant="destructive" onClick={() => { setConfirmDiscard(false); closePlanner(); }}>{copy.confirmDiscard}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function WholeTripPlanningOverlays() {
  return (
    <>
      <OverrideSheet />
      <PlannerDialog />
      <DiscardDialog />
    </>
  );
}
