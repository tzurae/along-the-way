import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, Ban, CalendarCheck, CalendarPlus, Check, ChevronRight, ExternalLink, Images, MapPin, MapPinOff, Pencil, Search } from "lucide-react";

import {
  parseDiscoveryWorkspaceResponse,
  parseScheduleDiscoveryProposalsResponse,
  parseUpdateCandidateProposalVoteResponse,
  type CandidateProposalDto,
  type DiscoveryClaimSentenceDto,
  type DiscoveryEndorsement,
  type DiscoveryJobDto,
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
import { ClarifyChecklist, ResearchBatch, ThinkingIndicator, clarifyAnswers, clarifyDrafts, clarifySummary, focusDiscoveryBatch, prefersReducedMotion, type ClarifyDraft } from "./DiscoveryInvestigate";
import { discoveryJobActive } from "./useDiscoveryJob";
import "./pocket-discovery.css";


interface DiscoveryWorkspaceProps {
  trip: TripDto;
  accountId: string;
  request: PlaceDetailRequest;
  photoRevision?: number;
  placesRevision: number;
  onPlacesChanged(): void;
  /** The trip's newest 調查 job, followed by the trip shell even while this page is hidden. */
  job: DiscoveryJobDto | null;
  /** Hands a job this page queued (or found running) to the trip shell to follow. */
  onJobStarted(job: DiscoveryJobDto | null): void;
}

type RetryKeys = Map<string, { fingerprint: string; key: string }>;
/** Below this many places the shortlist is read at a glance, so search and filter chips stay hidden. */
const FILTER_MIN_PLACES = 8;

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
    case "interrupted":
      return t.runFailure.interrupted;
    case "expired":
      return t.runFailure.expired;
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


function ResearchPanel({ first, open, onClose, children, footer }: { first: boolean; open: boolean; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  if (first) return <section className="order-3 pd-first-run">{children}{footer}</section>;
  return <PlaceDetailSheet appearance="workspace" open={open} title="你的需求" onClose={onClose} footer={footer}>{children}</PlaceDetailSheet>;
}


export function DiscoveryWorkspace({ trip, accountId, request, photoRevision = 0, placesRevision, onPlacesChanged, job, onJobStarted }: DiscoveryWorkspaceProps) {
  const { locale, t: { discovery: t, schedule: scheduleT, tripPlaces: tripPlacesT } } = useI18n();
  const [workspace, setWorkspace] = useState<DiscoveryWorkspaceDto | null>(null);
  const photoRequest = useCallback(<T,>(url: string, options?: PlaceDetailRequestOptions): Promise<T> => request<T>(
    url,
    photoRevision === 0 ? options : { ...options, cache: "no-cache" },
  ), [photoRevision, request]);
  const [tripPlaces, setTripPlaces] = useState<TripPlaceDto[]>([]);
  const [briefDraft, setBriefDraft] = useState("");
  const [draftState, setDraftState] = useState<{ briefVersion: number | null; items: Record<string, ClarifyDraft> }>({ briefVersion: null, items: {} });
  // Drafts belong to one checklist. Ids are positional (q1…q5), so a newer brief's questions start
  // from the server's answers instead of inheriting answers typed for different questions.
  const serverDrafts = clarifyDrafts(workspace?.clarification ?? null);
  const drafts: Record<string, ClarifyDraft> = draftState.briefVersion === (workspace?.clarification?.briefVersion ?? null)
    ? Object.fromEntries(Object.entries(serverDrafts).map(([id, draft]) => [id, draftState.items[id] ?? draft]))
    : serverDrafts;
  /** The whole 調查 chain (save brief → questions → review → queue) is one busy period. */
  const [investigating, setInvestigating] = useState(false);
  /** While the checklist is up the request shows as one line; 編輯 reopens the text. */
  const [briefOpen, setBriefOpen] = useState(false);
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
  /**
   * "all" re-fills the brief and checklist drafts from the server (initial load and the 調查
   * steps); "brief" only the brief; "projection" neither, so a vote or decision never erases
   * what the member is typing.
   */
  const apply = useCallback((value: unknown, inputs: "all" | "brief" | "projection" = "all") => {
    const next = parseDiscoveryWorkspaceResponse(value).discovery;
    setWorkspace(next);
    if (inputs === "projection") return next;
    briefBase.current = next.brief;
    setBriefDraft(next.brief?.originalText ?? "");
    if (inputs === "all") setDraftState({ briefVersion: next.clarification?.briefVersion ?? null, items: clarifyDrafts(next.clarification) });
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
        method: method ?? (operation === "save-brief" ? "PUT" : "POST"),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": retryKey(retryKeys.current, operation, payload),
          ...(conflictBase ? { "Conflict-Base-Version": String(conflictBase) } : {}),
        },
        body: JSON.stringify(payload),
      }), ["save-brief", "clarify", "answer", "research"].includes(operation) ? "all" : "projection");
      clearRetryKey(retryKeys.current, operation);
      resolution.clear();
      after?.();
      return next;
    } catch (error) {
      if (operation === "save-brief") {
        const { expectedVersion, ...attempted } = payload;
        const base = { originalText: briefBase.current?.originalText ?? "" };
        try {
          const captured = await resolution.capture(error, { input: base, version: typeof expectedVersion === "number" ? expectedVersion : 1 }, attempted, async () => {
            const latest = parseDiscoveryWorkspaceResponse(await request(`/api/trips/${trip.id}/discovery`)).discovery;
            conflictLatest.current = latest;
            return latest.brief ? {
              input: { originalText: latest.brief.originalText },
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
      // The checklist moved on (another member answered, or a newer brief): re-read it; drafts stay.
      if (operation === "answer" && error instanceof ApiRequestError && error.status === 409) void refresh();
      notify("error", operation.startsWith("reject:")
        && error instanceof ApiRequestError
        && (error.code === "forbidden" || error.status === 403)
        ? t.errors.ownerOnly
        : error instanceof ApiRequestError && error.code === "clarification_incomplete"
          ? t.errors.clarifyIncomplete
          : errorMessage(error, t.errors.failed));
    } finally {
      setPending(null);
    }
  }

  // 調查: save changed brief text, have the AI draft its checklist, send the answers to the
  // reviewer, and queue research once every required answer is accepted. Each click advances
  // as far as it can; questions or ask-backs stop it until the member answers.
  async function investigate() {
    if (pending || investigating || !workspace || discoveryJobActive(job)) return;
    const missing = missingServices(workspace, true, t);
    if (missing.length > 0) {
      notify("error", t.errors.researchUnavailable(missing.join(t.services.separator)));
      return;
    }
    setInvestigating(true);
    try {
      let current = workspace;
      if (!current.brief || !briefBase.current || briefBase.current.originalText !== briefDraft) {
        const saved = await mutate("save-brief", `/api/trips/${trip.id}/discovery/brief`, {
          originalText: briefDraft,
          expectedVersion: briefBase.current?.version ?? null,
        }, "find");
        if (!saved?.brief) return;
        current = saved;
      }
      const brief = current.brief;
      if (!brief) return;
      const clarification = current.clarification?.briefVersion === brief.version ? current.clarification : null;
      if (!clarification) {
        const asked = await mutate("clarify", `/api/trips/${trip.id}/discovery/clarification`, {
          expectedBriefVersion: brief.version,
        }, "find");
        setBriefOpen(false);
        // With questions the member answers first, in the dialog (also when 重新調查 started this
        // from the page); with none, research starts right away.
        if (asked?.clarification?.status !== "ready") {
          if (asked?.clarification) setResearchSettingsOpen(true);
          return;
        }
      } else if (clarification.status !== "ready" || clarifySummary(clarification, drafts).changed) {
        const answered = await mutate("answer", `/api/trips/${trip.id}/discovery/clarification/answers`, {
          expectedVersion: clarification.version,
          answers: clarifyAnswers(clarification, drafts),
        }, "find", undefined, "PUT");
        if (!answered?.clarification) return;
        if (answered.clarification.status !== "ready") {
          setResearchSettingsOpen(true);
          const first = answered.clarification.items.find((item) => item.required
            && (item.verdict === "insufficient" || item.verdict === "unreasonable"));
          if (first) window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            const target = document.querySelector<HTMLElement>(`[data-clarify-item="${first.id}"]`);
            target?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
            target?.querySelector<HTMLElement>("input")?.focus({ preventScroll: true });
          }));
          return;
        }
      }
      const started = await mutate("research", `/api/trips/${trip.id}/discovery/research`, {
        expectedBriefVersion: brief.version,
      }, "find");
      if (!started) return;
      onJobStarted(started.latestJob);
      // The dialog closes at once; the batch at the top of the list carries the progress from here.
      setResearchSettingsOpen(false);
      focusDiscoveryBatch();
    } finally {
      setInvestigating(false);
    }
  }

  // A job someone else queued (or one still running after a reload) is followed by the trip shell,
  // unless the shell already follows that job or a newer one.
  const workspaceJob = workspace?.latestJob ?? null;
  const followedJobCreatedAt = job?.createdAt ?? null;
  useEffect(() => {
    if (!workspaceJob || !discoveryJobActive(workspaceJob)) return;
    if (followedJobCreatedAt !== null && Date.parse(workspaceJob.createdAt) <= Date.parse(followedJobCreatedAt)) return;
    onJobStarted(workspaceJob);
  }, [followedJobCreatedAt, onJobStarted, workspaceJob]);

  // The list changes once the save stage finishes: re-read it then, and keep the new rows'
  // thumbnails loading while the photos stage looks for Commons photos. Only jobs seen before
  // their save finished count; a job that finished earlier is already in the first read.
  const unsavedJobIds = useRef(new Set<string>());
  const refreshedJobIds = useRef(new Set<string>());
  const jobId = job?.id ?? null;
  const jobSaved = job?.stages.save.state === "done";
  useEffect(() => {
    if (!jobId) return;
    if (!jobSaved) {
      unsavedJobIds.current.add(jobId);
      return;
    }
    if (!unsavedJobIds.current.has(jobId) || refreshedJobIds.current.has(jobId)) return;
    refreshedJobIds.current.add(jobId);
    void refresh();
    setPhotosExpectedUntil(Date.now() + 120_000);
  }, [jobId, jobSaved, refresh]);
  // A successful run uses up its checklist on the server; re-read once it finishes so 你的需求
  // starts from fresh questions instead of the answered ones still held here. Only for jobs seen
  // unfinished here: a run that finished earlier is already reflected in the first read.
  const jobFinished = job?.status === "succeeded";
  const unfinishedJobIds = useRef(new Set<string>());
  useEffect(() => {
    if (!jobId) return;
    if (!jobFinished) {
      unfinishedJobIds.current.add(jobId);
      return;
    }
    if (!unfinishedJobIds.current.delete(jobId)) return;
    void refresh();
  }, [jobId, jobFinished, refresh]);

  // 本次新增: the newest job stays at the top of the list, from its first stage to the places it
  // found, until the member collapses it. A job counts once it was seen running or its result
  // was not yet seen; a result already seen elsewhere does not come back on the next visit.
  const shownJob = job ?? workspace?.latestJob ?? null;
  const jobRunning = discoveryJobActive(shownJob);
  const [watchedJobId, setWatchedJobId] = useState<string | null>(null);
  const [dismissedJobId, setDismissedJobId] = useState<string | null>(null);
  const shownJobId = shownJob?.id ?? null;
  const shownJobUnseen = Boolean(shownJob && (jobRunning || !shownJob.acknowledged));
  useEffect(() => {
    if (shownJobId && shownJobUnseen) setWatchedJobId(shownJobId);
  }, [shownJobId, shownJobUnseen]);


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

  const selectedProposal = workspace?.proposals.find((proposal) => proposal.id === selectedProposalId) ?? null;
  const proposalNameCounts = new Map<string, number>();
  for (const proposal of workspace?.proposals ?? []) {
    proposalNameCounts.set(proposal.name, (proposalNameCounts.get(proposal.name) ?? 0) + 1);
  }
  const [photosExpectedUntil, setPhotosExpectedUntil] = useState<number | null>(null);
  const previews = usePlacePreviews({
    tripId: trip.id,
    kind: "proposal",
    ids: workspace?.proposals.map((proposal) => proposal.id) ?? [],
    request: photoRequest,
    waitForPhotosUntil: photosExpectedUntil,
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
  const batchJob = shownJob && shownJob.id !== dismissedJobId && (jobRunning || watchedJobId === shownJob.id) ? shownJob : null;
  // Only a workspace read made after this job's save stage has its run as the latest run; an
  // earlier read would put the previous run's places in this batch.
  const batchRunId = batchJob && workspace?.latestJob?.id === batchJob.id && workspace.latestJob.stages.save.state === "done"
    ? workspace.latestRun?.id ?? null : null;
  const batchProposals = batchRunId ? listedProposals.filter((proposal) => proposal.runId === batchRunId) : [];
  const batchProposalIds = new Set(batchProposals.map((proposal) => proposal.id));
  const restProposals = listedProposals.filter((proposal) => !batchProposalIds.has(proposal.id));
  // Filter by the coarse place type (景點、餐廳…): AI categories are free text and too varied for chips.
  const proposalFilters = usePlaceFilters(restProposals.map((proposal) => {
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
  // A short list is read at a glance; search and chips only help once it gets long. Remembered
  // filters do not apply while the bar is hidden, or rows would vanish with no way to clear them.
  const filtersShown = restProposals.length >= FILTER_MIN_PLACES;
  const visibleRestProposals = filtersShown
    ? restProposals.filter((proposal) => proposalFilters.visibleIds.has(proposal.id))
    : restProposals;
  // Filters remembered from a longer list would hide rows the moment the list grows back, with
  // chips the member never chose; a hidden bar forgets them.
  const filtersActive = proposalFilters.active;
  const clearFilters = proposalFilters.clear;
  // Not before the first read: an empty list while loading is not a short list.
  const listLoaded = workspace !== null;
  useEffect(() => {
    if (listLoaded && !filtersShown && filtersActive) clearFilters();
  }, [clearFilters, filtersActive, filtersShown, listLoaded]);
  // Opening 你的需求 again starts from the one-line summary while questions are up.
  useEffect(() => {
    if (researchSettingsOpen) setBriefOpen(false);
  }, [researchSettingsOpen]);
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

  /** One shortlist row; `fresh` marks a place the newest 調查 just added (shown in its batch). */
  function renderProposalRow(proposal: CandidateProposalDto, fresh = false) {
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
        stateLabel={fresh && proposal.status === "pending" ? t.run.fresh : proposalStatusLabel(proposal, displayStatus)}
        secondary={firstSentence?.text ?? proposal.recommendation}
        caution={caution ?? undefined}
        cautionAction={caution && cautionCount > 1 ? <span className="list-place-row__caution-action">・<button type="button" className="list-place-row__inline-action" onClick={() => openProposalDetail(proposal.id, "cautions")}>{t.proposal.moreItems(cautionCount - 1)}</button></span> : undefined}
        photo={preview?.photo}
        photoCount={preview?.photoCount ?? 0}
        loadingPhoto={previews.loading || (previews.waiting && !preview?.photo)}
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
  }

  const busy = investigating || jobRunning;
  // An edited brief makes the checklist stale: the next step saves it and asks again.
  const briefDirty = !briefBase.current || briefBase.current.originalText !== briefDraft;
  const clarification = !briefDirty && workspace?.clarification && workspace.clarification.briefVersion === workspace.brief?.version
    ? workspace.clarification : null;
  const summary = clarification ? clarifySummary(clarification, drafts) : null;
  const thinking = pending === "save-brief" || pending === "clarify" ? t.clarify.askingThinking
    : pending === "answer" ? t.clarify.reviewingThinking : null;
  const requiredLeft = summary ? summary.requiredTotal - summary.requiredAnswered : 0;
  const statusText = !clarification || clarification.items.length === 0 ? null
    : summary && summary.askBack > 0 ? t.clarify.askBack(summary.askBack)
      : summary && summary.requiredTotal > 0 && requiredLeft > 0 ? t.clarify.progress(summary.requiredAnswered, summary.requiredTotal)
        : t.clarify.costNote;
  // One label per step: ask for questions, finish the required ones, then start.
  const investigateLabel = investigating ? t.thinkingButton
    : jobRunning ? t.searchingButton
      : !clarification ? t.clarify.askFirst
        : requiredLeft > 0 ? t.clarify.requiredLeft(requiredLeft)
          : t.clarify.start;
  const investigateButton = (
    <button
      className="pd-primary"
      disabled={busy || pending !== null || !briefDraft.trim() || requiredLeft > 0}
      aria-busy={busy || undefined}
      onClick={() => void investigate()}
    >
      {busy ? <span className="pd-thinking-dots" aria-hidden="true"><i /><i /><i /></span>
        : clarification ? <Search aria-hidden="true" className="size-4" /> : <ArrowRight aria-hidden="true" className="size-4" />}
      {investigateLabel}
    </button>
  );
  const briefCollapsed = clarification !== null && clarification.items.length > 0 && !briefOpen;
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
                <button className="schedule-secondary-button" disabled={busy} onClick={() => setResearchSettingsOpen(true)}>
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
          resolution.resume();
        }}
      /> : null}

      {loading ? <PlaceListSkeleton label={t.header.loading} className="mt-6" /> : null}

      {!loading ? (
        <div hidden={Boolean(resolution.conflict)} className="grid gap-5">
          <ResearchPanel
            first={!workspace?.latestRun}
            open={researchSettingsOpen}
            onClose={() => setResearchSettingsOpen(false)}
            footer={(
              <div className="pd-research-footer">
                <span role="status" aria-live="polite">{thinking ? <ThinkingIndicator text={thinking} /> : statusText}</span>
                {investigateButton}
              </div>
            )}
          >
            <div className="pd-brief-editor">
              <section aria-label={t.brief.areaLabel}>
                {briefCollapsed ? (
                  // While answering, the request shrinks to one line; 編輯 brings the text back.
                  <div className="pd-brief-summary">
                    <span className="pd-brief-summary-label">{t.clarify.briefSummary}</span>
                    <span className="pd-brief-summary-text">{briefDraft}</span>
                    <button type="button" className="pd-batch-link" disabled={busy} onClick={() => setBriefOpen(true)}>{t.clarify.editBrief}</button>
                  </div>
                ) : (
                  <>
                    <label className="grid gap-2 font-bold">{t.brief.prompt}
                      <textarea
                        className="min-h-32 rounded-xl border bg-surface p-3 font-normal"
                        value={briefDraft}
                        readOnly={busy}
                        onChange={(event) => setBriefDraft(event.target.value)}
                        placeholder={t.brief.placeholder}
                      />
                    </label>
                    <p className="pd-field-help">{workspace?.latestRun ? t.brief.updateConsequence : t.brief.suggestionOnly}</p>
                  </>
                )}
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
              {clarification ? (
                <ClarifyChecklist
                  clarification={clarification}
                  drafts={drafts}
                  readOnly={busy}
                  onChange={(id, draft) => setDraftState({ briefVersion: clarification.briefVersion, items: { ...drafts, [id]: draft } })}
                  t={t.clarify}
                />
              ) : null}
            </div>
          </ResearchPanel>

          {batchJob ? (
            <ResearchBatch
              job={batchJob}
              failureReason={discoveryRunFailureReason(batchJob.errorCode, t)}
              busy={busy || pending !== null}
              canRetry={Boolean(briefDraft.trim())}
              onDismiss={() => setDismissedJobId(batchJob.id)}
              onAgain={() => setResearchSettingsOpen(true)}
              onRetry={() => void investigate()}
              onEdit={workspace?.latestRun ? () => setResearchSettingsOpen(true) : undefined}
              t={t}
            >
              {batchRunId === null ? undefined : batchProposals.length ? (
                <FlipList className="pd-list" ariaLabel={t.run.doneTitle(batchProposals.length)}>
                  {batchProposals.map((proposal) => renderProposalRow(proposal, true))}
                </FlipList>
              ) : false}
            </ResearchBatch>
          ) : null}

          {restProposals.length ? (
            <section className="order-2" aria-label={t.proposal.shortlistLabel}>
              <h3 className="sr-only">{t.proposal.shortlistTitle}</h3>
              {filtersShown ? <PlaceFilterBar filters={proposalFilters} total={restProposals.length} label="搜尋 AI 找到的地點" /> : null}
              {visibleRestProposals.length === 0 ? <PlaceFilterEmpty onClear={proposalFilters.clear} /> : (
              <FlipList className="pd-list" ariaLabel={t.proposal.shortlistLabel}>
                {/* Same order as 口袋名單: newest first as the API returns it; votes never reorder. */}
                {visibleRestProposals.map((proposal) => renderProposalRow(proposal))}
              </FlipList>
              )}
            </section>
          ) : workspace?.proposals.length || batchJob ? null : workspace?.latestRun?.status === "completed" ? <p className="order-2 rounded-panel border border-dashed p-5 text-center text-muted-foreground">{t.proposal.nonePassed}</p> : null}

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
