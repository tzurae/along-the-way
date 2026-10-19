import { useEffect, useState, type ReactNode } from "react";
import { Check, X } from "lucide-react";

import {
  DISCOVERY_STAGES,
  type DiscoveryClarificationDto,
  type DiscoveryClarifyItemDto,
  type DiscoveryJobDto,
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

function elapsedSeconds(startedAt: string | null, now: number) {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : null;
}

/**
 * The stages of one 調查 job exactly as the worker reports them; nothing advances on a timer.
 * The only clock here is the elapsed time of the running stage, measured from its real start.
 */
export function ResearchProgress({ job, failureReason, actions, t }: {
  job: DiscoveryJobDto;
  failureReason: string;
  actions?: ReactNode;
  t: DiscoveryCopy;
}) {
  const running = job.status === "queued" || job.status === "running";
  const [now, setNow] = useState(() => Date.now());
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
  const failedStage = DISCOVERY_STAGES.find((stage) => stateOf(stage) === "failed") ?? job.stage;
  const title = job.status === "failed" ? t.run.failedTitle
    : saved ? t.run.doneTitle(job.addedCount ?? 0)
      : job.status === "queued" ? t.run.queued : t.run.title;
  const runningStage = DISCOVERY_STAGES.find((stage) => stateOf(stage) === "running") ?? null;
  const runningCopy: Record<DiscoveryStage, string> = {
    plan: t.stages.planRunning,
    research: t.stages.researchRunning,
    verify: t.stages.verifyRunning,
    save: t.stages.saveRunning,
    photos: t.stages.photosRunning,
  };
  const note = (stage: DiscoveryStage) => {
    const entry = job.stages[stage];
    const state = stateOf(stage);
    if (state === "done") return t.stages.done;
    if (state === "partial") return t.stages.photosPartial;
    if (state === "failed") return t.stages.failed;
    if (state === "pending") return t.stages.pending;
    const seconds = elapsedSeconds(entry.startedAt, now);
    const base = stage === "photos" && saved ? t.stages.photosNonBlocking : runningCopy[stage];
    return seconds === null ? base : `${base}・${t.stages.elapsed(seconds)}`;
  };
  // Collapsed to one line once everything finished; the list stays while photos still load.
  const collapsed = job.status === "succeeded";
  return (
    <section className="order-1 pd-progress" data-status={job.status} aria-labelledby={`discovery-job-${job.id}`}>
      <h3 id={`discovery-job-${job.id}`} className="pd-progress-title">
        {collapsed ? <Check aria-hidden="true" className="size-4" /> : null}{title}
      </h3>
      {/* Read once per stage change, e.g. 「查證地點，進行中」. */}
      <p className="sr-only" role="status" aria-live="polite">
        {runningStage ? `${t.stages[runningStage]}，${t.stages.running}` : title}
      </p>
      {collapsed ? null : (
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
      )}
      {job.status === "failed" ? (
        <>
          <p className="pd-progress-failure">
            {failedStage ? t.stages.failedAt(t.stages[failedStage]) : null}{failureReason} {t.stages.answersKept}
          </p>
          {actions ? <div className="pd-progress-actions">{actions}</div> : null}
        </>
      ) : null}
    </section>
  );
}
