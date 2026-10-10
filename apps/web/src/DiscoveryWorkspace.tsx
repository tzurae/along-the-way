import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Ban, CalendarCheck, CalendarPlus, Check, ChevronRight, ExternalLink, Images, MapPinOff, Pencil, RotateCw, Search } from "lucide-react";

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
import { parseTripPlaceListResponse, type TripPlaceDto } from "@along-the-way/contracts/trip-places";
import { ApiRequestError } from "./api-error";
import { googleMapsPlaceUrl } from "./google-maps";
import { useI18n, type Messages } from "./i18n";
import { VoteControl, VoteVoters } from "./VoteControl";
import { ConflictPanel, useVersionConflict } from "./ConflictPanel";
import { PlaceDetailContent } from "./PlaceDetailContent";
import { PlacePhotoCredit, PlaceThumbnail, usePlacePreviews, type PlaceDetailRequest } from "./PlaceThumbnail";
import { PlaceDetailSheet } from "./PlaceDetailSheet";
import { SchedulePlacesSheet } from "./SchedulePlacesSheet";
import { SelectionBar } from "./SelectionBar";
import { useScheduleToast } from "./ScheduleToast";
import { assignPlacesToDay } from "./schedule-assignments";
import "./pocket-discovery.css";


interface DiscoveryWorkspaceProps {
  trip: TripDto;
  request: PlaceDetailRequest;
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

function discoveryRunFailureReason(errorCode: string | null, t: Messages["discovery"]) {
  switch (errorCode?.toLowerCase()) {
    case "model_unavailable":
      return t.runFailure.modelUnavailable;
    case "provider_unavailable":
      return t.runFailure.providerUnavailable;
    case "research_in_progress":
      return t.runFailure.researchInProgress;
    case "research_limit_reached":
      return t.runFailure.researchLimitReached;
    case "conflict":
      return t.runFailure.conflict;
    default:
      return t.runFailure.unknown;
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
}: {
  sentences: DiscoveryClaimSentenceDto[];
  numberedEvidence: NumberedEvidence;
  t: Messages["discovery"];
}) {
  return (
    <ul className="grid list-disc gap-2 pl-5 text-sm">
      {sentences.map((sentence, sentenceIndex) => (
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

function ResearchPanel({ first, open, onClose, children, footer }: { first: boolean; open: boolean; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  if (first) return <section className="order-3 pd-first-run">{children}{footer}</section>;
  return <PlaceDetailSheet appearance="workspace" open={open} title="你的需求" onClose={onClose} footer={footer}>{children}</PlaceDetailSheet>;
}


export function DiscoveryWorkspace({ trip, request, placesRevision, onPlacesChanged }: DiscoveryWorkspaceProps) {
  const { locale, t: { discovery: t, schedule: scheduleT } } = useI18n();
  const [workspace, setWorkspace] = useState<DiscoveryWorkspaceDto | null>(null);
  const [tripPlaces, setTripPlaces] = useState<TripPlaceDto[]>([]);
  const [briefDraft, setBriefDraft] = useState("");
  const [feedbackDraft, setFeedbackDraft] = useState("");
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, QuestionDraft>>({});
  const [editingFeedbackId, setEditingFeedbackId] = useState<string | null>(null);
  const [feedbackEditDraft, setFeedbackEditDraft] = useState<FeedbackEditDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [operationPending, setPending] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const pending = operationPending ?? (bulkBusy ? "schedule-selection" : null);
  const [selecting, setSelecting] = useState(false);
  const [selectedProposalIds, setSelectedProposalIds] = useState<Set<string>>(() => new Set());
  const [scheduleProposalIds, setScheduleProposalIds] = useState<string[]>([]);
  const [scheduleInitialDayId, setScheduleInitialDayId] = useState<string | null>(null);
  const [scheduleAllowUnscheduled, setScheduleAllowUnscheduled] = useState(false);
  const [scheduleError, setScheduleError] = useState("");
  const [changedProposalIds, setChangedProposalIds] = useState<Set<string>>(() => new Set());
  const changedRowsTimer = useRef<number | null>(null);
  const [notice, setNotice] = useState<{ area: NoticeArea; text: string } | null>(null);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const detailTitleRef = useRef<HTMLHeadingElement>(null);
  const detailReturnPosition = useRef<{ x: number; y: number } | null>(null);
  const [rejectConfirmation, setRejectConfirmation] = useState<CandidateProposalDto | null>(null);
  const [researchSettingsOpen, setResearchSettingsOpen] = useState(false);
  const scheduleToast = useScheduleToast();
  useEffect(() => () => {
    if (changedRowsTimer.current !== null) window.clearTimeout(changedRowsTimer.current);
  }, []);

  function openProposalDetail(proposalId: string) {
    if (proposalId === selectedProposalId) {
      window.requestAnimationFrame(() => detailTitleRef.current?.focus());
      return;
    }
    detailReturnPosition.current = { x: window.scrollX, y: window.scrollY };
    setRejectConfirmation(null);
    setSelectedProposalId(proposalId);
  }

  const retryKeys = useRef<RetryKeys>(new Map());
  const briefBase = useRef<DiscoveryWorkspaceDto["brief"]>(null);
  const answersBase = useRef<DiscoveryWorkspaceDto["brief"]>(null);
  const feedbackBase = useRef<DiscoveryFeedbackDto | null>(null);
  const conflictLatest = useRef<DiscoveryWorkspaceDto | null>(null);
  const resolution = useVersionConflict<Record<string, unknown>>();
  const conflictAction = useRef<{ operation: string; path: string; payload: Record<string, unknown>; area: NoticeArea; after?: () => void; method?: "POST" | "PUT" } | null>(null);

  function closeProposalDetail() {
    const proposalId = selectedProposalId;
    const position = detailReturnPosition.current;
    detailReturnPosition.current = null;
    setSelectedProposalId(null);
    setRejectConfirmation(null);
    if (proposalId) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-proposal-detail-trigger="${proposalId}"]`)?.focus({ preventScroll: true });
        if (position) window.scrollTo({ left: position.x, top: position.y, behavior: "instant" });
      });
    }
  }
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
      const [discovery, places] = await Promise.all([
        request<unknown>(`/api/trips/${trip.id}/discovery`),
        request<unknown>(`/api/trips/${trip.id}/trip-places`),
      ]);
      apply(discovery);
      setTripPlaces(parseTripPlaceListResponse(places).tripPlaces);
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

  // Place and member changes made in other tabs only refresh projections; unsaved brief
  // and question drafts typed here must survive them.
  const refreshSignal = `${placesRevision}:${trip.members.length}`;
  const lastRefreshSignal = useRef(refreshSignal);
  useEffect(() => {
    if (lastRefreshSignal.current === refreshSignal) return;
    lastRefreshSignal.current = refreshSignal;
    void Promise.all([
      request<unknown>(`/api/trips/${trip.id}/discovery`),
      request<unknown>(`/api/trips/${trip.id}/trip-places`),
    ]).then(([discovery, places]) => {
      setWorkspace(parseDiscoveryWorkspaceResponse(discovery).discovery);
      setTripPlaces(parseTripPlaceListResponse(places).tripPlaces);
    }).catch((error: unknown) => setNotice({ area: "general", text: errorMessage(error, t.errors.failed) }));
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
    const researched = await mutate("generate", `/api/trips/${trip.id}/discovery/generate`, {
      expectedBriefVersion: brief.version,
    }, area);
    if (researched) setResearchSettingsOpen(false);
  }

  async function decideProposal(proposal: CandidateProposalDto, decision: "accept" | "reject") {
    return mutate(
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

  function proposalActions(proposal: CandidateProposalDto) {
    const place = acceptedPlaceFor(proposal);
    const located = proposalIsLocated(proposal);
    const canSchedule = trip.role === "owner"
      && (proposal.status === "pending" || proposal.status === "accepted")
      && Boolean(proposal.status === "pending" || place);
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        {proposal.status === "pending" ? (
          <button
            className="pd-danger-button"
            disabled={pending !== null}
            onClick={() => {
              openProposalDetail(proposal.id);
              setRejectConfirmation(proposal);
            }}
          >
            <Ban aria-hidden="true" className="size-4" />
            {t.proposal.decline}
          </button>
        ) : <span className="font-bold">{t.status[proposal.status]}</span>}
        {canSchedule && located ? (
          <button
            type="button"
            className="schedule-primary-button"
            disabled={pending !== null}
            onClick={() => openProposalSchedule(proposal)}
          >
            <CalendarPlus aria-hidden="true" className="size-4" />
            {place?.assignedDayId ? scheduleT.changeDate : scheduleT.pageAction}
          </button>
        ) : null}
      </div>
    );
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
  const selectedProposal = workspace?.proposals.find((proposal) => proposal.id === selectedProposalId) ?? null;
  const proposalNameCounts = new Map<string, number>();
  for (const proposal of workspace?.proposals ?? []) {
    proposalNameCounts.set(proposal.name, (proposalNameCounts.get(proposal.name) ?? 0) + 1);
  }
  const previews = usePlacePreviews({
    tripId: trip.id,
    kind: "proposal",
    ids: workspace?.proposals.map((proposal) => proposal.id) ?? [],
    request,
  });

  function proposalDetail(proposal: CandidateProposalDto) {
    const numberedEvidence = new Map(
      proposal.evidence.map((item, index) => [item.id, { item, number: index + 1 }] as const),
    );
    const hasTradeoffs = proposal.tradeoffSentences !== null
      ? proposal.tradeoffSentences.length > 0
      : proposal.tradeoffs.length > 0;
    return (
      <PlaceDetailContent
        tripId={trip.id}
        reference={{ kind: "proposal", id: proposal.id }}
        request={request}
        collapsible
        interlude={<div className="pd-detail">
        <section className="pd-detail-section">
          <h3>{t.proposal.whyRecommended}</h3>
          {proposal.recommendationSentences === null ? <p className="pd-reason-copy">{proposal.recommendation}</p> : null}
          {proposal.recommendationSentences?.length
            ? <ClaimSentenceList sentences={proposal.recommendationSentences} numberedEvidence={numberedEvidence} t={t} />
            : null}
          {proposal.endorsements.length ? <div className="mt-3" aria-label={t.proposal.recommendedByFor(proposal.name)}><strong>{t.proposal.recommendedBy}</strong><ul className="mt-1 flex flex-wrap gap-2">{proposal.endorsements.map((endorsement) => <li key={endorsement} className="rounded-full border bg-surface px-3 py-1 text-sm font-bold">{endorsementLabel(endorsement, t)}</li>)}</ul></div> : null}
        </section>
        <section className="pd-detail-section">
          <h3>{t.proposal.where}</h3>
          <p className="text-sm">{proposal.address ?? t.proposal.unknownAddress}</p>
          <a className="pd-secondary mt-3" href={googleMapsPlaceUrl(proposal.name, proposal.providerPlaceId)} target="_blank" rel="noreferrer"><Images aria-hidden="true" className="size-4" />{t.proposal.viewPhotos}</a>
        </section>
        {hasTradeoffs || proposal.unknowns.length ? (
          <section className="pd-detail-section">
            <h3>{t.proposal.cautions}</h3>
            {hasTradeoffs ? proposal.tradeoffSentences !== null
              ? <ClaimSentenceList sentences={proposal.tradeoffSentences} numberedEvidence={numberedEvidence} t={t} />
              : <ul className="list-disc pl-5 text-sm">{proposal.tradeoffs.map((item) => <li key={item}>{item}</li>)}</ul> : null}
            {proposal.unknowns.length ? <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">{proposal.unknowns.map((item) => <li key={item}>{t.proposal.unknownPrefix(item)}</li>)}</ul> : null}
          </section>
        ) : null}
        <section className="pd-detail-section">
          <h3>{t.proposal.matchesYourNeeds}</h3>
          <p className="text-sm">{proposal.matchedNeeds.length ? proposal.matchedNeeds.join("・") : t.proposal.noMatchesListed}</p>
        </section>
        {proposal.status === "pending" && proposal.votingAvailable ? <section className="pd-detail-section"><VoteVoters voters={proposal.voters} /></section> : null}
        <section className="pd-detail-section">
          {proposal.evidence.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.proposal.noEvidence}</p>
          ) : (
            <details className="pd-evidence-disclosure">
              <summary><ChevronRight aria-hidden="true" className="pd-evidence-chevron" />{t.proposal.sourceCount(proposal.evidence.length)}</summary>
              <ul className="mt-3 grid gap-2">
                {proposal.evidence.map((item, evidenceIndex) => {
                  const number = evidenceIndex + 1;
                  return (
                    <li key={item.id}>
                      <a className="pd-inline-link break-all font-bold text-accent-strong underline underline-offset-2" href={item.sourceUrl} target="_blank" rel="noreferrer" aria-label={t.proposal.citationLabel(number, item.title)}>
                        <span>[{number}] {item.title}</span><ExternalLink aria-hidden="true" className="size-4" />
                      </a>
                      <span className="block text-xs text-muted-foreground">{item.attribution}・{t.proposal.observedAt(new Date(item.observedAt).toLocaleString(locale))}</span>
                      {item.isStale ? <span className="text-xs font-bold text-destructive">{t.proposal.staleEvidence}</span> : null}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
        </section>
        </div>}
      />
    );
  }
  const tripPlacesById = new Map(tripPlaces.map((place) => [place.id, place]));
  const acceptedPlaceFor = (proposal: CandidateProposalDto) =>
    proposal.acceptedTripPlaceId ? tripPlacesById.get(proposal.acceptedTripPlaceId) ?? null : null;
  const proposalIsLocated = (proposal: CandidateProposalDto) => {
    const place = acceptedPlaceFor(proposal);
    return (place?.latitude ?? proposal.latitude) !== null && (place?.longitude ?? proposal.longitude) !== null;
  };
  const proposalDayId = (proposal: CandidateProposalDto) => acceptedPlaceFor(proposal)?.assignedDayId ?? null;
  const proposalCanBeSelected = (proposal: CandidateProposalDto) => {
    if (!proposalIsLocated(proposal)) return false;
    if (proposal.status === "pending") return true;
    const place = acceptedPlaceFor(proposal);
    return proposal.status === "accepted" && Boolean(place && !place.scheduled && !place.assignedDayId);
  };
  const sheetProposals = scheduleProposalIds.flatMap((id) => {
    const proposal = workspace?.proposals.find((candidate) => candidate.id === id);
    return proposal ? [proposal] : [];
  });
  const hasSelectableProposals = (workspace?.proposals ?? []).some(proposalCanBeSelected);
  const missingLocationProposalCount = (workspace?.proposals ?? []).filter((proposal) =>
    (proposal.status === "pending" || proposal.status === "accepted") && !proposalIsLocated(proposal)
  ).length;

  function formatScheduledDay(dayId: string) {
    const day = trip.days.find((candidate) => candidate.id === dayId);
    if (!day) return dayId;
    const [, month, date] = day.date.split("-");
    const weekday = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      timeZone: "UTC",
    }).format(new Date(`${day.date}T12:00:00Z`));
    return `${Number(month)}/${Number(date)}（${weekday}）`;
  }

  function beginSelection() {
    setSelectedProposalIds(new Set());
    setScheduleError("");
    setSelecting(true);
  }

  function changeSelection(proposal: CandidateProposalDto, checked: boolean) {
    if (pending || !proposalCanBeSelected(proposal)) return;
    setSelectedProposalIds((previous) => {
      const next = new Set(previous);
      if (checked) next.add(proposal.id);
      else next.delete(proposal.id);
      return next;
    });
  }

  function openSchedule(ids: string[], initialDayId: string | null = null, allowUnscheduled = false) {
    if (ids.length === 0) return;
    setScheduleProposalIds(ids);
    setScheduleInitialDayId(initialDayId);
    setScheduleAllowUnscheduled(allowUnscheduled);
    setScheduleError("");
  }

  function openProposalSchedule(proposal: CandidateProposalDto) {
    const dayId = proposalDayId(proposal);
    setSelectedProposalId(null);
    setRejectConfirmation(null);
    openSchedule([proposal.id], dayId, dayId !== null);
  }

  function closeSchedule() {
    if (bulkBusy) return;
    setScheduleProposalIds([]);
    setScheduleInitialDayId(null);
    setScheduleAllowUnscheduled(false);
    setScheduleError("");
  }

  async function readSchedulingState() {
    const [discoveryValue, placesValue] = await Promise.all([
      request<unknown>(`/api/trips/${trip.id}/discovery`),
      request<unknown>(`/api/trips/${trip.id}/trip-places`),
    ]);
    const nextWorkspace = parseDiscoveryWorkspaceResponse(discoveryValue).discovery;
    const nextPlaces = parseTripPlaceListResponse(placesValue).tripPlaces;
    setWorkspace(nextWorkspace);
    setTripPlaces(nextPlaces);
    return { nextWorkspace, nextPlaces };
  }

  function scheduleFailure(
    proposalIds: string[],
    currentWorkspace: DiscoveryWorkspaceDto,
    currentPlaces: TripPlaceDto[],
    targetDayId: string | null,
    error: unknown,
  ) {
    const placesById = new Map(currentPlaces.map((place) => [place.id, place]));
    const unscheduledNames = proposalIds.flatMap((id) => {
      const proposal = currentWorkspace.proposals.find((candidate) => candidate.id === id);
      if (!proposal?.acceptedTripPlaceId) return [];
      const place = placesById.get(proposal.acceptedTripPlaceId);
      return !place || (targetDayId !== null && place.assignedDayId === null)
        ? [proposal.name]
        : [];
    });
    setNotice(null);
    setScheduleError(unscheduledNames.length
      ? t.scheduling.partialFailure(unscheduledNames)
      : error instanceof ApiRequestError
        ? t.scheduling.failed(error.message)
        : t.scheduling.requestFailed);
  }

  function finishSchedule(
    proposalIds: string[],
    currentWorkspace: DiscoveryWorkspaceDto,
    dayId: string | null,
  ) {
    onPlacesChanged();
    const scheduledNames = proposalIds.flatMap((id) => {
      const proposal = currentWorkspace.proposals.find((candidate) => candidate.id === id);
      return proposal ? [proposal.name] : [];
    });
    closeSchedule();
    setSelecting(false);
    setSelectedProposalIds(new Set());
    setChangedProposalIds(new Set(proposalIds));
    if (changedRowsTimer.current !== null) window.clearTimeout(changedRowsTimer.current);
    changedRowsTimer.current = window.setTimeout(() => {
      setChangedProposalIds(new Set());
      changedRowsTimer.current = null;
    }, 1_400);
    if (dayId) {
      const label = formatScheduledDay(dayId);
      const day = trip.days.find((candidate) => candidate.id === dayId);
      scheduleToast.show(scheduleT.toastScheduled(scheduledNames.length, label), day ? {
        label: scheduleT.viewItinerary,
        href: `?trip=${encodeURIComponent(trip.id)}&tab=itinerary&segment=daily&day=${encodeURIComponent(day.date)}`,
      } : undefined);
    } else if (scheduledNames[0]) {
      scheduleToast.show(scheduleT.toastUnscheduled(scheduledNames[0]));
    }
  }

  async function confirmSchedule(dayId: string | null) {
    if (bulkBusy || scheduleProposalIds.length === 0) return;
    const proposalIds = [...scheduleProposalIds];
    setBulkBusy(true);
    setScheduleError("");
    let currentWorkspace = workspace;
    let currentPlaces = tripPlaces;
    try {
      const fresh = await readSchedulingState();
      currentWorkspace = fresh.nextWorkspace;
      currentPlaces = fresh.nextPlaces;
      for (const proposalId of proposalIds) {
        const proposal = currentWorkspace.proposals.find((candidate) => candidate.id === proposalId);
        if (!proposal) throw new Error(t.scheduling.proposalChanged);
        if (proposal.status === "pending") {
          const next = await decideProposal(proposal, "accept");
          if (!next) throw new Error(t.scheduling.acceptFailed);
          currentWorkspace = next;
        } else if (proposal.status !== "accepted" || !proposal.acceptedTripPlaceId) {
          throw new Error(t.scheduling.proposalChanged);
        }
      }
      const placesValue = await request<unknown>(`/api/trips/${trip.id}/trip-places`);
      currentPlaces = parseTripPlaceListResponse(placesValue).tripPlaces;
      setTripPlaces(currentPlaces);
      const items = proposalIds.map((proposalId) => {
        const proposal = currentWorkspace!.proposals.find((candidate) => candidate.id === proposalId);
        const place = proposal?.acceptedTripPlaceId
          ? currentPlaces.find((candidate) => candidate.id === proposal.acceptedTripPlaceId)
          : null;
        if (!proposal || !place || place.latitude === null || place.longitude === null) {
          throw new Error(t.scheduling.placeUnavailable);
        }
        return {
          tripPlaceId: place.id,
          version: place.version,
          currentDayId: place.assignedDayId,
        };
      });
      const assigned = await assignPlacesToDay({
        request,
        tripId: trip.id,
        dayId,
        items,
      });
      setTripPlaces(assigned.tripPlaces);
      finishSchedule(proposalIds, currentWorkspace, dayId);
    } catch (error) {
      try {
        const fresh = await readSchedulingState();
        currentWorkspace = fresh.nextWorkspace;
        currentPlaces = fresh.nextPlaces;
      } catch {
        // Keep the latest successfully read state; retry always reconciles before accepting.
      }
      if (!currentWorkspace) {
        setScheduleError(error instanceof ApiRequestError
          ? t.scheduling.failed(error.message)
          : t.scheduling.requestFailed);
        return;
      }
      const placesById = new Map(currentPlaces.map((place) => [place.id, place]));
      const completed = proposalIds.every((proposalId) => {
        const proposal = currentWorkspace!.proposals.find((candidate) => candidate.id === proposalId);
        const place = proposal?.acceptedTripPlaceId ? placesById.get(proposal.acceptedTripPlaceId) : null;
        return place?.assignedDayId === dayId;
      });
      if (completed) {
        finishSchedule(proposalIds, currentWorkspace, dayId);
        return;
      }
      scheduleFailure(proposalIds, currentWorkspace, currentPlaces, dayId, error);
    } finally {
      setBulkBusy(false);
    }
  }
  return (
    <section className="pd-workspace pd-discovery" data-selecting={selecting ? "true" : undefined} aria-labelledby="ai-discovery-heading">
      <div className={`pd-pagehead${selecting ? " pd-pagehead--selecting" : ""}`}>
        <h2 id="ai-discovery-heading" className="schedule-page-title">{selecting ? scheduleT.selectedCount(selectedProposalIds.size) : t.header.title}</h2>
        {selecting ? (
          <div className="schedule-head-buttons">
            <button
              className="schedule-secondary-button"
              disabled={pending !== null}
              onClick={() => {
                setSelecting(false);
                setSelectedProposalIds(new Set());
                setScheduleError("");
              }}
            >
              {scheduleT.cancel}
            </button>
          </div>
        ) : (
          <div className="schedule-head-buttons">
            {trip.role === "owner" ? (
              <button className="schedule-primary-button" disabled={pending !== null || loading} onClick={beginSelection}>
                <CalendarPlus aria-hidden="true" className="size-4" />
                <span>{scheduleT.pageAction}</span>
              </button>
            ) : null}
            {workspace?.latestRun?.status === "completed" ? (
              <button className="schedule-secondary-button" onClick={() => setResearchSettingsOpen(true)}>
                <Pencil aria-hidden="true" className="size-4" />
                <span>{t.brief.editRequirements}</span>
              </button>
            ) : null}
          </div>
        )}
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
          {Object.keys(questionDrafts).length ? (
            <section className="order-1 rounded-panel border border-ink/10 p-4" aria-label={t.brief.questions}>
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
            </section>
          ) : null}
          <ResearchPanel
            first={!workspace?.latestRun}
            open={researchSettingsOpen}
            onClose={() => setResearchSettingsOpen(false)}
            footer={workspace?.latestRun ? (
              <div className="pd-research-footer">
                <span>{t.brief.updateConsequence}</span>
                <button className="pd-primary" disabled={pending !== null || !briefDraft.trim()} onClick={() => void research("again")}><RotateCw aria-hidden="true" className="size-4" />{researchLabel(t.brief.updateCandidates)}</button>
              </div>
            ) : <button className="pd-primary" disabled={pending !== null || !briefDraft.trim()} onClick={() => void research("find")}><Search aria-hidden="true" className="size-4" />{researchLabel(t.brief.findCandidates)}</button>}
          >
            <div className="pd-brief-editor">
              <section aria-label={t.brief.areaLabel}>
                <label className="grid gap-2 font-bold">{t.brief.prompt}
                  <textarea
                    className="min-h-32 rounded-xl border bg-surface p-3 font-normal"
                    value={briefDraft}
                    onChange={(event) => setBriefDraft(event.target.value)}
                    placeholder={t.brief.placeholder}
                  />
                </label>
                <p className="pd-field-help">{t.brief.suggestionOnly}</p>
                {notice?.area === "find" || notice?.area === "again" ? <p className="mt-3 rounded-xl border border-accent-strong/30 bg-surface p-4 text-accent-strong" role="alert">{notice.text}</p> : null}
                {!workspace?.latestRun && !workspace?.modelAvailable ? <p className="mt-3 text-sm text-muted-foreground">{t.brief.modelUnavailable}</p> : null}
                {!workspace?.latestRun && !workspace?.placeProviderAvailable ? <p className="mt-2 text-sm text-muted-foreground">{t.brief.placesUnavailable}</p> : null}
              </section>
              {!workspace?.latestRun && workspace?.brief?.structured ? (
                <section className="rounded-panel border border-ink/10 p-4" aria-label={t.brief.interpretationLabel}>
                  <h3 className="font-display text-2xl">{t.brief.understood}</h3>
                  <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div><dt className="font-bold">{t.brief.interests}</dt><dd>{workspace.brief.structured.interests.join("、") || t.brief.unknown}</dd></div>
                    <div><dt className="font-bold">{t.brief.areas}</dt><dd>{workspace.brief.structured.areas.join("、") || t.brief.unknown}</dd></div>
                    <div><dt className="font-bold">{t.brief.pace}</dt><dd>{workspace.brief.structured.pace ?? t.brief.unknown}</dd></div>
                    <div><dt className="font-bold">{t.brief.budget}</dt><dd>{workspace.brief.structured.budget ?? t.brief.unknown}</dd></div>
                    <div className="sm:col-span-2"><dt className="font-bold">{t.brief.avoid}</dt><dd>{workspace.brief.structured.exclusions.join("、") || t.brief.nothingConfirmed}</dd></div>
                  </dl>
                </section>
              ) : null}
            </div>
          </ResearchPanel>

          {workspace?.latestRun?.status === "failed" ? (
            <section className="order-1 rounded-panel border border-destructive/30 bg-surface p-4" role="alert" aria-labelledby="discovery-run-failed-heading">
              <h3 id="discovery-run-failed-heading" className="font-display text-2xl">{t.runFailure.title}</h3>
              <p className="mt-1 text-sm">{discoveryRunFailureReason(workspace.latestRun.errorCode, t)}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button className="pd-secondary" disabled={pending !== null} onClick={() => setResearchSettingsOpen(true)}><Pencil aria-hidden="true" className="size-4" />{t.brief.editRequirements}</button>
                <button className="pd-primary" disabled={pending !== null || !briefDraft.trim()} onClick={() => void research("again")}><RotateCw aria-hidden="true" className="size-4" />{researchLabel(t.runFailure.regenerate)}</button>
              </div>
            </section>
          ) : null}

          {workspace?.proposals.length ? (
            <section className="order-2" aria-label={t.proposal.shortlistLabel}>
              <h3 className="sr-only">{t.proposal.shortlistTitle}</h3>
              <div className="pd-list mt-4" aria-label={t.proposal.shortlistLabel}>
                {workspace.proposals.map((proposal) => {
                  const firstSentence = proposal.recommendationSentences?.[0];
                  const numberedEvidence = new Map(proposal.evidence.map((item, index) => [item.id, { item, number: index + 1 }] as const));
                  const repeatedName = (proposalNameCounts.get(proposal.name) ?? 0) > 1;
                  const selectable = proposalCanBeSelected(proposal);
                  const selected = selectedProposalIds.has(proposal.id);
                  const assignedDayId = proposalDayId(proposal);
                  const located = proposalIsLocated(proposal);
                  const selectionLabel = scheduleT.selectPlace(proposal.name);
                  const scheduleMeta = assignedDayId ? (
                    <span className="pd-schedule-meta schedule-status-pill">
                      <CalendarCheck aria-hidden="true" />
                      {scheduleT.scheduledOn(formatScheduledDay(assignedDayId))}
                    </span>
                  ) : !located ? (
                    <span className="pd-schedule-meta">
                      <MapPinOff aria-hidden="true" />
                      {t.scheduling.missingLocationUnavailable}
                    </span>
                  ) : null;
                  const classes = [
                    "pd-row",
                    selecting ? "pd-row--selecting" : "",
                    selectable ? "pd-row--selectable" : "",
                    selected ? "pd-row--selected" : "",
                    assignedDayId ? "schedule-row--scheduled" : "",
                    changedProposalIds.has(proposal.id) ? "schedule-row--changed" : "",
                  ].filter(Boolean).join(" ");
                  return (
                    <article
                      key={proposal.id}
                      data-discovery-proposal={proposal.name}
                      className={classes}
                      aria-current={!selecting && proposal.id === selectedProposalId ? "true" : undefined}
                      aria-label={repeatedName ? t.proposal.proposalAtAddress(proposal.name, proposal.address ?? t.proposal.unknownAddress) : t.proposal.ariaLabel(proposal.name)}
                      onClick={(event) => {
                        if (event.target instanceof Element && event.target.closest("button, a, input, label, textarea, select")) return;
                        if (selecting) changeSelection(proposal, !selected);
                        else openProposalDetail(proposal.id);
                      }}
                    >
                      {selecting && selectable ? (
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={selected}
                          aria-label={selectionLabel}
                          className="schedule-selection-check schedule-selection-check--desktop"
                          disabled={pending !== null}
                          onClick={() => changeSelection(proposal, !selected)}
                        >
                          <Check aria-hidden="true" size={16} strokeWidth={3} />
                        </button>
                      ) : null}
                      <div className="pd-row-main">
                        <PlaceThumbnail photo={previews.photos.get(proposal.id)} loading={previews.loading} />
                        <div className="pd-row-copy">
                          <div className="pd-titleline">
                            {selecting ? (
                              <span className="pd-titlebutton">{proposal.name}</span>
                            ) : (
                              <button
                                type="button"
                                className="pd-titlebutton"
                                data-proposal-detail-trigger={proposal.id}
                                aria-label={t.proposal.viewDetail(proposal.name)}
                                onClick={() => openProposalDetail(proposal.id)}
                              >
                                {proposal.name}
                              </button>
                            )}
                            <span className="pd-chip">{proposal.category ?? t.placeType[proposal.type]}</span>
                            {selecting && selectable ? (
                              <button
                                type="button"
                                role="checkbox"
                                aria-checked={selected}
                                aria-label={selectionLabel}
                                className="schedule-selection-check schedule-selection-check--mobile"
                                disabled={pending !== null}
                                onClick={() => changeSelection(proposal, !selected)}
                              >
                                <Check aria-hidden="true" size={16} strokeWidth={3} />
                              </button>
                            ) : null}
                          </div>
                          {repeatedName ? <p className="pd-row-note">{proposal.address ?? t.proposal.unknownAddress}</p> : null}
                          {firstSentence ? <p className="pd-row-note"><ClaimSentence sentence={firstSentence} numberedEvidence={numberedEvidence} t={t} /></p> : proposal.recommendationSentences === null ? <p className="pd-row-note">{proposal.recommendation}</p> : null}
                          <div className="pd-row-status">
                            {scheduleMeta}
                            <p className="pd-fit-line">{t.proposal.fitLine(proposal.matchedNeeds)}</p>
                          </div>
                          <PlacePhotoCredit photo={previews.photos.get(proposal.id)} />
                          {proposal.status === "pending" && proposal.votingAvailable ? (
                            <div className="pd-row-bottom">
                              <VoteControl compact name={proposal.name} voters={proposal.voters} voteCount={proposal.voteCount} ownVote={proposal.ownVote} votingAvailable disabled={pending !== null} onChange={(voted) => void setProposalVote(proposal, voted)} />
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ) : workspace?.latestRun?.status === "completed" ? <p className="order-2 rounded-panel border border-dashed p-5 text-center text-muted-foreground">{workspace.latestRun.shortfalls.length ? t.proposal.noneNew : t.proposal.nonePassed}</p> : null}

          {selectedProposal ? (
            <PlaceDetailSheet
              open
              appearance="workspace"
              title={selectedProposal.name}
              description={<div className="pd-detail-badges">
                <span className="pd-chip">{selectedProposal.category ?? t.placeType[selectedProposal.type]}</span>
                {proposalDayId(selectedProposal) ? (
                  <span className="schedule-status-pill">
                    <CalendarCheck aria-hidden="true" className="size-[15px]" />
                    {scheduleT.scheduledOn(formatScheduledDay(proposalDayId(selectedProposal)!))}
                  </span>
                ) : selectedProposal.status === "rejected" ? <span className="pd-state">{t.status.rejected}</span> : null}
              </div>}
              titleRef={detailTitleRef}
              onClose={closeProposalDetail}
              footer={
              rejectConfirmation ? <div className="pd-confirm-footer"><p>{t.proposal.rejectConfirmTitle(rejectConfirmation.name)}</p><p>{t.proposal.rejectConfirmDescription}</p>{notice?.area === "general" ? <p role="alert">{notice.text}</p> : null}<div><button className="pd-secondary" disabled={pending !== null} onClick={() => setRejectConfirmation(null)}>{t.proposal.cancel}</button><button className="pd-danger-button" disabled={pending !== null} onClick={() => { const proposal = rejectConfirmation; void decideProposal(proposal, "reject").then((next) => { if (next) { setRejectConfirmation(null); closeProposalDetail(); } }); }}>{t.proposal.rejectConfirm}</button></div></div>
              : <div>{notice?.area === "general" ? <p className="pd-notice" role="alert">{notice.text}</p> : null}<div className="pd-fixed-actions">{selectedProposal.status === "pending" && selectedProposal.votingAvailable ? <VoteControl compact name={selectedProposal.name} voters={selectedProposal.voters} voteCount={selectedProposal.voteCount} ownVote={selectedProposal.ownVote} votingAvailable disabled={pending !== null} onChange={(voted) => void setProposalVote(selectedProposal, voted)} /> : null}{proposalActions(selectedProposal)}</div></div>
            }>
              {proposalDetail(selectedProposal)}
            </PlaceDetailSheet>
          ) : null}


          {workspace?.decided.length ? (
            <section className="order-4 rounded-panel border border-ink/10 p-4" aria-label={t.decided.areaLabel}>
              <h3 className="font-display text-2xl">{t.decided.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t.decided.description}</p>
              <ul className="mt-3 grid gap-2">{workspace.decided.map((decision) => <li key={decision.proposalId} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-surface-subtle p-3"><strong>{decision.name}</strong><span className="text-sm">{decision.status === "accepted" ? t.decided.accepted : t.decided.rejected}・{t.decided.decidedAt(new Date(decision.decidedAt).toLocaleDateString(locale))}</span></li>)}</ul>
            </section>
          ) : null}

          {workspace?.latestRun?.status === "completed" && workspace.latestRun.shortfalls.length ? (
            <section className="order-4 rounded-panel border border-ink/10 p-4" aria-label={t.missing.areaLabel}>
              <h3 className="font-display text-2xl">{t.missing.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t.missing.description}</p>
              <ul className="mt-3 grid gap-2">{workspace.latestRun.shortfalls.map((shortfall) => <li key={`${shortfall.code}:${shortfall.subject}`} className="rounded-lg bg-surface-subtle p-3"><strong>{shortfall.subject}</strong>{shortfall.named ? <span className="ml-2 text-xs font-bold uppercase tracking-[0.12em] text-accent-strong">{t.missing.requested}</span> : null}<span className="block text-sm">{shortfallText(shortfall, t)}</span></li>)}</ul>
            </section>
          ) : null}

          <section className="order-4 rounded-panel bg-surface-subtle p-4" aria-label={t.feedback.areaLabel}>
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
      <SelectionBar
        count={selectedProposalIds.size}
        actionLabel={scheduleT.chooseDate}
        hint={!hasSelectableProposals && missingLocationProposalCount > 0
          ? t.scheduling.missingLocationHint(missingLocationProposalCount)
          : undefined}
        onAction={() => openSchedule([...selectedProposalIds])}
        visible={selecting}
      />
      <SchedulePlacesSheet
        open={scheduleProposalIds.length > 0}
        trip={trip}
        places={sheetProposals.map((proposal) => ({ id: proposal.id, name: proposal.name }))}
        initialDayId={scheduleInitialDayId}
        allowUnscheduled={scheduleAllowUnscheduled}
        busy={bulkBusy}
        error={scheduleError || undefined}
        onConfirm={confirmSchedule}
        onClose={closeSchedule}
      />
      {scheduleToast.toast}
    </section>
  );
}
