import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Check, ExternalLink, Images, RefreshCw, Search, X } from "lucide-react";

import {
  parseDiscoveryWorkspaceResponse,
  type CandidateProposalDto,
  type DiscoveryClaimSentenceDto,
  type DiscoveryEndorsement,
  type DiscoveryFeedbackDto,
  type DiscoveryQuestionAnswerDto,
  type DiscoveryShortfallDto,
  type DiscoveryWorkspaceDto,
} from "@along-the-way/contracts/discovery";
import type { TripDto } from "@along-the-way/contracts/private-trips";
import { parseTripPlaceListResponse } from "@along-the-way/contracts/trip-places";
import { googleMapsPlaceUrl } from "./google-maps";
import { useI18n, type Messages } from "./i18n";
import { VoteControl, VoteVoters } from "./VoteControl";
import { ConflictPanel, useVersionConflict } from "./ConflictPanel";

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

interface DiscoveryWorkspaceProps {
  trip: TripDto;
  request: Request;
  placesRevision: number;
  onPlacesChanged(): void;
}

type RetryKeys = Map<string, { fingerprint: string; key: string }>;

function retryKey(store: RetryKeys, operation: string, payload: unknown) {
  const fingerprint = JSON.stringify(payload);
  const existing = store.get(operation);
  if (existing?.fingerprint === fingerprint) return existing.key;
  const key = crypto.randomUUID();
  store.set(operation, { fingerprint, key });
  return key;
}

function clearRetryKey(store: RetryKeys, operation: string) {
  store.delete(operation);
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function shouldStartFreshRequest(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "model_unavailable" || error.code === "provider_unavailable";
}

// Where an outcome is reported: next to the control that caused it, or at the top.
type NoticeArea = "general" | "find" | "again" | "feedback" | "questions";

function missingServices(
  workspace: DiscoveryWorkspaceDto,
  needsPlaces: boolean,
  t: Messages["discovery"],
) {
  return [
    ...(workspace.modelAvailable ? [] : [t.services.openAi]),
    ...(needsPlaces && !workspace.placeProviderAvailable ? [t.services.googleMaps] : []),
  ];
}

function endorsementLabel(
  endorsement: DiscoveryEndorsement,
  t: Messages["discovery"],
) {
  switch (endorsement) {
    case "google_reviews": return t.endorsement.googleReviews;
    case "wikivoyage": return t.endorsement.wikivoyage;
    case "official_tourism": return t.endorsement.officialTourism;
  }
}

function shortfallText(shortfall: DiscoveryShortfallDto, t: Messages["discovery"]) {
  switch (shortfall.code) {
    case "not_researched":
      return t.shortfall.notResearched;
    case "not_found":
      return t.shortfall.notFound;
    case "name_mismatch":
      return t.shortfall.nameMismatch;
    case "single_source": {
      // Fewer than two by definition: none, or exactly one.
      const vouched = shortfall.endorsements.map((endorsement) =>
        endorsementLabel(endorsement, t)
      ).join("、");
      return vouched ? t.shortfall.oneSource(vouched) : t.shortfall.noSource;
    }
    case "category_short":
      return shortfall.count ? t.shortfall.onePassed : t.shortfall.nonePassed;
    case "in_wishlist":
      return t.shortfall.inWishlist;
    case "rejected":
      return t.shortfall.rejectedBefore;
    case "permanently_closed":
      return t.shortfall.permanentlyClosed;
    case "temporarily_closed":
      return t.shortfall.temporarilyClosed;
    case "outside_trip":
      return t.shortfall.outsideTrip;
    case "no_location":
      return t.shortfall.noLocation;
  }
}

type NumberedEvidence = Map<string, {
  item: CandidateProposalDto["evidence"][number];
  number: number;
}>;

function ClaimSentence({
  sentence,
  numberedEvidence,
  t,
}: {
  sentence: DiscoveryClaimSentenceDto;
  numberedEvidence: NumberedEvidence;
  t: Messages["discovery"];
}) {
  const cited = sentence.evidenceIds.flatMap((id) => {
    const numbered = numberedEvidence.get(id);
    return numbered ? [numbered] : [];
  });
  return (
    <>
      <span>{sentence.text}</span>
      {cited.length ? (
        <span className="ml-1 inline-flex flex-wrap items-baseline gap-1">
          {cited.map(({ item, number }) => (
            <a
              key={item.id}
              className="text-xs font-bold text-accent-strong underline"
              href={item.sourceUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={t.proposal.citationLabel(number, item.title)}
            >
              [{number}]
            </a>
          ))}
          {cited.some(({ item }) => item.isStale)
            ? <span className="text-xs font-bold text-destructive">{t.proposal.staleEvidence}</span>
            : null}
        </span>
      ) : <span className="ml-2 text-xs text-muted-foreground">{t.proposal.inference}</span>}
    </>
  );
}

function ClaimSentenceList({
  sentences,
  numberedEvidence,
  t,
  startAt = 0,
}: {
  sentences: DiscoveryClaimSentenceDto[];
  numberedEvidence: NumberedEvidence;
  t: Messages["discovery"];
  startAt?: number;
}) {
  return (
    <ul className="grid list-disc gap-2 pl-5 text-sm">
      {sentences.map((sentence, sentenceIndex) => sentenceIndex < startAt ? null : (
        <li key={`${sentenceIndex}:${sentence.text}`}>
          <ClaimSentence sentence={sentence} numberedEvidence={numberedEvidence} t={t} />
        </li>
      ))}
    </ul>
  );
}


interface QuestionDraft {
  answer: string;
  skipped: boolean;
}

interface FeedbackEditDraft {
  interests: string;
  exclusions: string;
  pace: string;
  budget: string;
  summary: string;
}

function resolvedQuestionAnswers(drafts: Record<string, QuestionDraft>): DiscoveryQuestionAnswerDto[] {
  return Object.entries(drafts).flatMap(([question, draft]): DiscoveryQuestionAnswerDto[] => {
    if (draft.skipped) return [{ question, answer: null }];
    const answer = draft.answer.trim();
    return answer ? [{ question, answer }] : [];
  });
}


export function DiscoveryWorkspace({ trip, request, placesRevision, onPlacesChanged }: DiscoveryWorkspaceProps) {
  const { locale, t: { discovery: t, tripPlaces: tripPlacesT } } = useI18n();
  const [workspace, setWorkspace] = useState<DiscoveryWorkspaceDto | null>(null);
  const [briefDraft, setBriefDraft] = useState("");
  const [feedbackDraft, setFeedbackDraft] = useState("");
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, QuestionDraft>>({});
  const [editingFeedbackId, setEditingFeedbackId] = useState<string | null>(null);
  const [feedbackEditDraft, setFeedbackEditDraft] = useState<FeedbackEditDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ area: NoticeArea; text: string } | null>(null);
  const [expandedProposals, setExpandedProposals] = useState<Record<string, boolean>>({});
  const retryKeys = useRef<RetryKeys>(new Map());
  const briefBase = useRef<DiscoveryWorkspaceDto["brief"]>(null);
  const answersBase = useRef<DiscoveryWorkspaceDto["brief"]>(null);
  const feedbackBase = useRef<DiscoveryFeedbackDto | null>(null);
  const conflictLatest = useRef<DiscoveryWorkspaceDto | null>(null);
  const resolution = useVersionConflict<Record<string, unknown>>();
  const conflictAction = useRef<{ operation: string; path: string; payload: Record<string, unknown>; area: NoticeArea; after?: () => void; method?: "POST" | "PUT" } | null>(null);
  const researchLabel = (idle: string) =>
    pending === "save-brief" || pending === "save-questions"
      ? t.progress.saving
      : pending === "generate" ? t.progress.researching : idle;
  const apply = useCallback((value: unknown, inputs: "all" | "brief" | "questions" | "none" = "all") => {
    const next = parseDiscoveryWorkspaceResponse(value).discovery;
    setWorkspace(next);
    if (inputs === "all" || inputs === "brief") {
      briefBase.current = next.brief;
      setBriefDraft(next.brief?.originalText ?? "");
    }
    if (inputs === "all" || inputs === "questions") {
      answersBase.current = next.brief;
      const savedAnswers = Object.fromEntries(
        (next.brief?.questionAnswers ?? []).map((entry) => [entry.question, entry.answer]),
      );
      const questions = [
        ...(next.brief?.questionAnswers.map((entry) => entry.question) ?? []),
        ...(next.brief?.unresolvedQuestions ?? []),
      ].filter((question, index, all) => all.indexOf(question) === index);
      setQuestionDrafts(Object.fromEntries(questions.map((question) => [
        question,
        {
          answer: typeof savedAnswers[question] === "string" ? savedAnswers[question] : "",
          skipped: savedAnswers[question] === null,
        },
      ])));
    }
    return next;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      apply(await request(`/api/trips/${trip.id}/discovery`));
      setNotice(null);
    } catch (error) {
      setNotice({ area: "general", text: errorMessage(error, t.errors.failed) });
    } finally {
      setLoading(false);
    }
  }, [apply, request, t.errors.failed, trip.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Wishlist and member changes made in other tabs only refresh the projection; unsaved brief
  // and question drafts typed here must survive them.
  const refreshSignal = `${placesRevision}:${trip.members.length}`;
  const lastRefreshSignal = useRef(refreshSignal);
  useEffect(() => {
    if (lastRefreshSignal.current === refreshSignal) return;
    lastRefreshSignal.current = refreshSignal;
    void request(`/api/trips/${trip.id}/discovery`)
      .then((value) => setWorkspace(parseDiscoveryWorkspaceResponse(value).discovery))
      .catch((error: unknown) => setNotice({ area: "general", text: errorMessage(error, t.errors.failed) }));
  }, [refreshSignal, request, t.errors.failed, trip.id]);

  async function mutate(
    operation: string,
    path: string,
    payload: Record<string, unknown>,
    area: NoticeArea,
    after?: () => void,
    method?: "POST" | "PUT",
    conflictBase = operation === conflictAction.current?.operation ? resolution.conflictBaseVersion : undefined,
  ) {
    if (pending) return;
    setPending(operation);
    setNotice(null);
    const submittedFeedbackId = operation.startsWith("feedback-confirm:") ? operation.slice("feedback-confirm:".length) : null;
    const submittedFeedback = feedbackBase.current?.id === submittedFeedbackId ? feedbackBase.current : null;
    try {
      const next = apply(await request(path, {
        method: method ?? (operation === "save-brief" || operation === "save-questions" ? "PUT" : "POST"),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": retryKey(retryKeys.current, operation, payload),
          ...(conflictBase ? { "Conflict-Base-Version": String(conflictBase) } : {}),
        },
        body: JSON.stringify(payload),
      }), operation === "save-questions" ? "questions" : operation.startsWith("feedback-") ? "none" : "all");
      clearRetryKey(retryKeys.current, operation);
      resolution.clear();
      after?.();
      return next;
    } catch (error) {
      if (operation === "save-brief" || operation === "save-questions" || operation.startsWith("feedback-confirm:")) {
        const { expectedVersion, ...attempted } = payload;
        // Comparing the AI interpretation must not turn an unedited confirmation into a correction.
        const comparison = submittedFeedback ? { interpretation: submittedFeedback.interpretation, ...attempted } : attempted;
        const base = operation === "save-brief"
          ? { originalText: briefBase.current?.originalText ?? "" }
          : operation === "save-questions" ? { answers: answersBase.current?.questionAnswers ?? [] }
          : { decision: "confirm", interpretation: submittedFeedback?.interpretation };
        try {
          const captured = await resolution.capture(error, { input: base, version: typeof expectedVersion === "number" ? expectedVersion : 1 }, comparison, async () => {
            const latest = parseDiscoveryWorkspaceResponse(await request(`/api/trips/${trip.id}/discovery`)).discovery;
            conflictLatest.current = latest;
            if (operation === "save-brief" || operation === "save-questions") return latest.brief ? {
              input: operation === "save-brief" ? { originalText: latest.brief.originalText } : { answers: latest.brief.questionAnswers },
              version: latest.brief.version,
            } : null;
            const feedback = latest.feedback.find((entry) => entry.id === submittedFeedbackId);
            return feedback ? { input: { decision: "confirm", interpretation: feedback.interpretation }, version: feedback.version } : null;
          });
          if (captured) { conflictAction.current = { operation, path, payload, area, after, method }; return; }
        } catch (failure) { setNotice({ area, text: errorMessage(failure, t.errors.failed) }); return; }
      }
      if (shouldStartFreshRequest(error)) clearRetryKey(retryKeys.current, operation);
      setNotice({ area, text: errorMessage(error, t.errors.failed) });
    } finally {
      setPending(null);
    }
  }

  // One action: explain missing server configuration, persist changed brief text or
  // clarification answers, then research the exact resulting brief version.
  async function research(area: "find" | "again") {
    if (pending || !workspace) return;
    const missing = missingServices(workspace, true, t);
    if (missing.length > 0) {
      setNotice({
        area,
        text: t.errors.researchUnavailable(missing.join(t.services.separator)),
      });
      return;
    }
    // Generation uses the saved aggregate; each editable field keeps its own base.
    let brief = workspace.brief;
    if (!brief || !briefBase.current || briefBase.current.originalText !== briefDraft) {
      const saved = await mutate("save-brief", `/api/trips/${trip.id}/discovery/brief`, {
        originalText: briefDraft,
        expectedVersion: briefBase.current?.version ?? null,
      }, area);
      if (!saved?.brief) return;
      brief = saved.brief;
    } else {
      const answers = resolvedQuestionAnswers(questionDrafts);
      if (answersBase.current && JSON.stringify(answers) !== JSON.stringify(answersBase.current.questionAnswers)) {
        const saved = await mutate(
          "save-questions",
          `/api/trips/${trip.id}/discovery/brief/questions`,
          { expectedVersion: answersBase.current.version, answers },
          area,
        );
        if (!saved?.brief) return;
        brief = saved.brief;
      }
    }
    await mutate("generate", `/api/trips/${trip.id}/discovery/generate`, {
      expectedBriefVersion: brief.version,
    }, area);
  }

  async function decideProposal(proposal: CandidateProposalDto, decision: "accept" | "reject") {
    await mutate(
      `${decision}:${proposal.id}`,
      `/api/trips/${trip.id}/discovery/proposals/${proposal.id}/${decision}`,
      { expectedVersion: proposal.version },
      "general",
      decision === "accept" ? onPlacesChanged : undefined,
    );
  }
  async function setProposalVote(proposal: CandidateProposalDto, voted: boolean) {
    await mutate(
      `vote:${proposal.id}`,
      `/api/trips/${trip.id}/discovery/proposals/${proposal.id}/vote`,
      { voted },
      "general",
      undefined,
      "PUT",
    );
  }

  async function removeAcceptedProposal(proposal: CandidateProposalDto) {
    if (pending || !proposal.acceptedTripPlaceId) return;
    if (!window.confirm(tripPlacesT.workspace.confirmRemove(proposal.name))) return;
    const operation = `remove-accepted:${proposal.id}`;
    setPending(operation);
    setNotice(null);
    try {
      const tripPlaces = parseTripPlaceListResponse(
        await request<unknown>(`/api/trips/${trip.id}/trip-places`),
      ).tripPlaces;
      const acceptedPlace = tripPlaces.find((place) => place.id === proposal.acceptedTripPlaceId);
      if (acceptedPlace) {
        const payload = { expectedVersion: acceptedPlace.version };
        await request(`/api/trips/${trip.id}/trip-places/${acceptedPlace.id}/remove`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": retryKey(retryKeys.current, operation, payload),
          },
          body: JSON.stringify(payload),
        });
        clearRetryKey(retryKeys.current, operation);
      }
      const refreshed = parseDiscoveryWorkspaceResponse(
        await request(`/api/trips/${trip.id}/discovery`),
      ).discovery;
      setWorkspace(refreshed);
      onPlacesChanged();
    } catch (error) {
      setNotice({ area: "general", text: errorMessage(error, t.errors.failed) });
    } finally {
      setPending(null);
    }
  }

  function proposalActions(proposal: CandidateProposalDto) {
    if (proposal.status === "pending") {
      return (
        <div className="flex flex-wrap gap-2 xl:flex-nowrap">
          <button className="flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3 font-bold text-ink-strong" disabled={pending !== null} onClick={() => void decideProposal(proposal, "accept")}><Check aria-hidden="true" className="size-4" />{t.proposal.accept}</button>
          <button className="flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg border px-3 font-bold" disabled={pending !== null} onClick={() => void decideProposal(proposal, "reject")}><X aria-hidden="true" className="size-4" />{t.proposal.decline}</button>
        </div>
      );
    }
    if (proposal.status === "accepted") {
      return (
        <div className="flex flex-wrap items-center gap-2 xl:flex-nowrap">
          <span className="whitespace-nowrap font-bold">{t.status.accepted}</span>
          {proposal.acceptedTripPlaceId ? <button className="min-h-11 whitespace-nowrap rounded-lg border px-3 font-bold" disabled={pending !== null} onClick={() => void removeAcceptedProposal(proposal)}>{tripPlacesT.workspace.remove}</button> : null}
        </div>
      );
    }
    return <span className="font-bold">{t.status[proposal.status]}</span>;
  }


  async function createFeedback() {
    const text = feedbackDraft.trim();
    if (!text || pending || !workspace) return;
    const missing = missingServices(workspace, false, t);
    const area: NoticeArea = "feedback";
    if (missing.length > 0) {
      setNotice({
        area,
        text: t.errors.feedbackUnavailable(missing.join(t.services.separator)),
      });
      return;
    }
    const operation = "feedback:overall";
    await mutate(operation, `/api/trips/${trip.id}/discovery/feedback`, {
      originalText: text,
    }, area, () => {
      setFeedbackDraft("");
    });
  }

  function editFeedback(feedback: DiscoveryFeedbackDto) {
    feedbackBase.current = feedback;
    setEditingFeedbackId(feedback.id);
    setFeedbackEditDraft({
      interests: feedback.interpretation.interests.join("\n"),
      exclusions: feedback.interpretation.exclusions.join("\n"),
      pace: feedback.interpretation.pace ?? "",
      budget: feedback.interpretation.budget ?? "",
      summary: feedback.interpretation.summary,
    });
  }

  async function decideFeedback(feedback: DiscoveryFeedbackDto, decision: "confirm" | "reject") {
    const edited = editingFeedbackId === feedback.id ? feedbackEditDraft : null;
    if (editingFeedbackId !== feedback.id) feedbackBase.current = feedback;
    await mutate(
      `feedback-${decision}:${feedback.id}`,
      `/api/trips/${trip.id}/discovery/feedback/${feedback.id}/decision`,
      {
        expectedVersion: editingFeedbackId === feedback.id ? feedbackBase.current?.version ?? feedback.version : feedback.version,
        decision,
        ...(decision === "confirm" && edited ? {
          interpretation: {
            interests: edited.interests.split("\n").map((entry) => entry.trim()).filter(Boolean),
            exclusions: edited.exclusions.split("\n").map((entry) => entry.trim()).filter(Boolean),
            pace: edited.pace.trim() || null,
            budget: edited.budget.trim() || null,
            summary: edited.summary,
          },
        } : {}),
      },
      "general",
      () => {
        setEditingFeedbackId(null);
        setFeedbackEditDraft(null);
      },
    );
  }

  async function saveQuestionAnswers() {
    if (!answersBase.current) return;
    const answers = resolvedQuestionAnswers(questionDrafts);
    await mutate(
      "save-questions",
      `/api/trips/${trip.id}/discovery/brief/questions`,
      { expectedVersion: answersBase.current.version, answers },
      "questions",
    );
  }
  const showProposalVotes = workspace?.proposals.some(
    (proposal) => proposal.status === "pending" && proposal.votingAvailable,
  ) ?? false;

  return (
    <section className="rounded-card border border-ink/10 bg-surface p-5 shadow-card sm:p-8" aria-labelledby="ai-discovery-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-accent-strong"><Bot aria-hidden="true" className="size-4" />{t.header.eyebrow}</p>
          <h2 id="ai-discovery-heading" className="font-display text-3xl text-ink-strong sm:text-4xl">{t.header.title}</h2>
          <p className="mt-2 max-w-3xl text-muted-foreground">{t.header.description}</p>
        </div>
        {workspace?.latestRun ? <button className="flex min-h-11 items-center gap-2 rounded-xl border px-4 font-bold" disabled={pending !== null || Boolean(resolution.conflict)} onClick={() => void research("again")}><RefreshCw aria-hidden="true" className="size-4" />{researchLabel(t.header.researchAgain)}</button> : null}
      </div>
      {resolution.conflict ? <ConflictPanel conflict={resolution.conflict} busy={pending !== null}
        onAccept={() => {
          const operation = conflictAction.current?.operation;
          if (conflictLatest.current) apply({ discovery: conflictLatest.current },
            operation === "save-brief" ? "brief" : operation === "save-questions" ? "questions" : "none");
          if (operation === `feedback-confirm:${editingFeedbackId}`) {
            setEditingFeedbackId(null); setFeedbackEditDraft(null);
          }
          resolution.clear();
        }}
        onReapply={() => {
          const action = conflictAction.current!;
          void mutate(action.operation, action.path, { ...action.payload, expectedVersion: resolution.conflict!.current!.version },
            action.area, action.after, action.method, resolution.conflict!.base.version);
        }}
        onEdit={() => {
          const operation = conflictAction.current?.operation;
          if (operation === "save-brief") briefBase.current = conflictLatest.current?.brief ?? null;
          else if (operation === "save-questions") answersBase.current = conflictLatest.current?.brief ?? null;
          else if (operation?.startsWith("feedback-confirm:")) {
            feedbackBase.current = conflictLatest.current?.feedback.find((entry) => entry.id === operation.slice("feedback-confirm:".length)) ?? null;
          }
          resolution.resume();
        }}
      /> : null}
      {resolution.conflict && notice && notice.area !== "again" && notice.area !== "general" ? <p className="mt-4 rounded-xl border border-accent-strong/30 bg-surface-subtle p-4 text-accent-strong" role="alert">{notice.text}</p> : null}

      {notice?.area === "again" ? <p className="mt-4 rounded-xl border border-accent-strong/30 bg-surface-subtle p-4 text-accent-strong" role="alert">{notice.text}</p> : null}
      {notice?.area === "general" ? <p className="mt-4 rounded-xl border border-accent-strong/30 bg-surface-subtle p-4 text-accent-strong" role="alert">{notice.text}</p> : null}
      {loading ? <p className="mt-6" role="status">{t.header.loading}</p> : null}

      {!loading ? (
        <div hidden={Boolean(resolution.conflict)} className="mt-6 grid gap-5">
          <section className="rounded-panel bg-surface-subtle p-4 sm:p-5" aria-label={t.brief.areaLabel}>
            <label className="grid gap-2 font-bold">{t.brief.prompt}
              <textarea
                className="min-h-32 rounded-xl border bg-surface p-3 font-normal"
                value={briefDraft}
                onChange={(event) => setBriefDraft(event.target.value)}
                placeholder={t.brief.placeholder}
              />
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="flex min-h-11 items-center gap-2 rounded-xl bg-accent px-4 font-bold text-ink-strong" disabled={pending !== null || !briefDraft.trim()} onClick={() => void research("find")}><Search aria-hidden="true" className="size-4" />{researchLabel(t.brief.findCandidates)}</button>
            </div>
            {notice?.area === "find" ? <p className="mt-3 rounded-xl border border-accent-strong/30 bg-surface p-4 text-accent-strong" role="alert">{notice.text}</p> : null}
            {!workspace?.modelAvailable ? <p className="mt-3 text-sm text-muted-foreground">{t.brief.modelUnavailable}</p> : null}
            {!workspace?.placeProviderAvailable ? <p className="mt-2 text-sm text-muted-foreground">{t.brief.placesUnavailable}</p> : null}
          </section>

          {workspace?.brief?.structured ? (
            <section className="rounded-panel border border-ink/10 p-4" aria-label={t.brief.interpretationLabel}>
              <h3 className="font-display text-2xl">{t.brief.understood}</h3>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                <div><dt className="font-bold">{t.brief.interests}</dt><dd>{workspace.brief.structured.interests.join("、") || t.brief.unknown}</dd></div>
                <div><dt className="font-bold">{t.brief.areas}</dt><dd>{workspace.brief.structured.areas.join("、") || t.brief.unknown}</dd></div>
                <div><dt className="font-bold">{t.brief.pace}</dt><dd>{workspace.brief.structured.pace ?? t.brief.unknown}</dd></div>
                <div><dt className="font-bold">{t.brief.budget}</dt><dd>{workspace.brief.structured.budget ?? t.brief.unknown}</dd></div>
                <div className="sm:col-span-2"><dt className="font-bold">{t.brief.avoid}</dt><dd>{workspace.brief.structured.exclusions.join("、") || t.brief.nothingConfirmed}</dd></div>
              </dl>
              {Object.keys(questionDrafts).length ? (
                <div className="mt-4">
                  <strong>{t.brief.questions}</strong>
                  <ul className="mt-2 grid gap-3">
                    {Object.entries(questionDrafts).map(([question, draft]) => (
                      <li key={question} className="rounded-xl bg-surface-subtle p-3">
                        <label className="grid gap-2 font-bold">
                          {question}
                          <input
                            className="min-h-10 rounded-lg border bg-surface px-3 font-normal"
                            value={draft.answer}
                            disabled={draft.skipped}
                            onChange={(event) => setQuestionDrafts((drafts) => ({
                              ...drafts,
                              [question]: { answer: event.target.value, skipped: false },
                            }))}
                            placeholder={t.brief.answerPlaceholder}
                          />
                        </label>
                        <button
                          className="mt-2 min-h-10 rounded-lg border px-3 font-bold"
                          type="button"
                          onClick={() => setQuestionDrafts((drafts) => ({
                            ...drafts,
                            [question]: { answer: "", skipped: !draft.skipped },
                          }))}
                        >
                          {draft.skipped ? t.brief.answerInstead : t.brief.skipQuestion}
                        </button>
                        {draft.skipped ? <span className="ml-2 text-sm font-bold text-muted-foreground">{t.brief.skippedUnknown}</span> : null}
                      </li>
                    ))}
                  </ul>
                  <button
                    className="mt-3 min-h-11 rounded-xl border px-4 font-bold"
                    disabled={pending !== null || !Object.values(questionDrafts).some((draft) => draft.skipped || draft.answer.trim())}
                    onClick={() => void saveQuestionAnswers()}
                  >
                    {pending === "save-questions" ? t.progress.saving : t.brief.saveAnswers}
                  </button>
                  {notice?.area === "questions" ? <p className="mt-3 rounded-xl border border-accent-strong/30 bg-surface-subtle p-4 text-accent-strong" role="alert">{notice.text}</p> : null}
                </div>
              ) : null}
            </section>
          ) : null}

          {workspace?.latestRun ? (
            <section className="rounded-panel border border-ink/10 p-4" aria-label={t.searchPlan.areaLabel}>
              <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-display text-2xl">{t.searchPlan.title}</h3><span className="text-sm text-muted-foreground">{workspace.latestRun.modelId}・{new Date(workspace.latestRun.generatedAt).toLocaleString(locale)}</span></div>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                {workspace.latestRun.searchPlan.categories.length ? <div><dt className="font-bold">{t.searchPlan.recommending}</dt><dd>{workspace.latestRun.searchPlan.categories.join("、")}{workspace.latestRun.searchPlan.defaultCategories ? <span className="block text-sm text-muted-foreground">{t.searchPlan.defaultExplanation}</span> : null}</dd></div> : null}
                {workspace.latestRun.searchPlan.namedPlaces.length ? <div><dt className="font-bold">{t.searchPlan.namedPlaces}</dt><dd>{workspace.latestRun.searchPlan.namedPlaces.join("、")}</dd></div> : null}
                {workspace.latestRun.searchPlan.alreadyArranged.length ? <div><dt className="font-bold">{t.searchPlan.alreadyArranged}</dt><dd>{workspace.latestRun.searchPlan.alreadyArranged.join("、")}</dd></div> : null}
              </dl>
              {workspace.latestRun.searchPlan.queries.length ? <details className="mt-3"><summary className="cursor-pointer font-bold">{t.searchPlan.checkedOnGoogleMaps(workspace.latestRun.searchPlan.queries.length)}</summary><ul className="mt-2 grid gap-2 sm:grid-cols-2">{workspace.latestRun.searchPlan.queries.map((query, index) => <li key={`${index}:${query}`} className="rounded-lg bg-surface-subtle p-3">{query}</li>)}</ul></details> : null}
            </section>
          ) : null}

          {workspace?.proposals.length ? (
            <section aria-label={t.proposal.shortlistLabel}>
              <h3 className="font-display text-3xl">{t.proposal.shortlistTitle}</h3>
              <div className="mt-4 overflow-hidden rounded-panel border border-ink/10">
                <table className="block w-full border-separate border-spacing-0 text-left xl:table" aria-label={t.proposal.shortlistLabel}>
                  <thead className="table w-full table-fixed bg-surface-subtle text-sm xl:table-header-group">
                    <tr>
                      <th className="px-3 py-3 font-bold xl:min-w-64 xl:px-4" scope="col">{t.proposal.columns.place}</th>
                      <th className="hidden w-36 px-3 py-3 font-bold xl:table-cell" scope="col">{t.proposal.columns.category}</th>
                      {showProposalVotes ? <th className="w-0 p-0 xl:w-40 xl:px-3 xl:py-3" scope="col"><span className="sr-only xl:not-sr-only">{t.proposal.columns.votes}</span></th> : null}
                      <th className="w-0 p-0 xl:w-80 xl:px-3 xl:py-3" scope="col"><span className="sr-only xl:not-sr-only">{t.proposal.columns.actions}</span></th>
                      <th className="w-20 px-2 py-3 font-bold xl:w-24 xl:px-3" scope="col"><span className="sr-only">{t.proposal.columns.more}</span></th>
                    </tr>
                  </thead>
                  {workspace.proposals.map((proposal) => {
                    const expanded = expandedProposals[proposal.id] ?? false;
                    const detailsId = `discovery-proposal-${proposal.id}-details`;
                    const category = proposal.category ?? t.placeType[proposal.type];
                    const firstSentence = proposal.recommendationSentences?.[0];
                    const firstTradeoff = proposal.tradeoffSentences !== null
                      ? proposal.tradeoffSentences[0]?.text ?? null
                      : proposal.tradeoffs[0] ?? null;
                    const hasTradeoffs = proposal.tradeoffSentences !== null
                      ? proposal.tradeoffSentences.length > 0
                      : proposal.tradeoffs.length > 0;
                    const numberedEvidence = new Map(
                      proposal.evidence.map((item, index) => [item.id, { item, number: index + 1 }] as const),
                    );
                    return (
                      <tbody key={proposal.id} data-discovery-proposal={proposal.name} className="block w-full xl:table-row-group">
                        <tr aria-label={t.proposal.ariaLabel(proposal.name)} className="grid w-full grid-cols-[minmax(0,1fr)_5rem] bg-surface-subtle xl:table-row">
                          <th className="col-span-2 col-start-1 row-start-1 py-3 pl-3 pr-24 align-top xl:table-cell xl:min-w-64 xl:px-4 xl:py-4" scope="row">
                            <span className="text-xl font-semibold text-ink-strong">{proposal.name}</span>
                            {firstSentence ? (
                              <p className="mt-1 text-sm font-semibold"><ClaimSentence sentence={firstSentence} numberedEvidence={numberedEvidence} t={t} /></p>
                            ) : proposal.recommendationSentences === null ? (
                              <p className="mt-1 line-clamp-2 text-sm font-semibold text-muted-foreground">{proposal.recommendation}</p>
                            ) : null}
                            <p className="mt-1 line-clamp-1 text-sm font-normal text-muted-foreground xl:hidden">{t.proposal.rowSummary(category, firstTradeoff)}</p>
                          </th>
                          <td className="hidden px-3 py-4 align-top xl:table-cell">{category}</td>
                          {showProposalVotes ? (
                            <td className={`col-span-2 col-start-1 row-start-2 align-top xl:table-cell xl:px-3 xl:py-3 ${proposal.status === "pending" && proposal.votingAvailable ? "px-3 pb-3" : "p-0 xl:p-3"}`}>
                              {proposal.status === "pending" && proposal.votingAvailable ? (
                                <VoteControl compact name={proposal.name} voters={proposal.voters} voteCount={proposal.voteCount} ownVote={proposal.ownVote} votingAvailable disabled={pending !== null} onChange={(voted) => void setProposalVote(proposal, voted)} />
                              ) : null}
                            </td>
                          ) : null}
                          <td className={`col-span-2 col-start-1 px-3 pb-3 align-top xl:table-cell xl:px-3 xl:py-3 ${showProposalVotes ? "row-start-3" : "row-start-2"}`}>{proposalActions(proposal)}</td>
                          <td className="col-start-2 row-span-3 row-start-1 px-2 py-2 align-top xl:table-cell xl:px-3">
                            <button
                              type="button"
                              className="min-h-11 whitespace-nowrap rounded-lg border bg-surface px-3 font-bold"
                              aria-expanded={expanded}
                              aria-controls={detailsId}
                              onClick={() => setExpandedProposals((current) => ({ ...current, [proposal.id]: !expanded }))}
                            >
                              {t.proposal.columns.more}
                            </button>
                          </td>
                        </tr>
                        <tr id={detailsId} hidden={!expanded} className="block w-full bg-surface xl:table-row">
                          <td className="block w-full border-t border-ink/10 p-4 xl:table-cell xl:p-5" colSpan={showProposalVotes ? 5 : 4}>
                            <div className="grid gap-4">
                              <p className="text-sm text-muted-foreground">{proposal.address ?? t.proposal.unknownAddress}</p>
                              {proposal.endorsements.length ? <div aria-label={t.proposal.recommendedByFor(proposal.name)}><strong>{t.proposal.recommendedBy}</strong><ul className="mt-1 flex flex-wrap gap-2">{proposal.endorsements.map((endorsement) => <li key={endorsement} className="rounded-full border bg-surface px-3 py-1 text-sm font-bold">{endorsementLabel(endorsement, t)}</li>)}</ul></div> : null}
                              {proposal.recommendationSentences === null ? <p>{proposal.recommendation}</p> : null}
                              {proposal.recommendationSentences && proposal.recommendationSentences.length > 1
                                ? <ClaimSentenceList sentences={proposal.recommendationSentences} numberedEvidence={numberedEvidence} t={t} startAt={1} />
                                : null}
                              {proposal.status === "pending" && proposal.votingAvailable ? <VoteVoters voters={proposal.voters} /> : null}
                              <a className="inline-flex min-h-11 w-fit items-center gap-2 rounded-lg border bg-surface px-3 font-bold" href={googleMapsPlaceUrl(proposal.name, proposal.providerPlaceId)} target="_blank" rel="noreferrer"><Images aria-hidden="true" className="size-4" />{t.proposal.viewPhotos}</a>
                              {proposal.matchedNeeds.length || hasTradeoffs || proposal.unknowns.length ? (
                                <div className="grid gap-3 sm:grid-cols-3">
                                  {proposal.matchedNeeds.length ? <div><strong>{t.proposal.matches}</strong><ul className="mt-1 list-disc pl-5 text-sm">{proposal.matchedNeeds.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
                                  {hasTradeoffs ? (
                                    <div>
                                      <strong>{t.proposal.tradeoffs}</strong>
                                      {proposal.tradeoffSentences !== null
                                        ? <ClaimSentenceList sentences={proposal.tradeoffSentences} numberedEvidence={numberedEvidence} t={t} />
                                        : <ul className="mt-1 list-disc pl-5 text-sm">{proposal.tradeoffs.map((item) => <li key={item}>{item}</li>)}</ul>}
                                    </div>
                                  ) : null}
                                  {proposal.unknowns.length ? <div><strong>{t.proposal.unknowns}</strong><ul className="mt-1 list-disc pl-5 text-sm">{proposal.unknowns.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
                                </div>
                              ) : null}
                              <div>
                                <strong>{t.proposal.evidence}</strong>
                                <ul className="mt-1 grid gap-1">
                                  {proposal.evidence.map((item, evidenceIndex) => {
                                    const number = evidenceIndex + 1;
                                    return (
                                      <li key={item.id}>
                                        <a
                                          className="inline-flex items-center gap-1 break-all font-bold text-accent-strong underline"
                                          href={item.sourceUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                          aria-label={t.proposal.citationLabel(number, item.title)}
                                        >
                                          [{number}] {item.title}<ExternalLink aria-hidden="true" className="size-3" />
                                        </a>
                                        <span className="ml-2 text-xs text-muted-foreground">{item.attribution}・{t.proposal.observedAt(new Date(item.observedAt).toLocaleString(locale))}</span>
                                        {item.isStale ? <span className="ml-2 text-xs font-bold text-destructive">{t.proposal.staleEvidence}</span> : null}
                                      </li>
                                    );
                                  })}
                                </ul>
                              </div>
                            </div>
                          </td>
                        </tr>
                      </tbody>
                    );
                  })}
                </table>
              </div>
            </section>
          ) : workspace?.latestRun ? <p className="rounded-panel border border-dashed p-5 text-center text-muted-foreground">{workspace.latestRun.shortfalls.length ? t.proposal.noneNew : t.proposal.nonePassed}</p> : null}

          {workspace?.decided.length ? (
            <section className="rounded-panel border border-ink/10 p-4" aria-label={t.decided.areaLabel}>
              <h3 className="font-display text-2xl">{t.decided.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t.decided.description}</p>
              <ul className="mt-3 grid gap-2">{workspace.decided.map((decision) => <li key={decision.proposalId} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-surface-subtle p-3"><strong>{decision.name}</strong><span className="text-sm">{decision.status === "accepted" ? t.decided.accepted : t.decided.rejected}・{t.decided.decidedAt(new Date(decision.decidedAt).toLocaleDateString(locale))}</span></li>)}</ul>
            </section>
          ) : null}

          {workspace?.latestRun?.shortfalls.length ? (
            <section className="rounded-panel border border-ink/10 p-4" aria-label={t.missing.areaLabel}>
              <h3 className="font-display text-2xl">{t.missing.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t.missing.description}</p>
              <ul className="mt-3 grid gap-2">{workspace.latestRun.shortfalls.map((shortfall) => <li key={`${shortfall.code}:${shortfall.subject}`} className="rounded-lg bg-surface-subtle p-3"><strong>{shortfall.subject}</strong>{shortfall.named ? <span className="ml-2 text-xs font-bold uppercase tracking-[0.12em] text-accent-strong">{t.missing.requested}</span> : null}<span className="block text-sm">{shortfallText(shortfall, t)}</span></li>)}</ul>
            </section>
          ) : null}

          <section className="rounded-panel bg-surface-subtle p-4" aria-label={t.feedback.areaLabel}>
            <h3 className="font-display text-2xl">{t.feedback.title}</h3>
            <label className="mt-3 grid gap-2 font-bold">{t.feedback.label}<textarea className="min-h-24 rounded-xl border bg-surface p-3 font-normal" value={feedbackDraft} onChange={(event) => setFeedbackDraft(event.target.value)} placeholder={t.feedback.placeholder} /></label>
            <button className="mt-3 min-h-11 rounded-xl border px-4 font-bold" disabled={pending !== null || !feedbackDraft.trim()} onClick={() => void createFeedback()}>{pending === "feedback:overall" ? t.feedback.interpreting : t.feedback.interpret}</button>
            {notice?.area === "feedback" ? <p className="mt-3 rounded-xl border border-accent-strong/30 bg-surface p-4 text-accent-strong" role="alert">{notice.text}</p> : null}
            <div className="mt-4 grid gap-3">
              {workspace?.feedback.map((feedback) => {
                const edit = feedback.status === "pending" && feedback.isOwn && editingFeedbackId === feedback.id
                  ? feedbackEditDraft
                  : null;
                return (
                  <article key={feedback.id} className="rounded-xl bg-surface p-3">
                    {feedback.proposalName ? <p className="text-sm font-bold text-accent-strong">{t.feedback.target(feedback.proposalName)}</p> : <p className="text-sm font-bold text-muted-foreground">{t.feedback.overallTarget}</p>}
                    <p className="whitespace-pre-wrap">「{feedback.originalText}」</p>
                    {edit ? (
                      <div className="mt-3 grid gap-3 rounded-xl border p-3">
                        <label className="grid gap-1 font-bold">{t.feedback.summary}<textarea className="min-h-20 rounded-lg border p-2 font-normal" value={edit.summary} onChange={(event) => setFeedbackEditDraft({ ...edit, summary: event.target.value })} /></label>
                        <label className="grid gap-1 font-bold">{t.feedback.interests}<textarea className="min-h-20 rounded-lg border p-2 font-normal" value={edit.interests} onChange={(event) => setFeedbackEditDraft({ ...edit, interests: event.target.value })} placeholder={t.feedback.onePerLine} /></label>
                        <label className="grid gap-1 font-bold">{t.feedback.avoid}<textarea className="min-h-20 rounded-lg border p-2 font-normal" value={edit.exclusions} onChange={(event) => setFeedbackEditDraft({ ...edit, exclusions: event.target.value })} placeholder={t.feedback.onePerLine} /></label>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className="grid gap-1 font-bold">{t.feedback.pace}<input className="min-h-10 rounded-lg border px-2 font-normal" value={edit.pace} onChange={(event) => setFeedbackEditDraft({ ...edit, pace: event.target.value })} /></label>
                          <label className="grid gap-1 font-bold">{t.feedback.budget}<input className="min-h-10 rounded-lg border px-2 font-normal" value={edit.budget} onChange={(event) => setFeedbackEditDraft({ ...edit, budget: event.target.value })} /></label>
                        </div>
                      </div>
                    ) : (
                      <>
                        <p className="mt-2"><strong>{t.feedback.interpretation}</strong> {feedback.interpretation.summary}{feedback.interpretationEdited ? <span className="ml-2 rounded-full border px-2 py-1 text-xs font-bold">{t.feedback.edited}</span> : null}</p>
                        <p className="mt-1 text-sm text-muted-foreground">{t.feedback.interests}：{feedback.interpretation.interests.join("、") || t.feedback.none}・{t.feedback.avoid}：{feedback.interpretation.exclusions.join("、") || t.feedback.none}・{t.feedback.pace}：{feedback.interpretation.pace ?? t.feedback.unchanged}・{t.feedback.budget}：{feedback.interpretation.budget ?? t.feedback.unchanged}</p>
                      </>
                    )}
                    {feedback.status === "pending" && feedback.isOwn ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button className="min-h-10 rounded-lg bg-accent px-3 font-bold" disabled={pending !== null || Boolean(edit && !edit.summary.trim())} onClick={() => void decideFeedback(feedback, "confirm")}>{edit ? t.feedback.confirmEdited : t.feedback.confirm}</button>
                        {edit
                          ? <button className="min-h-10 rounded-lg border px-3 font-bold" disabled={pending !== null} onClick={() => { setEditingFeedbackId(null); setFeedbackEditDraft(null); }}>{t.feedback.cancelEdit}</button>
                          : <button className="min-h-10 rounded-lg border px-3 font-bold" disabled={pending !== null} onClick={() => editFeedback(feedback)}>{t.feedback.edit}</button>}
                        <button className="min-h-10 rounded-lg border px-3 font-bold" disabled={pending !== null} onClick={() => void decideFeedback(feedback, "reject")}>{t.feedback.reject}</button>
                      </div>
                    ) : <span className="mt-2 inline-block text-sm font-bold">{t.feedbackStatus[feedback.status]}</span>}
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
