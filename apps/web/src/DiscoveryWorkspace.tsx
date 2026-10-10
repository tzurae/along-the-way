import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ExternalLink, Images, Search, X } from "lucide-react";

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
import { PlaceDetailContent } from "./PlaceDetailContent";
import { PlacePhotoCredit, PlaceThumbnail, usePlacePreviews, type PlaceDetailRequest } from "./PlaceThumbnail";
import { PlaceDetailSheet } from "./PlaceDetailSheet";
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
  return <PlaceDetailSheet appearance="workspace" open={open} title="修改需求" onClose={onClose} footer={footer}>{children}</PlaceDetailSheet>;
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
  const [operationPending, setPending] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const pending = operationPending ?? (bulkBusy ? "bulk-selection" : null);
  const [selecting, setSelecting] = useState(false);
  const [selectionDraft, setSelectionDraft] = useState<Map<string, { proposal: CandidateProposalDto; selected: boolean }>>(() => new Map());
  const [bulkConfirmation, setBulkConfirmation] = useState(false);
  const [notice, setNotice] = useState<{ area: NoticeArea; text: string } | null>(null);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const detailTitleRef = useRef<HTMLHeadingElement>(null);
  const detailReturnPosition = useRef<{ x: number; y: number } | null>(null);
  const [rejectConfirmation, setRejectConfirmation] = useState<CandidateProposalDto | null>(null);
  const [removeConfirmation, setRemoveConfirmation] = useState<CandidateProposalDto | null>(null);
  const [researchSettingsOpen, setResearchSettingsOpen] = useState(false);

  function openProposalDetail(proposalId: string) {
    if (proposalId === selectedProposalId) {
      window.requestAnimationFrame(() => detailTitleRef.current?.focus());
      return;
    }
    detailReturnPosition.current = { x: window.scrollX, y: window.scrollY };
    setRejectConfirmation(null);
    setRemoveConfirmation(null);
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
    setRemoveConfirmation(null);
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

  async function removeAcceptedProposal(proposal: CandidateProposalDto) {
    if (pending || !proposal.acceptedTripPlaceId) return;
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
      return refreshed;
    } catch (error) {
      setNotice({ area: "general", text: errorMessage(error, t.errors.failed) });
    } finally {
      setPending(null);
    }
  }

  function proposalActions(proposal: CandidateProposalDto) {
    if (proposal.status === "pending") {
      return (
        <div className="flex flex-wrap gap-2 2xl:flex-nowrap">
          <button className="flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg bg-accent px-3 font-bold text-ink-strong outline-none hover:bg-accent/80 focus:ring-4 focus:ring-focus/30 disabled:opacity-60" disabled={pending !== null} onClick={() => void decideProposal(proposal, "accept")}><Check aria-hidden="true" className="size-4" />{t.proposal.accept}</button>
          <button className="flex min-h-11 items-center gap-2 whitespace-nowrap rounded-lg border px-3 font-bold outline-none hover:bg-surface focus:ring-4 focus:ring-focus/30 disabled:opacity-60" disabled={pending !== null} onClick={() => { openProposalDetail(proposal.id); setRejectConfirmation(proposal); }}><X aria-hidden="true" className="size-4" />{t.proposal.decline}</button>
        </div>
      );
    }
    if (proposal.status === "accepted") {
      return (
        <div className="flex flex-wrap items-center gap-2 2xl:flex-nowrap">
          <span className="whitespace-nowrap font-bold">{t.status.accepted}</span>
          {proposal.acceptedTripPlaceId ? <button className="min-h-11 whitespace-nowrap rounded-lg border px-3 font-bold" disabled={pending !== null} onClick={() => { openProposalDetail(proposal.id); setRemoveConfirmation(proposal); }}>{tripPlacesT.workspace.remove}</button> : null}
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
      <div className="grid gap-4">
        <PlaceDetailContent tripId={trip.id} reference={{ kind: "proposal", id: proposal.id }} request={request} />
        <p className="text-sm text-muted-foreground">{proposal.address ?? t.proposal.unknownAddress}</p>
        {proposal.endorsements.length ? <div aria-label={t.proposal.recommendedByFor(proposal.name)}><strong>{t.proposal.recommendedBy}</strong><ul className="mt-1 flex flex-wrap gap-2">{proposal.endorsements.map((endorsement) => <li key={endorsement} className="rounded-full border bg-surface px-3 py-1 text-sm font-bold">{endorsementLabel(endorsement, t)}</li>)}</ul></div> : null}
        {proposal.recommendationSentences === null ? <p>{proposal.recommendation}</p> : null}
        {proposal.recommendationSentences && proposal.recommendationSentences.length > 0
          ? <ClaimSentenceList sentences={proposal.recommendationSentences} numberedEvidence={numberedEvidence} t={t} />
          : null}
        {proposal.status === "pending" && proposal.votingAvailable ? <VoteVoters voters={proposal.voters} /> : null}
        <a className="inline-flex min-h-11 w-fit items-center gap-2 rounded-lg border bg-surface px-3 font-bold outline-none hover:bg-surface-subtle focus:ring-4 focus:ring-focus/30" href={googleMapsPlaceUrl(proposal.name, proposal.providerPlaceId)} target="_blank" rel="noreferrer"><Images aria-hidden="true" className="size-4" />{t.proposal.viewPhotos}</a>
        {proposal.matchedNeeds.length || hasTradeoffs || proposal.unknowns.length ? (
          <div className="grid gap-3">
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
                    className="inline-flex items-center gap-1 break-all font-bold text-accent-strong underline underline-offset-2"
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
    );
  }
  const selectionChecked = (proposal: CandidateProposalDto) => selectionDraft.get(proposal.id)?.selected ?? proposal.status === "accepted";
  const selectionChanges = (workspace?.proposals ?? []).filter((proposal) => {
    const intent = selectionDraft.get(proposal.id);
    return intent && intent.selected !== (proposal.status === "accepted");
  });
  const removingSelected = selectionChanges.filter((proposal) => proposal.status === "accepted");
  function beginSelection() {
    setSelectionDraft(new Map());
    setBulkConfirmation(false);
    setSelecting(true);
  }
  function changeSelection(proposal: CandidateProposalDto, checked: boolean) {
    if (pending || proposal.status !== "pending" && !(proposal.status === "accepted" && proposal.acceptedTripPlaceId)) return;
    setBulkConfirmation(false);
    setSelectionDraft((previous) => {
      const next = new Map(previous);
      if (checked === (proposal.status === "accepted")) next.delete(proposal.id);
      else next.set(proposal.id, { proposal, selected: checked });
      return next;
    });
  }
  async function applySelection() {
    if (pending || !workspace) return;
    if (removingSelected.length && !bulkConfirmation) { setBulkConfirmation(true); return; }
    setBulkBusy(true);
    try {
      // Reuse versioned individual mutations; never claim an atomic bulk transaction.
      let current = workspace;
      for (const change of selectionChanges) {
        const proposal = current.proposals.find((candidate) => candidate.id === change.id);
        const intent = selectionDraft.get(change.id)!;
        if (!proposal || proposal.version !== intent.proposal.version || proposal.status !== intent.proposal.status || proposal.acceptedTripPlaceId !== intent.proposal.acceptedTripPlaceId) {
          setNotice({ area: "general", text: "地點資料已更新。請取消選擇，重新確認目前的名單。" });
          return;
        }
        const next = intent.selected ? await decideProposal(intent.proposal, "accept") : await removeAcceptedProposal(intent.proposal);
        if (!next) return;
        if ((next.proposals.find((candidate) => candidate.id === change.id)?.status === "accepted") !== intent.selected) {
          setNotice({ area: "general", text: "地點狀態已更新，這項變更尚未套用。請取消選擇並重新確認。" });
          return;
        }
        current = next;
      }
      setSelecting(false);
      setBulkConfirmation(false);
    } finally {
      setBulkBusy(false);
    }
  }
  return (
    <section className="pd-workspace pd-discovery" data-selecting={selecting ? "true" : undefined} aria-labelledby="ai-discovery-heading">
      <div className="pd-pagehead">
        <h2 id="ai-discovery-heading">{t.header.title}</h2>
        {selecting ? <div className="pd-row-actions"><span>已勾選 {(workspace?.proposals ?? []).filter(selectionChecked).length} 個</span><button className="pd-secondary" disabled={pending !== null} onClick={() => { setSelecting(false); setBulkConfirmation(false); }}>取消</button></div> : workspace?.latestRun ? <div className="pd-row-actions"><button className="pd-secondary" onClick={() => setResearchSettingsOpen(true)}>修改需求</button><button className="pd-secondary" disabled={pending !== null} onClick={beginSelection}>選擇</button></div> : null}
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
          <ResearchPanel first={!workspace?.latestRun} open={researchSettingsOpen} onClose={() => setResearchSettingsOpen(false)} footer={<button className="pd-primary" disabled={pending !== null || !briefDraft.trim()} onClick={() => void research(workspace?.latestRun ? "again" : "find")}><Search aria-hidden="true" className="size-4" />{researchLabel(workspace?.latestRun ? t.header.researchAgain : t.brief.findCandidates)}</button>}>
            <div className="mt-4 grid gap-5">
          <section className="rounded-panel bg-surface-subtle p-4 sm:p-5" aria-label={t.brief.areaLabel}>
            <label className="grid gap-2 font-bold">{t.brief.prompt}
              <textarea
                className="min-h-32 rounded-xl border bg-surface p-3 font-normal"
                value={briefDraft}
                onChange={(event) => setBriefDraft(event.target.value)}
                placeholder={t.brief.placeholder}
              />
            </label>
            {notice?.area === "find" || notice?.area === "again" ? <p className="mt-3 rounded-xl border border-accent-strong/30 bg-surface p-4 text-accent-strong" role="alert">{notice.text}</p> : null}
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
            </div>
          </ResearchPanel>

          {workspace?.proposals.length ? (
            <section className="order-2" aria-label={t.proposal.shortlistLabel}>
              <h3 className="sr-only">{t.proposal.shortlistTitle}</h3>
              <div className="pd-list mt-4" aria-label={t.proposal.shortlistLabel}>
                {workspace.proposals.map((proposal) => {
                  const firstSentence = proposal.recommendationSentences?.[0];
                  const firstTradeoff = proposal.tradeoffSentences !== null ? proposal.tradeoffSentences[0]?.text ?? null : proposal.tradeoffs[0] ?? null;
                  const numberedEvidence = new Map(proposal.evidence.map((item, index) => [item.id, { item, number: index + 1 }] as const));
                  const repeatedName = (proposalNameCounts.get(proposal.name) ?? 0) > 1;
                  return (
                    <article key={proposal.id} data-discovery-proposal={proposal.name} className="pd-row" aria-current={proposal.id === selectedProposalId ? "true" : undefined}
                      aria-label={repeatedName ? t.proposal.proposalAtAddress(proposal.name, proposal.address ?? t.proposal.unknownAddress) : t.proposal.ariaLabel(proposal.name)}
                      onClick={(event) => {
                        if (event.target instanceof Element && event.target.closest("button, a, input, label, textarea, select")) return;
                        if (selecting) changeSelection(proposal, !selectionChecked(proposal)); else openProposalDetail(proposal.id);
                      }}>
                      <div className="pd-row-main">
                        {selecting && (proposal.status === "pending" || proposal.status === "accepted" && proposal.acceptedTripPlaceId) ? <label className="pd-selection-check"><input type="checkbox" aria-label={`選擇 ${proposal.name}`} checked={selectionChecked(proposal)} disabled={pending !== null} onChange={(event) => changeSelection(proposal, event.target.checked)} /></label> : null}
                        <PlaceThumbnail photo={previews.photos.get(proposal.id)} loading={previews.loading} />
                        <div className="pd-row-copy">
                          <div className="pd-titleline"><button type="button" className="pd-titlebutton" disabled={selecting && pending !== null} data-proposal-detail-trigger={proposal.id} aria-label={selecting ? `選擇 ${proposal.name}` : t.proposal.viewDetail(proposal.name)} onClick={() => selecting ? changeSelection(proposal, !selectionChecked(proposal)) : openProposalDetail(proposal.id)}>{proposal.name}</button><span className="pd-chip">{proposal.category ?? t.placeType[proposal.type]}</span></div>
                          {proposal.endorsements.length ? <div className="pd-row-labels">{proposal.endorsements.map((endorsement) => <span key={endorsement} className="pd-state">{endorsementLabel(endorsement, t)}</span>)}</div> : null}
                          {repeatedName ? <p className="pd-row-note">{proposal.address ?? t.proposal.unknownAddress}</p> : null}
                          {firstSentence ? <p className="pd-row-note"><ClaimSentence sentence={firstSentence} numberedEvidence={numberedEvidence} t={t} /></p> : proposal.recommendationSentences === null ? <p className="pd-row-note">{proposal.recommendation}</p> : null}
                          {firstTradeoff ? <p className="pd-row-note">{firstTradeoff}</p> : null}
                          <PlacePhotoCredit photo={previews.photos.get(proposal.id)} />
                        </div>
                      </div>
                      {!selecting ? <div className="pd-row-bottom">
                        <div className="pd-row-actions">{proposalActions(proposal)}</div>
                        {proposal.status === "pending" && proposal.votingAvailable ? <VoteControl compact name={proposal.name} voters={proposal.voters} voteCount={proposal.voteCount} ownVote={proposal.ownVote} votingAvailable disabled={pending !== null} onChange={(voted) => void setProposalVote(proposal, voted)} /> : null}
                      </div> : null}
                    </article>
                  );
                })}
              </div>
            </section>
          ) : workspace?.latestRun ? <p className="order-2 rounded-panel border border-dashed p-5 text-center text-muted-foreground">{workspace.latestRun.shortfalls.length ? t.proposal.noneNew : t.proposal.nonePassed}</p> : null}
          {selecting ? <section className="pd-bulkbar" aria-label="套用所選地點">{notice?.area === "general" ? <p className="pd-notice" role="alert">{notice.text}</p> : null}{bulkConfirmation ? <p>將移除 {removingSelected.map((proposal) => proposal.name).join("、")}；票和天數安排會一起清除。</p> : null}<p>依序儲存；遇到錯誤會停止，已完成的變更會保留。</p><div className="pd-fixed-actions">{bulkConfirmation ? <button className="pd-secondary" disabled={pending !== null} onClick={() => setBulkConfirmation(false)}>返回選擇</button> : null}<button className="pd-primary" disabled={pending !== null || selectionChanges.length === 0} onClick={() => void applySelection()}>{bulkBusy ? "儲存中…" : `加入 ${selectionChanges.length - removingSelected.length}、移除 ${removingSelected.length} 個地點`}</button></div></section> : null}

          {selectedProposal ? (
            <PlaceDetailSheet open title={selectedProposal.name} titleRef={detailTitleRef} onClose={closeProposalDetail} footer={
              rejectConfirmation ? <div className="pd-confirm-footer"><p>{t.proposal.rejectConfirmTitle(rejectConfirmation.name)}</p><p>{t.proposal.rejectConfirmDescription}</p>{notice?.area === "general" ? <p role="alert">{notice.text}</p> : null}<div><button className="pd-secondary" disabled={pending !== null} onClick={() => setRejectConfirmation(null)}>{t.proposal.cancel}</button><button className="pd-danger-button" disabled={pending !== null} onClick={() => { const proposal = rejectConfirmation; void decideProposal(proposal, "reject").then((next) => { if (next) { setRejectConfirmation(null); closeProposalDetail(); } }); }}>{t.proposal.rejectConfirm}</button></div></div>
              : removeConfirmation ? <div className="pd-confirm-footer"><p>{tripPlacesT.workspace.confirmRemove(removeConfirmation.name)}</p>{notice?.area === "general" ? <p role="alert">{notice.text}</p> : null}<div><button className="pd-secondary" disabled={pending !== null} onClick={() => setRemoveConfirmation(null)}>保留地點</button><button className="pd-danger-button" disabled={pending !== null} onClick={() => void removeAcceptedProposal(removeConfirmation).then((removed) => { if (removed) closeProposalDetail(); })}>{tripPlacesT.workspace.remove}</button></div></div>
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

          {workspace?.latestRun?.shortfalls.length ? (
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
    </section>
  );
}
