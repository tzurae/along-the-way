import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Ban, CalendarCheck, CalendarPlus, Check, ChevronRight, ExternalLink, Images, MapPin, MapPinOff, Pencil, RotateCw, Search } from "lucide-react";

import {
  parseDiscoveryWorkspaceResponse,
  parseScheduleDiscoveryProposalsResponse,
  parseUpdateCandidateProposalVoteResponse,
  type CandidateProposalDto,
  type DiscoveryClaimSentenceDto,
  type DiscoveryEndorsement,
  type DiscoveryQuestionAnswerDto,
  type DiscoveryShortfallDto,
  type DiscoveryWorkspaceDto,
  type ScheduleDiscoveryProposalsInput,
  type ScheduleDiscoveryProposalsResponse,
  type UpdateCandidateProposalVoteResponse,
} from "@along-the-way/contracts/discovery";
import type { TripDto } from "@along-the-way/contracts/private-trips";
import { parseTripPlaceListResponse, type TripPlaceDto } from "@along-the-way/contracts/trip-places";
import { ApiRequestError } from "./api-error";
import { googleMapsPlaceUrl } from "./google-maps";
import { safeExternalUrl } from "./external-url";
import { useI18n, type Messages } from "./i18n";
import { notify } from "./AppToaster";
import { VoteControl, VoteVoters } from "./VoteControl";
import { ConflictPanel, useVersionConflict } from "./ConflictPanel";
import { PlaceDetailContent } from "./PlaceDetailContent";
import { usePlacePreviews, type PlaceDetailRequest, type PlaceDetailRequestOptions } from "./PlaceThumbnail";
import { PlaceListRow } from "./PlaceListRow";
import { PlaceListSkeleton } from "./PlaceListSkeleton";
import { canArrangeItinerary } from "./trip-permissions";
import { PlaceFilterBar, PlaceFilterEmpty, placeArea, usePlaceFilters } from "./PlaceFilters";
import { placeTypeFilterLabel } from "./locales/zh-TW/place-types";
import { FlipList } from "./FlipList";
import { PlaceDetailSheet } from "./PlaceDetailSheet";
import { SchedulePlacesSheet } from "./SchedulePlacesSheet";
import { SelectionBar } from "./SelectionBar";
import { useScheduleToast } from "./ScheduleToast";
import { assignPlacesToDay } from "./schedule-assignments";
import "./pocket-discovery.css";


interface DiscoveryWorkspaceProps {
  trip: TripDto;
  accountId: string;
  request: PlaceDetailRequest;
  photoRevision?: number;
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
type NoticeArea = "general" | "find" | "again" | "questions" | "decided";
type DetailFocusSection = "cautions";

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
        <span className="ml-1 whitespace-nowrap">
          {cited.map(({ item, number }) => {
            const href = safeExternalUrl(item.sourceUrl);
            const label = t.proposal.citationLabel(number, item.title);
            return href ? (
              <a
                key={item.id}
                // Inline citation: must not grow the text line (a 44px box pushed bullets apart);
                // padding plus the gap keeps it tappable without breaking the sentence.
                className="mr-1 inline-block px-1 align-baseline text-xs font-bold leading-none text-accent-strong underline"
                href={href}
                target="_blank"
                rel="noreferrer"
                aria-label={label}
              >
                [{number}]
              </a>
            ) : <span key={item.id} className="mr-1 inline-block px-1 text-xs font-bold" aria-label={label}>[{number}]</span>;
          })}
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


export function DiscoveryWorkspace({ trip, accountId, request, photoRevision = 0, placesRevision, onPlacesChanged }: DiscoveryWorkspaceProps) {
  const { locale, t: { discovery: t, schedule: scheduleT, tripPlaces: tripPlacesT } } = useI18n();
  const [workspace, setWorkspace] = useState<DiscoveryWorkspaceDto | null>(null);
  const photoRequest = useCallback(<T,>(url: string, options?: PlaceDetailRequestOptions): Promise<T> => request<T>(
    url,
    photoRevision === 0 ? options : { ...options, cache: "no-cache" },
  ), [photoRevision, request]);
  const [tripPlaces, setTripPlaces] = useState<TripPlaceDto[]>([]);
  const [briefDraft, setBriefDraft] = useState("");
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, QuestionDraft>>({});
  const [loading, setLoading] = useState(true);
  const [optimisticVotes, setOptimisticVotes] = useState<Record<string, { ownVote: boolean; voteCount: number }>>({});
  const [pendingProposalVotes, setPendingProposalVotes] = useState<Record<string, true>>({});
  const [voteAnnouncement, setVoteAnnouncement] = useState("");
  const [operationPending, setPending] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const pending = operationPending ?? (bulkBusy ? "schedule-selection" : null);
  const [selecting, setSelecting] = useState(false);
  const [selectedProposalIds, setSelectedProposalIds] = useState<Set<string>>(() => new Set());
  const [scheduleProposalIds, setScheduleProposalIds] = useState<string[]>([]);
  const [scheduleInitialDayId, setScheduleInitialDayId] = useState<string | null>(null);
  const [scheduleAllowUnscheduled, setScheduleAllowUnscheduled] = useState(false);
  const [scheduleFromDetail, setScheduleFromDetail] = useState(false);
  const [scheduleError, setScheduleError] = useState("");
  const [changedProposalIds, setChangedProposalIds] = useState<Set<string>>(() => new Set());
  const changedRowsTimer = useRef<number | null>(null);
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [detailFocusSection, setDetailFocusSection] = useState<DetailFocusSection | null>(null);
  const [proposalAnnouncement, setProposalAnnouncement] = useState("");
  const detailTitleRef = useRef<HTMLHeadingElement>(null);
  const detailReturnPosition = useRef<{ x: number; y: number } | null>(null);
  const [rejectConfirmation, setRejectConfirmation] = useState<CandidateProposalDto | null>(null);
  const [researchSettingsOpen, setResearchSettingsOpen] = useState(false);
  const scheduleToast = useScheduleToast();
  useEffect(() => () => {
    if (changedRowsTimer.current !== null) window.clearTimeout(changedRowsTimer.current);
  }, []);

  useEffect(() => {
    if (canArrangeItinerary(trip)) return;
    setSelecting(false);
    setSelectedProposalIds(new Set());
    setScheduleProposalIds([]);
    setScheduleInitialDayId(null);
    setScheduleAllowUnscheduled(false);
    setScheduleFromDetail(false);
    setScheduleError("");
    setRejectConfirmation(null);
  }, [trip.role]);

  function openProposalDetail(proposalId: string, focusSection: DetailFocusSection | null = null) {
    setDetailFocusSection(focusSection);
    if (proposalId === selectedProposalId) {
      window.requestAnimationFrame(() => {
        if (focusSection) {
          const heading = document.getElementById(focusSection);
          heading?.closest("details")?.setAttribute("open", "");
          heading?.focus();
        } else detailTitleRef.current?.focus();
      });
      return;
    }
    detailReturnPosition.current = { x: window.scrollX, y: window.scrollY };
    setRejectConfirmation(null);
    setSelectedProposalId(proposalId);
  }
  useEffect(() => {
    if (!selectedProposalId || !detailFocusSection) return;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const heading = document.getElementById(detailFocusSection);
      heading?.closest("details")?.setAttribute("open", "");
      heading?.focus();
    }));
  }, [detailFocusSection, selectedProposalId]);

  const retryKeys = useRef<RetryKeys>(new Map());
  const pendingProposalVoteIds = useRef(new Set<string>());
  const workspaceReadGeneration = useRef(0);
  const briefBase = useRef<DiscoveryWorkspaceDto["brief"]>(null);
  const answersBase = useRef<DiscoveryWorkspaceDto["brief"]>(null);
  const conflictLatest = useRef<DiscoveryWorkspaceDto | null>(null);
  const resolution = useVersionConflict<Record<string, unknown>>();
  const conflictAction = useRef<{ operation: string; path: string; payload: Record<string, unknown>; area: NoticeArea; after?: () => void; method?: "POST" | "PUT" } | null>(null);

  function closeProposalDetail() {
    const proposalId = selectedProposalId;
    const position = detailReturnPosition.current;
    detailReturnPosition.current = null;
    setSelectedProposalId(null);
    setDetailFocusSection(null);
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
  const apply = useCallback((value: unknown, inputs: "all" | "brief" | "questions" = "all") => {
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

  /** True once the editable brief/question drafts were filled from a server read. */
  const draftsInitialized = useRef(false);

  const load = useCallback(async () => {
    const generation = ++workspaceReadGeneration.current;
    setLoading(true);
    try {
      const [discovery, places] = await Promise.all([
        request<unknown>(`/api/trips/${trip.id}/discovery`),
        request<unknown>(`/api/trips/${trip.id}/trip-places`),
      ]);
      if (generation !== workspaceReadGeneration.current) return;
      apply(discovery);
      draftsInitialized.current = true;
      setTripPlaces(parseTripPlaceListResponse(places).tripPlaces);
    } catch (error) {
      if (generation === workspaceReadGeneration.current) {
        notify("error", errorMessage(error, t.errors.failed));
      }
    } finally {
      if (generation === workspaceReadGeneration.current) setLoading(false);
    }
  }, [apply, request, t.errors.failed, trip.id]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Re-reads projections without touching drafts the member is typing. It supersedes any read
   * still in flight; if that was the initial load, this read fills the drafts instead.
   */
  const refresh = useCallback(() => {
    const generation = ++workspaceReadGeneration.current;
    return Promise.all([
      request<unknown>(`/api/trips/${trip.id}/discovery`),
      request<unknown>(`/api/trips/${trip.id}/trip-places`),
    ]).then(([discovery, places]) => {
      if (generation !== workspaceReadGeneration.current) return;
      if (draftsInitialized.current) setWorkspace(parseDiscoveryWorkspaceResponse(discovery).discovery);
      else {
        apply(discovery);
        draftsInitialized.current = true;
      }
      setTripPlaces(parseTripPlaceListResponse(places).tripPlaces);
    }).catch((error: unknown) => {
      if (generation === workspaceReadGeneration.current) {
        notify("error", errorMessage(error, t.errors.failed));
      }
    }).finally(() => {
      // This read may supersede the initial load, which then skips clearing `loading`;
      // the latest read must clear it or the page stays on 「正在載入 AI 研究…」.
      if (generation === workspaceReadGeneration.current) setLoading(false);
    });
  }, [apply, request, t.errors.failed, trip.id]);

  // Place and member changes made in other tabs only refresh projections; unsaved brief
  // and question drafts typed here must survive them.
  const refreshSignal = `${placesRevision}:${trip.members.length}`;
  const lastRefreshSignal = useRef(refreshSignal);
  useEffect(() => {
    if (lastRefreshSignal.current === refreshSignal) return;
    lastRefreshSignal.current = refreshSignal;
    void refresh();
  }, [refreshSignal, refresh]);

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
    try {
      const next = apply(await request(path, {
        method: method ?? (operation === "save-brief" || operation === "save-questions" ? "PUT" : "POST"),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": retryKey(retryKeys.current, operation, payload),
          ...(conflictBase ? { "Conflict-Base-Version": String(conflictBase) } : {}),
        },
        body: JSON.stringify(payload),
      }), operation === "save-questions" ? "questions" : "all");
      clearRetryKey(retryKeys.current, operation);
      resolution.clear();
      after?.();
      return next;
    } catch (error) {
      if (operation === "save-brief" || operation === "save-questions") {
        const { expectedVersion, ...attempted } = payload;
        const base = operation === "save-brief"
          ? { originalText: briefBase.current?.originalText ?? "" }
          : { answers: answersBase.current?.questionAnswers ?? [] };
        try {
          const captured = await resolution.capture(error, { input: base, version: typeof expectedVersion === "number" ? expectedVersion : 1 }, attempted, async () => {
            const latest = parseDiscoveryWorkspaceResponse(await request(`/api/trips/${trip.id}/discovery`)).discovery;
            conflictLatest.current = latest;
            return latest.brief ? {
              input: operation === "save-brief" ? { originalText: latest.brief.originalText } : { answers: latest.brief.questionAnswers },
              version: latest.brief.version,
            } : null;
          });
          if (captured) { conflictAction.current = { operation, path, payload, area, after, method }; return; }
        } catch (failure) {
          notify("error", errorMessage(failure, t.errors.failed));
          return;
        }
      }
      if (shouldStartFreshRequest(error)) clearRetryKey(retryKeys.current, operation);
      notify("error", operation.startsWith("reject:")
        && error instanceof ApiRequestError
        && (error.code === "forbidden" || error.status === 403)
        ? t.errors.ownerOnly
        // Answers refused because the brief's questions changed: explain it in zh-TW, not "要求內容有誤".
        : operation === "save-questions" && error instanceof ApiRequestError && error.code === "validation_error"
          ? t.errors.questionsChanged
          : errorMessage(error, t.errors.failed));
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
      notify("error", t.errors.researchUnavailable(missing.join(t.services.separator)));
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

  async function rejectProposal(proposal: CandidateProposalDto) {
    return mutate(
      `reject:${proposal.id}`,
      `/api/trips/${trip.id}/discovery/proposals/${proposal.id}/reject`,
      { expectedVersion: proposal.version },
      "general",
    );
  }
  async function restoreProposal(decision: { proposalId: string; version: number }) {
    return mutate(
      `reject:restore:${decision.proposalId}`,
      `/api/trips/${trip.id}/discovery/proposals/${decision.proposalId}/restore`,
      { expectedVersion: decision.version },
      "decided",
    );
  }
  /**
   * Once an AI place is in the itinerary its votes live on that trip place, so the like on its
   * AI row reads and writes the trip place's vote (the proposal itself no longer takes votes).
   */
  const placeVoteBusy = useRef(new Set<string>());
  async function setAcceptedPlaceVote(placeId: string, voted: boolean) {
    if (placeVoteBusy.current.has(placeId)) return;
    placeVoteBusy.current.add(placeId);
    setTripPlaces((current) => current.map((place) => place.id === placeId ? {
      ...place,
      ownVote: voted,
      voteCount: Math.max(0, place.voteCount + (voted ? 1 : 0) - (place.ownVote ? 1 : 0)),
    } : place));
    try {
      await request(`/api/trips/${trip.id}/trip-places/${placeId}/vote`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ voted }),
      });
    } catch {
      notify("error", tripPlacesT.vote.updateFailed(tripPlacesById.get(placeId)?.name ?? ""));
    } finally {
      placeVoteBusy.current.delete(placeId);
      void refresh();
    }
  }

  async function setProposalVote(proposal: CandidateProposalDto, voted: boolean) {
    if (pendingProposalVoteIds.current.has(proposal.id)) return;
    pendingProposalVoteIds.current.add(proposal.id);
    const optimisticVote = {
      ownVote: voted,
      voteCount: Math.max(0, proposal.voteCount + (voted ? 1 : 0) - (proposal.ownVote ? 1 : 0)),
    };
    setOptimisticVotes((current) => ({ ...current, [proposal.id]: optimisticVote }));
    setPendingProposalVotes((current) => ({ ...current, [proposal.id]: true }));
    setVoteAnnouncement(tripPlacesT.vote.saving(proposal.name, voted));
    const operation = `vote:${proposal.id}`;
    const payload = { voted };
    try {
      const { proposal: updated } = await request<UpdateCandidateProposalVoteResponse>(
        `/api/trips/${trip.id}/discovery/proposals/${proposal.id}/vote`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": retryKey(retryKeys.current, operation, payload),
          },
          body: JSON.stringify(payload),
          parse: parseUpdateCandidateProposalVoteResponse,
        },
      );
      // Merge only the vote fields: a late vote response must not restore a status (pending) the
      // proposal has since left through accept/reject. The authoritative read that follows also
      // replaces any read this vote overlapped.
      setWorkspace((current) => current ? {
        ...current,
        proposals: current.proposals.map((candidate) => candidate.id === updated.id ? {
          ...candidate,
          voters: updated.voters,
          voteCount: updated.voteCount,
          ownVote: updated.ownVote,
          votingAvailable: updated.votingAvailable,
        } : candidate),
      } : current);
      void refresh();
      clearRetryKey(retryKeys.current, operation);
      setOptimisticVotes((current) => {
        const next = { ...current };
        delete next[proposal.id];
        return next;
      });
      setVoteAnnouncement(tripPlacesT.vote.saved(proposal.name, updated.voteCount));
    } catch {
      setOptimisticVotes((current) => {
        const next = { ...current };
        delete next[proposal.id];
        return next;
      });
      setVoteAnnouncement("");
      notify("error", tripPlacesT.vote.updateFailed(proposal.name));
    } finally {
      pendingProposalVoteIds.current.delete(proposal.id);
      setPendingProposalVotes((current) => {
        const next = { ...current };
        delete next[proposal.id];
        return next;
      });
    }
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
    request: photoRequest,
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
        photoRevision={photoRevision}
        request={photoRequest}
        // Sources are linked inline from each sentence ([1][2]…); a separate evidence list only repeated them.
        showArticle={false}
        focusHeadingId={detailFocusSection ?? undefined}
        interlude={<div className="pd-detail">
          <section className="pd-detail-section">
            <h3>推薦重點</h3>
            {proposal.recommendationSentences === null ? <p className="pd-reason-copy">{proposal.recommendation}</p> : null}
            {proposal.recommendationSentences?.length
              ? <ClaimSentenceList sentences={proposal.recommendationSentences} numberedEvidence={numberedEvidence} t={t} />
              : null}
            {/* 符合你的需求 only when it says more than the category chip already shows; 推薦來源 lives in 佐證與景點資訊. */}
            {proposal.matchedNeeds.some((need) => need !== proposal.category) ? (
              <p className="mt-3 text-sm text-muted-foreground">{t.proposal.fitLine(proposal.matchedNeeds)}</p>
            ) : null}
          </section>
          {hasTradeoffs || proposal.unknowns.length ? (
            <section className="pd-detail-section">
              <h3 id="cautions" tabIndex={-1}>需要注意</h3>
              {hasTradeoffs ? proposal.tradeoffSentences !== null
                ? <ClaimSentenceList sentences={proposal.tradeoffSentences} numberedEvidence={numberedEvidence} t={t} />
                : <ul className="list-disc pl-5 text-sm">{proposal.tradeoffs.map((item) => <li key={item}>{item}</li>)}</ul>
                : null}
              {proposal.unknowns.length ? <ul className="mt-2 list-disc pl-5 text-sm text-muted-foreground">{proposal.unknowns.map((item) => <li key={item}>{t.proposal.unknownPrefix(item)}</li>)}</ul> : null}
            </section>
          ) : null}
          <section className="pd-detail-section">
            <h3>地點</h3>
            <p className="text-sm">{proposal.address ?? t.proposal.unknownAddress}</p>
            <a className="pd-secondary mt-3" href={googleMapsPlaceUrl(proposal.name, proposal.providerPlaceId)} target="_blank" rel="noreferrer"><MapPin aria-hidden="true" className="size-4" />{t.proposal.viewPhotos}</a>
          </section>
          {proposal.status === "pending" && proposal.votingAvailable && proposal.voters.length > 0 ? <section className="pd-detail-section"><VoteVoters voters={proposal.voters} /></section> : null}
        </div>}
      />
    );
  }
  const tripPlacesById = new Map(tripPlaces.map((place) => [place.id, place]));
  // 「不要再推薦」 removes the proposal from the shortlist until the owner restores it under 「之前的決定」.
  const listedProposals = workspace?.proposals.filter((proposal) => proposal.status !== "rejected") ?? [];
  // Rejections from the latest run are hidden from the shortlist, so list them with earlier runs' decisions to undo.
  const decisions: { proposalId: string; name: string; status: "accepted" | "rejected"; decidedAt: string | null; version: number }[] = [
    ...(workspace?.proposals ?? []).filter((proposal) => proposal.status === "rejected")
      .map((proposal) => ({ proposalId: proposal.id, name: proposal.name, status: "rejected" as const, decidedAt: null, version: proposal.version })),
    ...(workspace?.decided ?? []),
  ];
  const acceptedPlaceFor = (proposal: CandidateProposalDto) =>
    proposal.acceptedTripPlaceId ? tripPlacesById.get(proposal.acceptedTripPlaceId) ?? null : null;
  // Filter by the coarse place type (景點、餐廳…): AI categories are free text and too varied for chips.
  const proposalFilters = usePlaceFilters(listedProposals.map((proposal) => {
    const place = acceptedPlaceFor(proposal);
    return {
      id: proposal.id,
      name: proposal.name,
      status: proposal.status === "pending" ? "待討論" : place?.assignedDayId ? "已排入行程" : "待排日期",
      typeLabel: placeTypeFilterLabel(proposal.type),
      area: placeArea(proposal.address),
      mine: proposal.status === "pending" ? proposal.ownVote : Boolean(place?.ownVote),
    };
  }), `along-the-way:place-filters:${accountId}:${trip.id}:discovery`);
  const filteredProposals = listedProposals.filter((proposal) => proposalFilters.visibleIds.has(proposal.id));
  /** Status label; an accepted proposal whose wishlist place is scheduled reads 「已加入行程」. */
  const proposalStatusLabel = (proposal: CandidateProposalDto, status: CandidateProposalDto["status"] = proposal.status) => {
    const place = status === "accepted" ? acceptedPlaceFor(proposal) : null;
    return place && place.assignedDayId !== null ? t.status.acceptedScheduled : t.status[status];
  };
  const proposalIsLocated = (proposal: CandidateProposalDto) => {
    const place = acceptedPlaceFor(proposal);
    return (place?.latitude ?? proposal.latitude) !== null && (place?.longitude ?? proposal.longitude) !== null;
  };
  const proposalDayId = (proposal: CandidateProposalDto) => acceptedPlaceFor(proposal)?.assignedDayId ?? null;
  const proposalCanBeSelected = (proposal: CandidateProposalDto) => {
    if (!canArrangeItinerary(trip) || !proposalIsLocated(proposal)) return false;
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
    if (!canArrangeItinerary(trip)) return;
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

  function openSchedule(
    ids: string[],
    initialDayId: string | null = null,
    allowUnscheduled = false,
    fromDetail = false,
  ) {
    if (!canArrangeItinerary(trip) || ids.length === 0) return;
    setScheduleProposalIds(ids);
    setScheduleInitialDayId(initialDayId);
    setScheduleAllowUnscheduled(allowUnscheduled);
    setScheduleFromDetail(fromDetail);
    setScheduleError("");
  }

  function openProposalSchedule(proposal: CandidateProposalDto) {
    if (!canArrangeItinerary(trip)) return;
    const dayId = proposalDayId(proposal);
    setSelectedProposalId(null);
    setRejectConfirmation(null);
    openSchedule([proposal.id], dayId, dayId !== null, true);
  }

  function closeSchedule() {
    if (bulkBusy) return;
    setScheduleProposalIds([]);
    setScheduleInitialDayId(null);
    setScheduleAllowUnscheduled(false);
    setScheduleFromDetail(false);
    setScheduleError("");
  }

  function scheduleRequestError(error: unknown) {
    if (error instanceof ApiRequestError) {
      return error.code === "forbidden" || error.status === 403
        ? t.errors.ownerOnly
        : t.scheduling.failed(error.message);
    }
    return t.scheduling.requestFailed;
  }

  async function scheduleProposalsAtomically(
    proposals: CandidateProposalDto[],
    dayId: string,
  ) {
    const payload: ScheduleDiscoveryProposalsInput = {
      tripDayId: dayId,
      proposals: proposals
        .map((proposal) => ({ proposalId: proposal.id, expectedVersion: proposal.version }))
        .sort((left, right) => left.proposalId.localeCompare(right.proposalId)),
    };
    const operation = `schedule-proposals:${dayId}:${payload.proposals.map((proposal) => proposal.proposalId).join(",")}`;
    const response = await request<ScheduleDiscoveryProposalsResponse>(
      `/api/trips/${trip.id}/discovery/proposals/schedule`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": retryKey(retryKeys.current, operation, payload),
        },
        body: JSON.stringify(payload),
        parse: parseScheduleDiscoveryProposalsResponse,
      },
    );
    clearRetryKey(retryKeys.current, operation);
    setWorkspace(response.discovery);
    return response.discovery;
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
    if (!canArrangeItinerary(trip)) {
      setScheduleError(t.errors.ownerOnly);
      return;
    }
    if (bulkBusy || scheduleProposalIds.length === 0 || !workspace) return;
    const proposalIds = [...scheduleProposalIds];
    const proposals = proposalIds.flatMap((proposalId) => {
      const proposal = workspace.proposals.find((candidate) => candidate.id === proposalId);
      return proposal ? [proposal] : [];
    });
    if (proposals.length !== proposalIds.length) {
      setScheduleError(t.scheduling.proposalChanged);
      return;
    }
    setBulkBusy(true);
    setScheduleError("");
    try {
      let nextWorkspace = workspace;
      const detailProposal = scheduleFromDetail && proposals.length === 1 ? proposals[0]! : null;
      if (detailProposal?.status === "accepted") {
        const place = acceptedPlaceFor(detailProposal);
        if (!place) {
          setScheduleError(t.scheduling.placeUnavailable);
          return;
        }
        const assigned = await assignPlacesToDay({
          request,
          tripId: trip.id,
          dayId,
          items: [{
            tripPlaceId: place.id,
            version: place.version,
            currentDayId: place.assignedDayId,
          }],
        });
        setTripPlaces(assigned.tripPlaces);
      } else {
        if (dayId === null) {
          setScheduleError(t.scheduling.proposalChanged);
          return;
        }
        nextWorkspace = await scheduleProposalsAtomically(proposals, dayId);
      }
      finishSchedule(proposalIds, nextWorkspace, dayId);
    } catch (error) {
      setScheduleError(scheduleRequestError(error));
    } finally {
      setBulkBusy(false);
    }
  }
  return (
    <section className="pd-workspace pd-discovery" data-selecting={selecting ? "true" : undefined} aria-labelledby="ai-discovery-heading">
      <div className={`pd-pagehead${selecting ? " pd-pagehead--selecting" : ""}`}>
        {selecting ? (
          <>
            <h2 id="ai-discovery-heading" className="schedule-page-title">{scheduleT.selectedCount(selectedProposalIds.size)}</h2>
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
          </>
        ) : (
          <>
            <div className="pd-pagehead-copy" data-compact-mobile={Boolean(workspace?.proposals.length) || undefined}>
              <h2 id="ai-discovery-heading" className="schedule-page-title" aria-label={t.header.title}>
                <span className="pd-pagehead-title--full" aria-hidden="true">{t.header.title}</span>
                <span className="pd-pagehead-title--compact" aria-hidden="true">{t.header.compactTitle(listedProposals.length)}</span>
              </h2>
              <p>{t.header.description}</p>
            </div>
            <div className="schedule-head-buttons">
              {canArrangeItinerary(trip) && hasSelectableProposals ? (
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
          </>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite">{proposalAnnouncement}</p>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{voteAnnouncement}</p>
      {!canArrangeItinerary(trip) ? <p className="pd-subhead">{t.header.ownerSchedulingOnly}</p> : null}
      {resolution.conflict ? <ConflictPanel conflict={resolution.conflict} busy={pending !== null}
        onAccept={() => {
          const operation = conflictAction.current?.operation;
          if (conflictLatest.current && operation === "save-brief") {
            apply({ discovery: conflictLatest.current }, "brief");
          } else if (conflictLatest.current && operation === "save-questions") {
            apply({ discovery: conflictLatest.current }, "questions");
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
          resolution.resume();
        }}
      /> : null}

      {loading ? <PlaceListSkeleton label={t.header.loading} className="mt-6" /> : null}

      {!loading ? (
        <div hidden={Boolean(resolution.conflict)} className="grid gap-5">
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

          {listedProposals.length ? (
            <section className="order-2" aria-label={t.proposal.shortlistLabel}>
              <h3 className="sr-only">{t.proposal.shortlistTitle}</h3>
              {listedProposals.length > 1 ? <PlaceFilterBar filters={proposalFilters} total={listedProposals.length} label="搜尋 AI 建議" /> : null}
              {filteredProposals.length === 0 ? <PlaceFilterEmpty onClear={proposalFilters.clear} /> : (
              <FlipList className="pd-list" ariaLabel={t.proposal.shortlistLabel}>
                {/* Same order as 口袋名單: most confirmed votes first (stable). Confirmed counts, not the
                    optimistic overlay, so a tapped row does not jump before the server confirms. */}
                {[...filteredProposals].sort((left, right) => right.voteCount - left.voteCount).map((proposal) => {
                  const firstSentence = proposal.recommendationSentences?.[0];
                  const repeatedName = (proposalNameCounts.get(proposal.name) ?? 0) > 1;
                  const selectable = proposalCanBeSelected(proposal);
                  const selected = selectedProposalIds.has(proposal.id);
                  const assignedDayId = proposalDayId(proposal);
                  const selectionLabel = scheduleT.selectPlace(proposal.name);
                  const preview = previews.previews.get(proposal.id);
                  const state = selecting
                    ? selected ? "selected" : selectable ? "selectable" : "selecting"
                    : "default";
                  const selectionControl = selecting && selectable ? (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={selected}
                      aria-label={selectionLabel}
                      className="schedule-selection-check"
                      disabled={pending !== null}
                      onClick={() => changeSelection(proposal, !selected)}
                    >
                      <Check aria-hidden="true" size={16} strokeWidth={3} />
                    </button>
                  ) : undefined;
                  const displayStatus: CandidateProposalDto["status"] = proposal.status;
                  const evidenceLabel = proposal.evidence.some((item) => item.isStale)
                    ? t.proposal.rowEvidenceStale
                    : proposal.evidence.length > 0
                      ? t.proposal.rowEvidenceCount(proposal.evidence.length)
                      : proposal.recommendationSentences === null
                        ? t.proposal.rowLegacyEvidence
                        : t.proposal.rowInference;
                  const tradeoffs = proposal.tradeoffSentences !== null
                    ? proposal.tradeoffSentences.map((sentence) => sentence.text)
                    : proposal.tradeoffs;
                  const caution = proposal.unknowns[0]
                    ? t.proposal.unknownPrefix(proposal.unknowns[0])
                    : tradeoffs[0]
                      ? t.proposal.tradeoffPrefix(tradeoffs[0])
                      : null;
                  const cautionCount = proposal.unknowns.length + tradeoffs.length;
                  const optimisticVote = optimisticVotes[proposal.id];
                  const votePending = Boolean(pendingProposalVotes[proposal.id]);
                  const voteAction = proposal.status === "pending" ? (
                    <VoteControl
                      compact
                      name={proposal.name}
                      voters={proposal.voters}
                      voteCount={optimisticVote?.voteCount ?? proposal.voteCount}
                      ownVote={optimisticVote?.ownVote ?? proposal.ownVote}
                      votingAvailable={proposal.votingAvailable}
                      disabled={votePending}
                      busy={votePending}
                      onChange={(voted) => void setProposalVote(proposal, voted)}
                    />
                  ) : acceptedPlaceFor(proposal) ? (
                    // In the itinerary: the like is the trip place's own vote.
                    <VoteControl
                      compact
                      name={proposal.name}
                      voters={acceptedPlaceFor(proposal)!.voters}
                      voteCount={acceptedPlaceFor(proposal)!.voteCount}
                      ownVote={acceptedPlaceFor(proposal)!.ownVote}
                      votingAvailable={acceptedPlaceFor(proposal)!.votingAvailable}
                      disabled={false}
                      onChange={(voted) => void setAcceptedPlaceVote(acceptedPlaceFor(proposal)!.id, voted)}
                    />
                  ) : undefined;
                  // AI 建議 only go into the itinerary (排入行程); 口袋名單 is for places members add themselves.
                  const acceptedPlace = proposal.status === "accepted" ? acceptedPlaceFor(proposal) : null;
                  // Pending: put it into the itinerary. Accepted but no day yet: pick its day.
                  const canScheduleRow = canArrangeItinerary(trip) && proposalIsLocated(proposal)
                    && (proposal.status === "pending" || Boolean(acceptedPlace && acceptedPlace.assignedDayId === null));
                  const canDecline = proposal.status === "pending" && trip.role === "owner";
                  const rowActions = canScheduleRow || canDecline ? (
                    <>
                      {canDecline ? (
                        <button
                          type="button"
                          className="pd-danger-link"
                          disabled={pending !== null}
                          onClick={() => {
                            openProposalDetail(proposal.id);
                            setRejectConfirmation(proposal);
                          }}
                        >
                          <Ban aria-hidden="true" className="size-4" />
                          {t.proposal.decline}
                        </button>
                      ) : null}
                      {canScheduleRow ? (
                        <button
                          type="button"
                          className="pd-primary"
                          disabled={pending !== null}
                          onClick={() => openProposalSchedule(proposal)}
                        >
                          <CalendarPlus aria-hidden="true" className="size-4" />
                          {proposal.status === "pending" ? scheduleT.pageAction : t.proposal.pickDay}
                        </button>
                      ) : null}
                    </>
                  ) : undefined;
                  return (
                    <PlaceListRow
                      key={proposal.id}
                      variant="proposal"
                      name={proposal.name}
                      typeLabel={t.placeType[proposal.type]}
                      placeType={proposal.type}
                      stateLabel={proposalStatusLabel(proposal, displayStatus)}
                      secondary={firstSentence?.text ?? proposal.recommendation}
                      evidence={<span>{evidenceLabel}</span>}
                      caution={caution ?? undefined}
                      cautionAction={caution && cautionCount > 1 ? <span className="list-place-row__caution-action">・<button type="button" className="list-place-row__inline-action" onClick={() => openProposalDetail(proposal.id, "cautions")}>{t.proposal.moreItems(cautionCount - 1)}</button></span> : undefined}
                      photo={preview?.photo}
                      photoCount={preview?.photoCount ?? 0}
                      loadingPhoto={previews.loading}
                      voteAction={voteAction}
                      rowActions={rowActions}
                      selectionControl={selectionControl}
                      ariaLabel={repeatedName ? t.proposal.proposalAtAddress(proposal.name, proposal.address ?? t.proposal.unknownAddress) : t.proposal.ariaLabel(proposal.name)}
                      current={!selecting && proposal.id === selectedProposalId}
                      state={state}
                      scheduled={Boolean(assignedDayId)}
                      changed={!selecting && changedProposalIds.has(proposal.id)}
                      onOpen={() => openProposalDetail(proposal.id)}
                      onActivate={() => {
                        if (selecting) changeSelection(proposal, !selected);
                        else openProposalDetail(proposal.id);
                      }}
                      openLabel={t.proposal.viewDetail(proposal.name)}
                      openDataAttribute={{ name: "proposal-detail-trigger", value: proposal.id }}
                      dataAttribute={{ name: "discovery-proposal", value: proposal.name }}
                    />
                  );
                })}
              </FlipList>
              )}
            </section>
          ) : workspace?.proposals.length ? null : workspace?.latestRun?.status === "completed" ? <p className="order-2 rounded-panel border border-dashed p-5 text-center text-muted-foreground">{workspace.latestRun.shortfalls.length ? t.proposal.noneNew : t.proposal.nonePassed}</p> : null}

          {selectedProposal ? (
            <PlaceDetailSheet
              open
              appearance="workspace"
              title={selectedProposal.name}
              description={<div className="pd-detail-badges">
                <span className="pd-chip">{t.placeType[selectedProposal.type]}</span>
                {proposalDayId(selectedProposal) ? (
                  <span className="schedule-status-pill">
                    <CalendarCheck aria-hidden="true" className="size-[15px]" />
                    {scheduleT.scheduledOn(formatScheduledDay(proposalDayId(selectedProposal)!))}
                  </span>
                ) : selectedProposal.status === "rejected" ? <span className="pd-state">{t.status.rejected}</span> : null}
              </div>}
              titleRef={detailTitleRef}
              onClose={closeProposalDetail}
              footer={rejectConfirmation && trip.role === "owner" ? (
                <div className="pd-confirm-footer">
                  <p>{t.proposal.rejectConfirmTitle(rejectConfirmation.name)}</p>
                  <p>{t.proposal.rejectConfirmDescription}</p>
                  <div>
                    <button className="pd-secondary" disabled={pending !== null} onClick={() => setRejectConfirmation(null)}>{t.proposal.cancel}</button>
                    <button className="pd-danger-button" disabled={pending !== null} onClick={() => {
                      const proposal = rejectConfirmation;
                      void rejectProposal(proposal).then((next) => {
                        if (next) {
                          setRejectConfirmation(null);
                          closeProposalDetail();
                        }
                      });
                    }}>{t.proposal.rejectConfirm}</button>
                  </div>
                </div>
              ) : undefined}
            >
              {proposalDetail(selectedProposal)}
            </PlaceDetailSheet>
          ) : null}


          {decisions.length ? (
            <section className="order-4 rounded-panel border border-ink/10 p-4" aria-label={t.decided.areaLabel}>
              <h3 className="font-display text-2xl">{t.decided.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t.decided.description}</p>
              <ul className="mt-3 grid gap-2">{decisions.map((decision) => <li key={decision.proposalId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-subtle p-3"><strong>{decision.name}</strong><span className="flex items-center gap-2 text-sm">{decision.status === "accepted" ? t.decided.accepted : t.decided.rejected}{decision.decidedAt ? `・${t.decided.decidedAt(new Date(decision.decidedAt).toLocaleDateString(locale))}` : null}{decision.status === "rejected" && trip.role === "owner" ? <button type="button" className="pd-secondary" disabled={pending !== null} aria-label={t.decided.restoreLabel(decision.name)} onClick={() => void restoreProposal(decision)}>{t.decided.restore}</button> : null}</span></li>)}</ul>
            </section>
          ) : null}

          {workspace?.latestRun?.status === "completed" && workspace.latestRun.shortfalls.length ? (
            <section className="order-4 rounded-panel border border-ink/10 p-4" aria-label={t.missing.areaLabel}>
              <h3 className="font-display text-2xl">{t.missing.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{t.missing.description}</p>
              <ul className="mt-3 grid gap-2">{workspace.latestRun.shortfalls.map((shortfall) => <li key={`${shortfall.code}:${shortfall.subject}`} className="rounded-lg bg-surface-subtle p-3"><strong>{shortfall.subject}</strong>{shortfall.named ? <span className="ml-2 text-xs font-bold uppercase tracking-[0.12em] text-accent-strong">{t.missing.requested}</span> : null}<span className="block text-sm">{shortfallText(shortfall, t)}</span></li>)}</ul>
            </section>
          ) : null}

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
