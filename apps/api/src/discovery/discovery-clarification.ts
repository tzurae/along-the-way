import type { DiscoveryClarificationDto, DiscoveryClarifyVerdict } from "@along-the-way/contracts/discovery";

import type { ClarifyQuestionDraft, ClarifyReviewVerdict, DiscoveryQuestionAnswer } from "./discovery-model";

/** Owner decision 2026-10-19: the reviewer asks back about one required question at most twice. */
export const MAX_CLARIFY_FOLLOW_UPS = 2;
/** Stored answers are short; this also bounds what the reviewer and research prompts receive. */
const MAX_ANSWER_LENGTH = 500;

/** One checklist question as stored in discovery_clarifications.items. */
export interface StoredClarifyItem extends ClarifyQuestionDraft {
  id: string;
  answer: string | null;
  skipped: boolean;
  verdict: DiscoveryClarifyVerdict | null;
  reason: string | null;
  /** The reviewer's restatement given to research; null when unknown or skipped. */
  interpretation: string | null;
  followUps: number;
}

export function newClarifyItems(questions: readonly ClarifyQuestionDraft[]): StoredClarifyItem[] {
  return questions.slice(0, 5).map((question, index) => ({
    ...question,
    id: `q${index + 1}`,
    answer: null,
    skipped: false,
    verdict: null,
    reason: null,
    interpretation: null,
    followUps: 0,
  }));
}

/** Rows are written only by this module; a malformed row is a bug, so it fails loudly. */
export function storedClarifyItems(value: unknown): StoredClarifyItem[] {
  if (!Array.isArray(value)) throw new Error("Stored clarification items are not an array");
  return value.map((raw) => {
    const item = raw as StoredClarifyItem;
    if (typeof item?.id !== "string" || typeof item.text !== "string" || !Array.isArray(item.options)) {
      throw new Error("Stored clarification item is malformed");
    }
    return item;
  });
}

/**
 * Applies the traveler's answers. Returns a validation message instead of throwing so the caller
 * owns the error type. Unlisted items keep their previous answer.
 */
export function applyClarifyAnswers(
  items: readonly StoredClarifyItem[],
  answers: ReadonlyArray<{ id: string; answer: string | null }>,
): { items: StoredClarifyItem[] } | { error: string } {
  const byId = new Map(answers.map((answer) => [answer.id, answer.answer]));
  for (const id of byId.keys()) {
    if (!items.some((item) => item.id === id)) return { error: "Each answer must match a checklist question" };
  }
  const next = items.map((item) => {
    if (!byId.has(item.id)) return { ...item };
    const raw = byId.get(item.id);
    const answer = raw === null || raw === undefined ? null : raw.trim().slice(0, MAX_ANSWER_LENGTH) || null;
    const changed = answer !== item.answer || (answer === null) !== item.skipped;
    // A changed answer is reviewed again; an unchanged one keeps its verdict.
    return changed
      ? { ...item, answer, skipped: answer === null, verdict: null, reason: null, interpretation: null }
      : { ...item };
  });
  const missing = next.find((item) => item.required && item.answer === null);
  if (missing) return { error: "Required questions need an answer" };
  return { items: next };
}

/** Items the reviewer must still judge: answered or skipped, not yet accepted. */
export function itemsNeedingReview(items: readonly StoredClarifyItem[]) {
  return items.filter((item) => item.verdict === null || item.verdict === "insufficient" || item.verdict === "unreasonable");
}

/**
 * Folds reviewer verdicts in. Optional questions are always accepted. A required question the
 * reviewer still rejects after MAX_CLARIFY_FOLLOW_UPS ask-backs becomes "unknown": research treats
 * it as uncertain instead of asking forever.
 */
export function applyClarifyReview(
  items: readonly StoredClarifyItem[],
  reviewed: ReadonlySet<string>,
  verdicts: readonly ClarifyReviewVerdict[],
): StoredClarifyItem[] {
  const byId = new Map(verdicts.map((verdict) => [verdict.id, verdict]));
  return items.map((item) => {
    if (!reviewed.has(item.id)) return { ...item };
    const verdict = byId.get(item.id);
    if (!item.required || item.answer === null) {
      return { ...item, verdict: "sufficient", reason: null, interpretation: item.answer === null ? null : verdict?.interpretation ?? item.answer };
    }
    if (verdict?.verdict === "sufficient") {
      return { ...item, verdict: "sufficient", reason: null, interpretation: verdict.interpretation ?? item.answer };
    }
    if (item.followUps >= MAX_CLARIFY_FOLLOW_UPS) {
      return { ...item, verdict: "unknown", reason: null, interpretation: null };
    }
    return {
      ...item,
      verdict: verdict?.verdict ?? "insufficient",
      reason: verdict?.reason ?? "請再具體一點說明。",
      interpretation: null,
      followUps: item.followUps + 1,
    };
  });
}

export function clarificationReady(items: readonly StoredClarifyItem[]) {
  return items.every((item) => !item.required || item.verdict === "sufficient" || item.verdict === "unknown");
}

/** What plan/research receive: the question and the reviewer's restatement, null when uncertain. */
export function clarificationQuestionAnswers(items: readonly StoredClarifyItem[]): DiscoveryQuestionAnswer[] {
  return items.map((item) => ({ question: item.text, answer: item.interpretation }));
}

export function clarificationDto(row: {
  brief_version: number;
  status: "asking" | "ready";
  items: unknown;
  version: number;
}): DiscoveryClarificationDto {
  return {
    briefVersion: row.brief_version,
    status: row.status,
    items: storedClarifyItems(row.items).map((item) => ({
      id: item.id,
      text: item.text,
      why: item.why,
      options: item.options,
      allowOther: item.allowOther,
      multiple: item.multiple,
      required: item.required,
      answer: item.answer,
      skipped: item.skipped,
      verdict: item.verdict,
      reason: item.reason,
      followUps: item.followUps,
    })),
    maxFollowUps: MAX_CLARIFY_FOLLOW_UPS,
    version: row.version,
  };
}
