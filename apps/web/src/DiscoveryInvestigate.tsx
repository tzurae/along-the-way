import { useEffect, useState, type ReactNode } from "react";
import { Check, MapPin, Pencil, RotateCw, X } from "lucide-react";

import {
  DISCOVERY_REACH_MINUTES,
  DISCOVERY_REACH_MODES,
  DISCOVERY_SCOPES,
  DISCOVERY_STAGES,
  type DiscoveryClarificationDto,
  type DiscoveryClarifyItemDto,
  type DiscoveryJobDto,
  type DiscoveryReachMinutes,
  type DiscoveryReachMode,
  type DiscoveryScope,
  type DiscoverySearchCenterDto,
  type DiscoveryStage,
} from "@along-the-way/contracts/discovery";
import type { Messages } from "./i18n";

type DiscoveryCopy = Messages["discovery"];

/** What the traveler picked for one checklist question, before it is sent as one answer string. */
export interface ClarifyDraft {
  choices: string[];
  other: string;
  otherOn: boolean;
  skipped: boolean;
}

const ANSWER_SEPARATOR = "、";

/** Rebuilds the chips from a saved answer: known options become chips, the rest is 其他 text. */
export function draftFromItem(item: DiscoveryClarifyItemDto): ClarifyDraft {
  if (item.answer === null) return { choices: [], other: "", otherOn: false, skipped: item.skipped };
  if (item.options.length === 0) return { choices: [], other: item.answer, otherOn: true, skipped: false };
  if (!item.multiple) {
    return item.options.includes(item.answer)
      ? { choices: [item.answer], other: "", otherOn: false, skipped: false }
      : { choices: [], other: item.answer, otherOn: true, skipped: false };
  }
  // Options may themselves contain 「、」: match the longest run of parts that is an option.
  const parts = item.answer.split(ANSWER_SEPARATOR);
  const choices: string[] = [];
  const rest: string[] = [];
  for (let start = 0; start < parts.length;) {
    let end = parts.length;
    while (end > start && !item.options.includes(parts.slice(start, end).join(ANSWER_SEPARATOR))) end -= 1;
    if (end > start) {
      choices.push(parts.slice(start, end).join(ANSWER_SEPARATOR));
      start = end;
    } else {
      rest.push(parts[start]!);
      start += 1;
    }
  }
  const other = rest.join(ANSWER_SEPARATOR);
  return { choices, other, otherOn: other.length > 0, skipped: false };
}

/** The answer string sent to the reviewer; null means skipped or not answered. */
export function draftAnswer(item: DiscoveryClarifyItemDto, draft: ClarifyDraft | undefined): string | null {
  if (!draft || draft.skipped) return null;
  const other = draft.otherOn || item.options.length === 0 ? draft.other.trim() : "";
  const parts = item.multiple ? [...draft.choices, other] : [other || draft.choices[0] || ""];
  const answer = parts.filter(Boolean).join(ANSWER_SEPARATOR);
  return answer || null;
}

export function clarifyDrafts(clarification: DiscoveryClarificationDto | null): Record<string, ClarifyDraft> {
  return Object.fromEntries((clarification?.items ?? []).map((item) => [item.id, draftFromItem(item)]));
}

function needsMore(item: DiscoveryClarifyItemDto) {
  return item.required && (item.verdict === "insufficient" || item.verdict === "unreasonable");
}

/**
 * What 調查 sends for the checklist. An optional question the member never touched is left out,
 * so the server keeps it unanswered instead of recording a 略過 the member did not choose.
 */
export function clarifyAnswers(clarification: DiscoveryClarificationDto, drafts: Record<string, ClarifyDraft>) {
  return clarification.items.flatMap((item) => {
    const draft = drafts[item.id];
    const answer = draftAnswer(item, draft);
    const touched = item.required || answer !== null || Boolean(draft?.skipped) || item.answer !== null || item.skipped;
    return touched ? [{ id: item.id, answer }] : [];
  });
}

export function clarifySummary(clarification: DiscoveryClarificationDto, drafts: Record<string, ClarifyDraft>) {
  const required = clarification.items.filter((item) => item.required);
  const byId = new Map(clarification.items.map((item) => [item.id, item]));
  return {
    requiredTotal: required.length,
    requiredAnswered: required.filter((item) => draftAnswer(item, drafts[item.id]) !== null).length,
    askBack: clarification.items.filter(needsMore).length,
    /** Answers differ from what the server last saw: they must be sent (and reviewed) again. */
    changed: clarifyAnswers(clarification, drafts).some(({ id, answer }) => {
      const item = byId.get(id)!;
      return answer !== item.answer || (answer === null) !== item.skipped;
    }),
  };
}

export function ThinkingIndicator({ text }: { text: string }) {
  return (
    <span className="pd-thinking">
      <span className="pd-thinking-dots" aria-hidden="true"><i /><i /><i /></span>
      {text}
    </span>
  );
}

function ClarifyQuestion({ item, index, draft, readOnly, onChange, t }: {
  item: DiscoveryClarifyItemDto;
  index: number;
  draft: ClarifyDraft;
  readOnly: boolean;
  onChange(draft: ClarifyDraft): void;
  t: DiscoveryCopy["clarify"];
}) {
  const headingId = `clarify-${item.id}`;
  const askedBack = needsMore(item);
  const pill = askedBack ? t.needsMore
    : item.verdict === "sufficient" && item.answer !== null ? t.confirmed
      : item.verdict === "unknown" ? t.uncertain
        : item.required ? t.required : t.optional;
  const pillKind = askedBack ? "warn" : item.verdict === "sufficient" && item.answer !== null ? "ok" : item.verdict === "unknown" ? "muted" : item.required ? "required" : "optional";
  const change = (next: Partial<ClarifyDraft>) => {
    if (readOnly) return;
    onChange({ ...draft, skipped: false, ...next });
  };
  const freeText = item.options.length === 0;
  const inputType = item.multiple ? "checkbox" : "radio";
  return (
    <li className="pd-clarify-item" data-attention={askedBack || undefined} data-clarify-item={item.id}>
      <div className="pd-clarify-head">
        <span id={headingId} className="pd-clarify-text">{index + 1}. {item.text}</span>
        <span className="pd-clarify-pill" data-kind={pillKind}>
          {pillKind === "ok" ? <Check aria-hidden="true" className="size-3.5" /> : null}{pill}
        </span>
      </div>
      {item.why ? <p className="pd-clarify-why">{item.why}</p> : null}
      {draft.skipped ? (
        <p className="pd-clarify-skipped">{t.skipped}</p>
      ) : (
        <>
          {freeText ? null : (
            <div className="pd-options" role={item.multiple ? "group" : "radiogroup"} aria-labelledby={headingId}>
              {item.options.map((option) => {
                const checked = draft.choices.includes(option);
                return (
                  <label key={option} className="pd-option" data-checked={checked || undefined}>
                    <input
                      type={inputType}
                      name={headingId}
                      checked={checked}
                      aria-disabled={readOnly || undefined}
                      onChange={() => change(item.multiple
                        ? { choices: checked ? draft.choices.filter((choice) => choice !== option) : [...draft.choices, option] }
                        : { choices: [option], otherOn: false })}
                    />
                    {option}
                  </label>
                );
              })}
              {item.allowOther ? (
                <label className="pd-option" data-checked={draft.otherOn || undefined}>
                  <input
                    type={inputType}
                    name={headingId}
                    checked={draft.otherOn}
                    aria-disabled={readOnly || undefined}
                    onChange={() => change(item.multiple ? { otherOn: !draft.otherOn } : { choices: [], otherOn: true })}
                  />
                  {t.other}
                </label>
              ) : null}
            </div>
          )}
          {freeText || draft.otherOn ? (
            <input
              className="pd-clarify-input"
              value={draft.other}
              readOnly={readOnly}
              maxLength={500}
              aria-labelledby={headingId}
              placeholder={t.otherPlaceholder}
              onChange={(event) => change({ other: event.target.value, otherOn: true })}
            />
          ) : null}
        </>
      )}
      {askedBack && item.reason ? <p className="pd-clarify-reason"><strong>{t.aiSays}</strong>{item.reason}</p> : null}
      {item.verdict === "unknown" ? <p className="pd-clarify-why">{t.treatedUnknown}</p> : null}
      {!item.required ? (
        <button
          type="button"
          className="pd-clarify-skip"
          aria-disabled={readOnly || undefined}
          onClick={() => {
            if (readOnly) return;
            onChange(draft.skipped ? { choices: [], other: "", otherOn: false, skipped: false } : { choices: [], other: "", otherOn: false, skipped: true });
          }}
        >
          {draft.skipped ? t.answerInstead : t.skip}
        </button>
      ) : null}
    </li>
  );
}

export function ClarifyChecklist({ clarification, drafts, readOnly, onChange, t }: {
  clarification: DiscoveryClarificationDto;
  drafts: Record<string, ClarifyDraft>;
  readOnly: boolean;
  onChange(id: string, draft: ClarifyDraft): void;
  t: DiscoveryCopy["clarify"];
}) {
  if (clarification.items.length === 0) return null;
  return (
    <section className="pd-clarify" aria-label={t.label}>
      <h3 className="pd-clarify-title">{t.label}</h3>
      <ol className="pd-clarify-list">
        {clarification.items.map((item, index) => (
          <ClarifyQuestion
            key={item.id}
            item={item}
            index={index}
            draft={drafts[item.id] ?? draftFromItem(item)}
            readOnly={readOnly}
            onChange={(draft) => onChange(item.id, draft)}
            t={t}
          />
        ))}
      </ol>
    </section>
  );
}

/**
 * 範圍, the first question 調查 asks itself (owner rule 2026-10-28), fixed chips like
 * ReachChoices. Required. 附近 needs a center: without one it cannot be picked.
 */
export function ScopeChoices({ scope, nearby, readOnly, onChange, t, required }: {
  /** null: not picked yet (or 附近 picked earlier but no center now). */
  scope: DiscoveryScope | null;
  /** The center 附近 searches around; null when there is none, so 附近 is unavailable. */
  nearby: DiscoverySearchCenterDto["source"] | null;
  readOnly: boolean;
  onChange(scope: DiscoveryScope): void;
  t: DiscoveryCopy["scope"];
  /** The 「必填」 pill text. */
  required: string;
}) {
  const labels: Record<DiscoveryScope, string> = {
    nearby: nearby === "device" ? t.nearbyDevice : t.nearbyLodging,
    city: t.city,
    region: t.region,
  };
  return (
    <section className="pd-clarify" aria-label={t.label}>
      <h3 className="pd-clarify-title">{t.label}</h3>
      <ol className="pd-clarify-list">
        <li className="pd-clarify-item" data-clarify-item="scope">
          <div className="pd-clarify-head">
            <span id="scope" className="pd-clarify-text">{t.question}</span>
            <span className="pd-clarify-pill" data-kind="required">{required}</span>
          </div>
          <div className="pd-options" role="radiogroup" aria-labelledby="scope" aria-describedby={nearby ? undefined : "scope-nearby-unavailable"}>
            {DISCOVERY_SCOPES.map((option) => {
              const unavailable = option === "nearby" && !nearby;
              return (
                <label key={option} className="pd-option" data-checked={scope === option || undefined}>
                  <input
                    type="radio"
                    name="scope"
                    checked={scope === option}
                    disabled={unavailable}
                    aria-disabled={readOnly || undefined}
                    onChange={() => {
                      if (!readOnly && !unavailable) onChange(option);
                    }}
                  />
                  {labels[option]}
                </label>
              );
            })}
          </div>
          {nearby ? null : <p id="scope-nearby-unavailable" className="pd-clarify-why">{t.nearbyUnavailable}</p>}
        </li>
      </ol>
    </section>
  );
}

/** 交通方式 and 時間 as picked; null is not picked yet, "any" is 「都可以」. */
export interface ReachDraft {
  mode: DiscoveryReachMode | null;
  time: DiscoveryReachMinutes | "any" | null;
}

/**
 * The two questions 調查 asks itself whenever it searches around a center (owner rule
 * 2026-10-22), fixed chips instead of AI questions. Both are required; research waits for them.
 */
export function ReachChoices({ draft, readOnly, onChange, t, required }: {
  draft: ReachDraft;
  readOnly: boolean;
  onChange(draft: ReachDraft): void;
  t: DiscoveryCopy["reach"];
  /** The 「必填」 pill text. */
  required: string;
}) {
  const times: Array<DiscoveryReachMinutes | "any"> = [...DISCOVERY_REACH_MINUTES, "any"];
  const questions = [
    { id: "reach-mode", text: t.modeQuestion, options: DISCOVERY_REACH_MODES.map((mode) => ({
      key: mode, label: t.modes[mode], checked: draft.mode === mode, pick: () => onChange({ ...draft, mode }),
    })) },
    { id: "reach-time", text: t.timeQuestion, options: times.map((time) => ({
      key: String(time), label: t.times[time], checked: draft.time === time, pick: () => onChange({ ...draft, time }),
    })) },
  ];
  return (
    <section className="pd-clarify" aria-label={t.label}>
      <h3 className="pd-clarify-title">{t.label}</h3>
      <ol className="pd-clarify-list">
        {questions.map((question) => (
          <li key={question.id} className="pd-clarify-item" data-clarify-item={question.id}>
            <div className="pd-clarify-head">
              <span id={question.id} className="pd-clarify-text">{question.text}</span>
              <span className="pd-clarify-pill" data-kind="required">{required}</span>
            </div>
            <div className="pd-options" role="radiogroup" aria-labelledby={question.id}>
              {question.options.map((option) => (
                <label key={option.key} className="pd-option" data-checked={option.checked || undefined}>
                  <input
                    type="radio"
                    name={question.id}
                    checked={option.checked}
                    aria-disabled={readOnly || undefined}
                    onChange={() => {
                      if (!readOnly) option.pick();
                    }}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </li>
        ))}
      </ol>
      <p className="pd-clarify-why">{t.why}</p>
    </section>
  );
}

function elapsedSeconds(startedAt: string | null, now: number) {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : null;
}

/** Element id of the batch heading, so the dialog and the toast can move focus to it. */
export const DISCOVERY_BATCH_ID = "discovery-batch";

export function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Moves focus to the batch heading and brings it into view. The panel that holds it may only
 * become visible, or the job only arrive, a few renders later, so it waits up to about a second
 * for a visible heading and then gives up quietly.
 */
export function focusDiscoveryBatch() {
  let frames = 0;
  const attempt = () => {
    const heading = document.getElementById(DISCOVERY_BATCH_ID);
    // A dialog still closing keeps focus trapped inside it; wait until it is gone.
    if (!heading || heading.offsetParent === null || document.querySelector('[role="dialog"]')) {
      if (++frames < 60) window.requestAnimationFrame(attempt);
      return;
    }
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };
  window.requestAnimationFrame(attempt);
}

/**
 * The newest 調查 job at the top of the list: while it runs, its current stage as the worker
 * reports it (nothing advances on a timer; the only clock is the running stage's elapsed time from
 * its real start); once saved, the places it found, in the same spot; if it failed, why.
 */
export function ResearchBatch({ job, failureReason, searchCenterLine, children, onDismiss, onAgain, onRetry, onEdit, busy, canRetry, t }: {
  job: DiscoveryJobDto;
  failureReason: string;
  /** Where this member's own job searched around (「以你目前位置附近搜尋」); null for others' jobs. */
  searchCenterLine?: string | null;
  /** The rows this job added; shown once the save stage finished. */
  children?: ReactNode;
  onDismiss(): void;
  onAgain(): void;
  onRetry(): void;
  /** Opens 你的需求; absent on the first run, where the request form is on the page. */
  onEdit?: () => void;
  busy: boolean;
  /** False when there is no request text to research again. */
  canRetry: boolean;
  t: DiscoveryCopy;
}) {
  const running = job.status === "queued" || job.status === "running";
  const [now, setNow] = useState(() => Date.now());
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  // A job the sweep marked interrupted keeps the stage it died in as "running"; once the job
  // itself is over, that stage is shown as where it stopped, never as still in progress.
  const stateOf = (stage: DiscoveryStage) => {
    const state = job.stages[stage].state;
    return !running && state === "running" ? "failed" : state;
  };
  const saved = stateOf("save") === "done";
  const failed = job.status === "failed";
  const count = job.addedCount ?? 0;
  const failedStage = DISCOVERY_STAGES.find((stage) => stateOf(stage) === "failed") ?? job.stage;
  const runningStage = DISCOVERY_STAGES.find((stage) => stateOf(stage) === "running") ?? null;
  const runningSeconds = runningStage ? elapsedSeconds(job.stages[runningStage].startedAt, now) : null;
  const title = failed ? t.run.failedTitle
    : job.status === "queued" ? t.run.queued
      : !saved ? t.run.title
        : running ? t.run.foundTitle(count)
          : t.run.doneTitle(count);
  const totalSeconds = job.status === "succeeded" && job.stages.plan.startedAt && job.finishedAt
    ? elapsedSeconds(job.stages.plan.startedAt, Date.parse(job.finishedAt)) : null;
  const meta = failed ? null
    : running && !saved && runningStage ? (runningSeconds === null ? t.stages[runningStage] : t.run.stageMeta(t.stages[runningStage], runningSeconds))
      : running && saved ? t.run.photosLoading
        : totalSeconds !== null ? t.run.took(totalSeconds) : null;
  const note = (stage: DiscoveryStage) => {
    const state = stateOf(stage);
    if (state === "done") return t.stages.done;
    if (state === "partial") return t.stages.photosPartial;
    if (state === "failed") return t.stages.failed;
    if (state === "pending") return t.stages.pending;
    return t.stages.running;
  };
  // Where it stopped matters when it failed; while it runs the list is one tap away.
  const showStages = failed || (running && detailsOpen);
  return (
    <section className="order-1 pd-batch" data-status={job.status} aria-labelledby={DISCOVERY_BATCH_ID}>
      <div className="pd-batch-head">
        <div className="pd-batch-heading">
          <span className="pd-batch-icon" aria-hidden="true">
            {failed ? <X className="size-4" /> : running && !saved ? <span className="pd-stage-spinner" /> : <Check className="size-4" />}
          </span>
          <h3 id={DISCOVERY_BATCH_ID} tabIndex={-1} className="pd-batch-title">{title}</h3>
          {meta ? <span className="pd-batch-meta">{meta}</span> : null}
        </div>
        <div className="pd-batch-actions">
          {running ? (
            <button type="button" className="pd-batch-link" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>
              {detailsOpen ? t.run.hideDetails : t.run.showDetails}
            </button>
          ) : (
            <>
              {!failed ? <button type="button" className="pd-batch-link" disabled={busy} onClick={onAgain}>{t.run.again}</button> : null}
              <button type="button" className="pd-batch-link" onClick={onDismiss}>{t.run.dismiss}</button>
            </>
          )}
        </div>
      </div>
      {searchCenterLine ? <p className="pd-field-help pd-search-center"><MapPin aria-hidden="true" />{searchCenterLine}</p> : null}
      {/* Read once per stage change, e.g. 「查證地點，進行中」. */}
      <p className="sr-only" role="status" aria-live="polite">
        {runningStage && !saved ? `${t.stages[runningStage]}，${t.stages.running}` : title}
      </p>
      {showStages ? (
        <ol className="pd-stages">
          {DISCOVERY_STAGES.map((stage) => {
            const state = stateOf(stage);
            return (
              <li key={stage} className="pd-stage" data-state={state}>
                <span className="pd-stage-icon" aria-hidden="true">
                  {state === "done" || state === "partial" ? <Check className="size-4" />
                    : state === "failed" ? <X className="size-4" />
                      : state === "running" ? <span className="pd-stage-spinner" /> : <span className="pd-stage-dot" />}
                </span>
                <span className="pd-stage-name">{t.stages[stage]}</span>
                <span className="pd-stage-note">{note(stage)}</span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {failed ? (
        <>
          <p className="pd-batch-failure">
            {failedStage ? t.stages.failedAt(t.stages[failedStage]) : null}{failureReason} {t.stages.answersKept}
          </p>
          <div className="pd-batch-retry">
            {onEdit ? <button className="pd-secondary" disabled={busy} onClick={onEdit}><Pencil aria-hidden="true" className="size-4" />{t.brief.editRequirements}</button> : null}
            <button className="pd-primary" disabled={busy || !canRetry} onClick={onRetry}><RotateCw aria-hidden="true" className="size-4" />{t.investigateAgain}</button>
          </div>
        </>
      ) : running && !saved ? (
        <p className="pd-batch-empty">{t.run.placeholder}</p>
      ) : saved ? (
        // Saved, but the list read that holds its rows may not have arrived yet.
        children ?? (count > 0 ? <p className="pd-batch-empty">{t.run.arranging}</p> : null)
      ) : null}
    </section>
  );
}
