import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Info, RotateCcw } from "lucide-react";

import {
  PACE_PRESETS,
  TRAVEL_PROFILES,
  parsePlanningLoadResponse,
  parsePlanningSettingsResponse,
  planningClockMinutes,
  type PacePreset,
  type PlanningDayLoadDto,
  type PlanningDrafts,
  type PlanningLoadResponse,
  type PlanningSettings,
  type PlanningSettingsResponse,
  type TravelProfile,
} from "@along-the-way/contracts/planning";
import { ConflictPanel, type EditSnapshot, type VersionConflict, useVersionConflict } from "./ConflictPanel";
import { ApiRequestError } from "./api-error";
import { notify } from "./AppToaster";
import { useI18n, type Messages } from "./i18n";
import "./trip-planning-settings.css";

interface RequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}

interface TripPlanningSettingsProps {
  tripId: string;
  revision: number;
  canEdit: boolean;
  request<T>(url: string, options?: RequestOptions): Promise<T>;
  onCreateReplanDraft?(drafts: PlanningDrafts): void;
}

type FieldErrors = Partial<Record<keyof PlanningSettings | "form", string>>;
type RetryKey = { fingerprint: string; key: string };

type NumericField =
  | "targetPlacesPerDay"
  | "maxPlacesPerDay"
  | "maxEffortPerDay"
  | "mealReserveMinutes"
  | "restMinutes"
  | "slackPercent"
  | "speedKmh"
  | "detourFactor"
  | "perLegMinutes";

const NUMERIC_FIELDS: Record<NumericField, { min: number; max: number; step: number }> = {
  targetPlacesPerDay: { min: 0, max: 10, step: 1 },
  maxPlacesPerDay: { min: 1, max: 12, step: 1 },
  maxEffortPerDay: { min: 1, max: 25, step: 1 },
  mealReserveMinutes: { min: 0, max: 180, step: 5 },
  restMinutes: { min: 0, max: 180, step: 5 },
  slackPercent: { min: 0, max: 40, step: 1 },
  speedKmh: { min: 2.5, max: 60, step: 0.5 },
  detourFactor: { min: 1, max: 2, step: 0.05 },
  perLegMinutes: { min: 0, max: 30, step: 1 },
};

const PACE_FIELDS: Partial<Record<keyof PlanningSettings, true>> = {
  targetPlacesPerDay: true, maxPlacesPerDay: true, dayStart: true, dayEnd: true,
  maxEffortPerDay: true,
  mealReserveMinutes: true, restMinutes: true, slackPercent: true, lightTravelDays: true,
};

function idempotencyKey(current: RetryKey | null, payload: unknown): RetryKey {
  const fingerprint = JSON.stringify(payload);
  return current?.fingerprint === fingerprint
    ? current
    : { fingerprint, key: crypto.randomUUID() };
}


function formatDay(date: string | undefined) {
  if (!date) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${Number(match[2])}/${Number(match[3])}` : date;
}

function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  if (hours === 0) return `${rest} 分`;
  if (rest === 0) return `${hours} 小時`;
  return `${hours} 小時 ${rest} 分`;
}

function impactLine(day: PlanningDayLoadDto) {
  return [
    formatDay(day.date) || day.dayId,
    `地點 ${day.count}/${day.caps.maxPlacesPerDay}`,
    `體力 ${day.effort}/${day.caps.maxEffortPerDay}`,
    `估計總時數 ${formatDuration(day.totalMinutes)}/${formatDuration(day.windowMinutes)}`,
  ].join("・");
}

function validationErrors(settings: PlanningSettings, messages: Messages["planningSettings"]): FieldErrors {
  const errors: FieldErrors = {};
  for (const [field, bounds] of Object.entries(NUMERIC_FIELDS) as [NumericField, (typeof NUMERIC_FIELDS)[NumericField]][]) {
    const value = settings[field];
    if (!Number.isFinite(value)) errors[field] = messages.validation.required;
    else if (value < bounds.min || value > bounds.max) errors[field] = messages.validation.range(bounds.min, bounds.max);
  }
  if (!Number.isInteger(settings.targetPlacesPerDay)) errors.targetPlacesPerDay = messages.validation.range(0, 10);
  if (!Number.isInteger(settings.maxPlacesPerDay)) errors.maxPlacesPerDay = messages.validation.range(1, 12);
  if (!Number.isInteger(settings.maxEffortPerDay)) errors.maxEffortPerDay = messages.validation.range(1, 25);
  if (!Number.isInteger(settings.mealReserveMinutes)) errors.mealReserveMinutes = messages.validation.range(0, 180);
  if (!Number.isInteger(settings.restMinutes)) errors.restMinutes = messages.validation.range(0, 180);
  if (!Number.isInteger(settings.slackPercent)) errors.slackPercent = messages.validation.range(0, 40);
  if (!Number.isInteger(settings.perLegMinutes)) errors.perLegMinutes = messages.validation.range(0, 30);
  const clockPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const endPattern = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
  if (!clockPattern.test(settings.dayStart)) errors.dayStart = messages.validation.required;
  if (!endPattern.test(settings.dayEnd)) errors.dayEnd = messages.validation.required;
  if (settings.targetPlacesPerDay > settings.maxPlacesPerDay) errors.targetPlacesPerDay = messages.validation.targetOverMax;
  if (!errors.dayStart && !errors.dayEnd) {
    const window = planningClockMinutes(settings.dayEnd) - planningClockMinutes(settings.dayStart);
    if (window <= 0) errors.dayEnd = messages.validation.endBeforeStart;
    else if (window - settings.mealReserveMinutes - settings.restMinutes - Math.ceil(window * settings.slackPercent / 100) <= 0) {
      errors.form = messages.validation.noBudget;
    }
  }
  return errors;
}

function NumberField({ field, value, disabled, error, label, unit, help, onChange }: {
  field: NumericField;
  value: number;
  disabled: boolean;
  error?: string;
  label: string;
  unit: string;
  help: string;
  onChange(value: number): void;
}) {
  const bounds = NUMERIC_FIELDS[field];
  const id = `planning-settings-${field}`;
  const errorId = `${id}-error`;
  return (
    <div className="planning-settings__field">
      <div className="planning-settings__field-copy">
        <label htmlFor={id}>{label}</label>
        <p id={`${id}-help`}>{help}</p>
      </div>
      <div className="planning-settings__field-controls">
        <input
          type="range"
          min={bounds.min}
          max={bounds.max}
          step={bounds.step}
          value={Number.isFinite(value) ? value : bounds.min}
          disabled={disabled}
          aria-label={label}
          aria-describedby={`${id}-help${error ? ` ${errorId}` : ""}`}
          aria-invalid={Boolean(error)}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span className="planning-settings__number">
          <input
            id={id}
            type="number"
            min={bounds.min}
            max={bounds.max}
            step={bounds.step}
            value={Number.isFinite(value) ? value : ""}
            disabled={disabled}
            aria-describedby={`${id}-help${error ? ` ${errorId}` : ""}`}
            aria-invalid={Boolean(error)}
            onChange={(event) => onChange(event.target.value === "" ? Number.NaN : Number(event.target.value))}
          />
          <span aria-hidden="true">{unit}</span>
        </span>
      </div>
      {error ? <p id={errorId} className="planning-settings__field-error">{error}</p> : null}
    </div>
  );
}

export function TripPlanningSettings({ tripId, revision, canEdit, request, onCreateReplanDraft }: TripPlanningSettingsProps) {
  const { t: { planningSettings: t } } = useI18n();
  const [base, setBase] = useState<EditSnapshot<PlanningSettings> | null>(null);
  const [draft, setDraft] = useState<PlanningSettings | null>(null);
  const [baselineLoad, setBaselineLoad] = useState<PlanningLoadResponse | null>(null);
  const [impact, setImpact] = useState<PlanningDayLoadDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [firstUse, setFirstUse] = useState(false);
  const [liveConflict, setLiveConflict] = useState<VersionConflict<PlanningSettings> | null>(null);
  const loadSequence = useRef(0);
  const retryKey = useRef<RetryKey | null>(null);
  const revisionSequence = useRef(0);
  const lastRevision = useRef(revision);
  const errorSummary = useRef<HTMLDivElement>(null);
  const resolution = useVersionConflict<PlanningSettings>();

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setReadError("");
    try {
      const [settings, planningLoad] = await Promise.all([
        request<PlanningSettingsResponse>(`/api/trips/${tripId}/planning-settings`, { parse: parsePlanningSettingsResponse }),
        request<PlanningLoadResponse>(`/api/trips/${tripId}/planning-load`, { parse: parsePlanningLoadResponse }),
      ]);
      if (sequence !== loadSequence.current) return;
      const snapshot = { input: settings.resolved, version: settings.version };
      setBase(snapshot);
      setDraft(snapshot.input);
      setBaselineLoad(planningLoad);
      setFirstUse(settings.raw === null);
      setImpact([]);
      setErrors({});
      setSaveError("");
      resolution.clear();
      setLiveConflict(null);
    } catch (reason) {
      if (sequence === loadSequence.current) setReadError(reason instanceof Error ? reason.message : t.loadError);
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [request, t.loadError, tripId]);

  useEffect(() => {
    void load();
    return () => { ++loadSequence.current; };
  }, [load]);

  useEffect(() => {
    if (revision === lastRevision.current) return;
    lastRevision.current = revision;
    if (!base || !draft || busy) return;
    const sequence = ++revisionSequence.current;
    const edited = JSON.stringify(base.input) !== JSON.stringify(draft);
    void (async () => {
      try {
        const [settings, planningLoad] = await Promise.all([
          request<PlanningSettingsResponse>(`/api/trips/${tripId}/planning-settings`, { parse: parsePlanningSettingsResponse }),
          request<PlanningLoadResponse>(`/api/trips/${tripId}/planning-load`, { parse: parsePlanningLoadResponse }),
        ]);
        if (sequence !== revisionSequence.current) return;
        const current = { input: settings.resolved, version: settings.version };
        setBaselineLoad(planningLoad);
        setFirstUse(settings.raw === null);
        if (settings.version === base.version) return;
        if (edited) {
          setLiveConflict({ base, current, attempted: draft, latestChange: null });
          return;
        }
        setBase(current);
        setDraft(current.input);
        setImpact([]);
        setErrors({});
        setSaveError("");
      } catch {
        if (sequence === revisionSequence.current) setBaselineLoad(null);
      }
    })();
  }, [revision]);

  const changed = Boolean(base && draft && JSON.stringify(base.input) !== JSON.stringify(draft));
  const canSave = firstUse || changed;
  const profileLabel = draft ? t.travelProfiles[draft.travelProfile].label : t.travelProfiles.transit.label;

  function update<K extends keyof PlanningSettings>(field: K, value: PlanningSettings[K], affectsPace = Boolean(PACE_FIELDS[field])) {
    setDraft((current) => current ? { ...current, [field]: value, ...(affectsPace ? { pacePreset: "custom" as const } : {}) } : current);
    setErrors((current) => ({ ...current, [field]: undefined, form: undefined }));
    setImpact([]);
    setSaveError("");
  }

  function choosePace(preset: PacePreset) {
    if (!draft || preset === "custom") return;
    setDraft({ ...draft, ...PACE_PRESETS[preset], pacePreset: preset });
    setErrors({});
    setImpact([]);
    setSaveError("");
  }

  function chooseTravelProfile(profile: TravelProfile) {
    if (!draft) return;
    if (profile === "custom") {
      update("travelProfile", "custom");
      return;
    }
    setDraft({ ...draft, ...TRAVEL_PROFILES[profile], travelProfile: profile, pacePreset: "custom" });
    setErrors((current) => ({ ...current, speedKmh: undefined, detourFactor: undefined, perLegMinutes: undefined }));
    setImpact([]);
    setSaveError("");
  }

  async function persist(values: PlanningSettings, version = base?.version ?? 0, conflictBase = resolution.conflictBaseVersion) {
    if (!base) return;
    const payload = { expectedVersion: version, values };
    retryKey.current = idempotencyKey(retryKey.current, payload);
    setBusy(true);
    setSaveError("");
    try {
      const response = await request<PlanningSettingsResponse>(`/api/trips/${tripId}/planning-settings`, {
        method: "PUT",
        headers: {
          "Idempotency-Key": retryKey.current.key,
          ...(conflictBase === undefined ? {} : { "Conflict-Base-Version": String(conflictBase) }),
        },
        body: JSON.stringify(payload),
        parse: parsePlanningSettingsResponse,
      });
      retryKey.current = null;
      const snapshot = { input: response.resolved, version: response.version };
      setBase(snapshot);
      setDraft(snapshot.input);
      setFirstUse(false);
      setImpact([]);
      setErrors({});
      resolution.clear();
      setLiveConflict(null);
      try {
        const nextLoad = await request<PlanningLoadResponse>(`/api/trips/${tripId}/planning-load`, { parse: parsePlanningLoadResponse });
        setBaselineLoad(nextLoad);
      } catch {
        setBaselineLoad(null);
      }
      notify("success", t.saved);
    } catch (reason) {
      try {
        if (await resolution.capture(reason, base, values, async () => {
          const current = await request<PlanningSettingsResponse>(`/api/trips/${tripId}/planning-settings`, { parse: parsePlanningSettingsResponse });
          return { input: current.resolved, version: current.version };
        })) return;
      } catch (captureError) {
        setSaveError(captureError instanceof Error ? captureError.message : t.saveError);
        return;
      }
      setSaveError(reason instanceof ApiRequestError ? `${t.saveError} ${reason.message}` : t.saveError);
    } finally {
      setBusy(false);
    }
  }

  async function inspectImpact() {
    if (!base || !draft) return;
    const nextErrors = validationErrors(draft, t);
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) {
      window.requestAnimationFrame(() => errorSummary.current?.focus());
      return;
    }
    setBusy(true);
    setSaveError("");
    setImpact([]);
    try {
      const drafts: PlanningDrafts = { draftSettings: { expectedVersion: base.version, values: draft } };
      const draftLoad = await request<PlanningLoadResponse>(`/api/trips/${tripId}/planning-load`, {
        method: "POST",
        body: JSON.stringify(drafts),
        parse: parsePlanningLoadResponse,
      });
      const previousByDay = new Map(baselineLoad?.days.map((day) => [day.dayId, day]));
      const affected = draftLoad.days.filter((day) => day.status !== "valid"
        && (baselineLoad === null || previousByDay.get(day.dayId)?.status === "valid"));
      if (affected.length > 0) {
        setImpact(affected);
        return;
      }
      setBusy(false);
      await persist(draft);
    } catch (reason) {
      try {
        if (await resolution.capture(reason, base, draft, async () => {
          const current = await request<PlanningSettingsResponse>(`/api/trips/${tripId}/planning-settings`, { parse: parsePlanningSettingsResponse });
          return { input: current.resolved, version: current.version };
        })) return;
      } catch (captureError) {
        setSaveError(captureError instanceof Error ? captureError.message : t.previewError);
        return;
      }
      setSaveError(reason instanceof Error ? `${t.previewError} ${reason.message}` : t.previewError);
    } finally {
      setBusy(false);
    }
  }

  const basicNumericFields = useMemo(() => [
    "targetPlacesPerDay", "maxPlacesPerDay", "maxEffortPerDay",
  ] as const, []);
  const advancedNumericFields = useMemo(() => [
    "mealReserveMinutes", "restMinutes", "slackPercent",
  ] as const, []);
  const travelNumericFields = useMemo(() => ["speedKmh", "detourFactor", "perLegMinutes"] as const, []);

  if (loading && !draft) {
    return <section className="planning-settings" aria-labelledby="planning-settings-heading">
      <div className="planning-settings__head"><h2 id="planning-settings-heading">{t.title}</h2><p>{t.description}</p></div>
      <p className="sr-only" role="status" aria-live="polite">{t.loading}</p>
      <div className="planning-settings__skeleton" aria-hidden="true"><span /><span /><span /><span /></div>
    </section>;
  }

  if (readError || !base || !draft) {
    return <section className="planning-settings" aria-labelledby="planning-settings-heading">
      <div className="planning-settings__head"><h2 id="planning-settings-heading">{t.title}</h2><p>{t.description}</p></div>
      <div className="planning-settings__error" role="alert"><p>{t.loadError}</p><button type="button" className="planning-settings__button" onClick={() => void load()}>{t.retry}</button></div>
    </section>;
  }

  const conflict = resolution.conflict ?? liveConflict;
  return (
    <section className="planning-settings" aria-labelledby="planning-settings-heading">
      <div className="planning-settings__head"><h2 id="planning-settings-heading">{t.title}</h2><p>{t.description}</p></div>
      {firstUse ? <div className="planning-settings__notice" role="status"><p>{t.firstUse}</p></div> : null}
      {!canEdit ? <div className="planning-settings__notice"><p>{t.readOnly}</p></div> : null}
      <aside className="planning-settings__explanation" aria-labelledby="planning-not-timetable">
        <h3 id="planning-not-timetable"><Info aria-hidden="true" className="mr-2 inline size-5" />{t.notTimetableTitle}</h3>
        <p>{t.notTimetableBody}</p><p>{t.straightLineNote}</p>
      </aside>
      {Object.values(errors).some(Boolean) ? <div ref={errorSummary} tabIndex={-1} className="planning-settings__error" role="alert"><p>{t.validationSummary} {Object.values(errors).find(Boolean)}</p></div> : null}
      {saveError ? <div className="planning-settings__error" role="alert"><p>{saveError}</p></div> : null}
      {conflict ? <ConflictPanel
        conflict={conflict}
        busy={busy}
        onAccept={() => {
          if (!conflict.current) return;
          setBase(conflict.current);
          setDraft(conflict.current.input);
          setImpact([]);
          resolution.clear();
          setLiveConflict(null);
          void (async () => {
            try {
              setBaselineLoad(await request<PlanningLoadResponse>(`/api/trips/${tripId}/planning-load`, { parse: parsePlanningLoadResponse }));
            } catch {
              setBaselineLoad(null);
            }
          })();
        }}
        onReapply={() => void persist(conflict.attempted, conflict.current!.version, conflict.base.version)}
        onEdit={() => {
          setBase(conflict.current!);
          setDraft(conflict.attempted);
          setImpact([]);
          resolution.resume();
          setLiveConflict(null);
        }}
        formatValue={(path, value) => {
          if (path === "pacePreset" && typeof value === "string" && value in t.presets) return t.presets[value as PacePreset].label;
          if (path === "travelProfile" && typeof value === "string" && value in t.travelProfiles) return t.travelProfiles[value as TravelProfile].label;
          if (path === "lightTravelDays" && typeof value === "boolean") return value ? "開啟" : "關閉";
          return undefined;
        }}
      /> : null}
      {!conflict ? <form className="planning-settings__form" onSubmit={(event) => { event.preventDefault(); void inspectImpact(); }}>
        <fieldset className="planning-settings__section" disabled={!canEdit || busy}>
          <legend>{t.paceLegend}</legend>
          <div className="planning-settings__presets">
            {(["chill", "balanced", "packed"] as const).map((preset) => <label key={preset} className="planning-settings__choice">
              <input type="radio" name="pace-preset" value={preset} checked={draft.pacePreset === preset} onChange={() => choosePace(preset)} />
              <strong>{t.presets[preset].label}{preset === "balanced" ? <span className="planning-settings__recommended">{t.presets.balanced.recommended}</span> : null}</strong>
              <small>{t.presets[preset].description}</small>
            </label>)}
          </div>
          {draft.pacePreset === "custom" ? <label className="planning-settings__choice mt-2">
            <input type="radio" name="pace-preset" value="custom" checked readOnly />
            <strong>{t.presets.custom.label}</strong><small>{t.presets.custom.description}</small>
          </label> : null}
        </fieldset>

        <fieldset className="planning-settings__section" disabled={!canEdit || busy}>
          <legend>{t.basicsTitle}</legend>
          <div className="planning-settings__fields">
            {basicNumericFields.slice(0, 2).map((field) => <NumberField key={field} field={field} value={draft[field]} disabled={!canEdit || busy} error={errors[field]} {...t.fields[field]} onChange={(value) => update(field, value)} />)}
          </div>
          <div className="planning-settings__time-grid mt-3">
            {(["dayStart", "dayEnd"] as const).map((field) => {
              const id = `planning-settings-${field}`; const error = errors[field];
              return <div key={field} className="planning-settings__field">
                <div className="planning-settings__field-copy"><label htmlFor={id}>{t.fields[field].label}</label><p id={`${id}-help`}>{t.fields[field].help}</p></div>
                <input id={id} data-clock inputMode="numeric" placeholder="HH:mm" value={draft[field]} disabled={!canEdit || busy} aria-invalid={Boolean(error)} aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`} onChange={(event) => update(field, event.target.value)} />
                {error ? <p id={`${id}-error`} className="planning-settings__field-error">{error}</p> : null}
              </div>;
            })}
          </div>
          <div className="planning-settings__fields mt-3">
            {basicNumericFields.slice(2).map((field) => <NumberField key={field} field={field} value={draft[field]} disabled={!canEdit || busy} error={errors[field]} {...t.fields[field]} onChange={(value) => update(field, value)} />)}
          </div>
        </fieldset>

        <details className="planning-settings__advanced">
          <summary>{t.advancedSummary(profileLabel)}</summary>
          <div className="planning-settings__advanced-body">
            <section className="planning-settings__advanced-group" aria-labelledby="planning-time-rest"><h4 id="planning-time-rest">{t.timeAndRest}</h4>
              <p className="planning-settings__rule">{t.fixedOccupancy}</p>
              <div className="planning-settings__fields">
                {advancedNumericFields.map((field) => <NumberField key={field} field={field} value={draft[field]} disabled={!canEdit || busy} error={errors[field]} {...t.fields[field]} onChange={(value) => update(field, value)} />)}
              </div>
            </section>
            <fieldset className="planning-settings__section" disabled={!canEdit || busy} aria-describedby="planning-travel-profile-help">
              <legend>{t.travelProfileLegend}</legend>
              <p id="planning-travel-profile-help" className="planning-settings__section-help">{t.travelProfileHelp}</p>
              <div className="planning-settings__profiles">
                {(["walk", "transit", "car", "custom"] as const).map((profile) => <label key={profile} className="planning-settings__choice">
                  <input type="radio" name="travel-profile" value={profile} checked={draft.travelProfile === profile} onChange={() => chooseTravelProfile(profile)} />
                  <strong>{t.travelProfiles[profile].label}</strong><small>{t.travelProfiles[profile].description}</small>
                </label>)}
              </div>
            </fieldset>
            <section className="planning-settings__advanced-group" aria-labelledby="planning-movement"><h4 id="planning-movement">{t.movement}</h4>
              <div className="planning-settings__fields">
                {travelNumericFields.map((field) => <NumberField key={field} field={field} value={draft[field]} disabled={!canEdit || busy} error={errors[field]} {...t.fields[field]} onChange={(value) => {
                  setDraft((current) => current ? { ...current, [field]: value, travelProfile: "custom", pacePreset: "custom" } : current);
                  setErrors((current) => ({ ...current, [field]: undefined })); setImpact([]); setSaveError("");
                }} />)}
              </div>
              <label className="planning-settings__switch"><input type="checkbox" checked={draft.lightTravelDays} disabled={!canEdit || busy} onChange={(event) => update("lightTravelDays", event.target.checked)} /><span><strong>{t.lightTravelDays}</strong>{t.lightTravelDaysHelp}</span></label>
            </section>
            <details className="planning-settings__formula"><summary>{t.formulaTitle}</summary><p>{t.travelFormula}</p><p>{t.totalFormula}</p></details>
          </div>
        </details>

        {impact.length > 0 ? <section className="planning-settings__impact" aria-labelledby="planning-impact-title">
          <h3 id="planning-impact-title"><AlertTriangle aria-hidden="true" className="mr-2 inline size-5" />{t.impact.title(impact.length)}</h3>
          <p>{t.impact.description}</p>
          <ul>{impact.map((day) => <li key={day.dayId}>{day.status === "baseline_unverifiable" ? t.impact.baseline(formatDay(day.date) || day.dayId) : impactLine(day)}</li>)}</ul>
          <div className="planning-settings__impact-actions">
            <button type="button" className="planning-settings__button" onClick={() => setImpact([])}>{t.impact.back}</button>
            {onCreateReplanDraft ? <button type="button" className="planning-settings__button planning-settings__button--primary" onClick={() => onCreateReplanDraft({ draftSettings: { expectedVersion: base.version, values: draft } })}>{t.impact.replan}</button> : null}
            <button type="button" className="planning-settings__button" disabled={busy} onClick={() => void persist(draft)}>{t.impact.saveAnyway}</button>
          </div>
        </section> : null}

        {canEdit ? <div className="planning-settings__savebar">
          <button type="button" className="planning-settings__button" disabled={!changed || busy} onClick={() => { setDraft(base.input); setErrors({}); setImpact([]); setSaveError(""); }}><RotateCcw aria-hidden="true" className="mr-2 inline size-4" />{t.discard}</button>
          <button type="submit" className="planning-settings__button planning-settings__button--primary" disabled={!canSave || busy || impact.length > 0}>{busy ? t.saving : t.save}</button>
        </div> : null}
      </form> : null}
    </section>
  );
}
