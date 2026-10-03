import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Check, ExternalLink, RefreshCw, Search, X } from "lucide-react";

import {
  parseDiscoveryWorkspaceResponse,
  type CandidateProposalDto,
  type DiscoveryWorkspaceDto,
} from "@along-the-way/contracts/discovery";
import type { TripDto } from "@along-the-way/contracts/private-trips";

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

interface DiscoveryWorkspaceProps {
  trip: TripDto;
  request: Request;
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unable to complete AI discovery";
}

function shouldStartFreshRequest(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "model_unavailable" || error.code === "provider_unavailable";
}

// Where an outcome is reported: next to the control that caused it, or at the top.
type NoticeArea = "general" | "find" | "again" | "feedback";

function missingServices(workspace: DiscoveryWorkspaceDto, needsPlaces: boolean) {
  return [
    ...(workspace.modelAvailable ? [] : ["OpenAI API key and model"]),
    ...(needsPlaces && !workspace.placeProviderAvailable ? ["Google Maps API key"] : []),
  ];
}

const statusLabels: Record<CandidateProposalDto["status"], string> = {
  pending: "Ready for review",
  accepting: "Adding to wishlist…",
  accepted: "Added to wishlist",
  rejected: "Not for this trip",
};

export function DiscoveryWorkspace({ trip, request, onPlacesChanged }: DiscoveryWorkspaceProps) {
  const [workspace, setWorkspace] = useState<DiscoveryWorkspaceDto | null>(null);
  const [briefDraft, setBriefDraft] = useState("");
  const [feedbackDraft, setFeedbackDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ area: NoticeArea; text: string } | null>(null);
  const retryKeys = useRef<RetryKeys>(new Map());
  const researchLabel = (idle: string) =>
    pending === "save-brief" ? "Saving…" : pending === "generate" ? "Researching…" : idle;

  const apply = useCallback((value: unknown) => {
    const next = parseDiscoveryWorkspaceResponse(value).discovery;
    setWorkspace(next);
    setBriefDraft(next.brief?.originalText ?? "");
    return next;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      apply(await request(`/api/trips/${trip.id}/discovery`));
      setNotice(null);
    } catch (error) {
      setNotice({ area: "general", text: errorMessage(error) });
    } finally {
      setLoading(false);
    }
  }, [apply, request, trip.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mutate(
    operation: string,
    path: string,
    payload: unknown,
    area: NoticeArea,
    after?: () => void,
  ) {
    if (pending) return;
    setPending(operation);
    setNotice(null);
    try {
      const next = apply(await request(path, {
        method: operation === "save-brief" ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": retryKey(retryKeys.current, operation, payload),
        },
        body: JSON.stringify(payload),
      }));
      clearRetryKey(retryKeys.current, operation);
      after?.();
      return next;
    } catch (error) {
      if (shouldStartFreshRequest(error)) clearRetryKey(retryKeys.current, operation);
      setNotice({ area, text: errorMessage(error) });
    } finally {
      setPending(null);
    }
  }

  // One action: explain a missing server configuration without sending anything,
  // otherwise store the current brief text when it changed, then research it.
  async function research(area: "find" | "again") {
    if (pending || !workspace) return;
    const missing = missingServices(workspace, true);
    if (missing.length > 0) {
      setNotice({
        area,
        text: `AI research can't run: this server has no ${missing.join(" and no ")} configured. Your trip description is kept.`,
      });
      return;
    }
    let brief = workspace.brief;
    if (!brief || brief.originalText !== briefDraft) {
      const saved = await mutate("save-brief", `/api/trips/${trip.id}/discovery/brief`, {
        originalText: briefDraft,
        expectedVersion: brief?.version ?? null,
      }, area);
      if (!saved?.brief) return;
      brief = saved.brief;
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

  async function createFeedback() {
    const text = feedbackDraft.trim();
    if (!text || pending || !workspace) return;
    const missing = missingServices(workspace, false);
    if (missing.length > 0) {
      setNotice({
        area: "feedback",
        text: `Feedback can't be interpreted: this server has no ${missing.join(" and no ")} configured. Your feedback is kept.`,
      });
      return;
    }
    await mutate("feedback", `/api/trips/${trip.id}/discovery/feedback`, {
      originalText: text,
      proposalId: null,
    }, "feedback", () => setFeedbackDraft(""));
  }

  async function decideFeedback(feedbackId: string, version: number, decision: "confirm" | "reject") {
    await mutate(
      `feedback-${decision}:${feedbackId}`,
      `/api/trips/${trip.id}/discovery/feedback/${feedbackId}/decision`,
      { expectedVersion: version, decision },
      "general",
    );
  }

  return (
    <section className="rounded-card border border-ink/10 bg-surface p-5 shadow-card sm:p-8" aria-labelledby="ai-discovery-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-accent-strong"><Bot aria-hidden="true" className="size-4" />AI trip research</p>
          <h2 id="ai-discovery-heading" className="font-display text-3xl text-ink-strong sm:text-4xl">Let AI find and explain the options</h2>
          <p className="mt-2 max-w-3xl text-muted-foreground">Describe the trip once. AI builds a bounded search plan, checks Google Places and current web sources, then gives you a shortlist to accept or reject.</p>
        </div>
        {workspace?.latestRun ? <button className="flex min-h-11 items-center gap-2 rounded-xl border px-4 font-bold" disabled={pending !== null} onClick={() => void research("again")}><RefreshCw aria-hidden="true" className="size-4" />{researchLabel("Research again")}</button> : null}
      </div>

      {notice?.area === "again" ? <p className="mt-4 rounded-xl border border-accent-strong/30 bg-surface-subtle p-4 text-accent-strong" role="alert">{notice.text}</p> : null}
      {notice?.area === "general" ? <p className="mt-4 rounded-xl border border-accent-strong/30 bg-surface-subtle p-4 text-accent-strong" role="alert">{notice.text}</p> : null}
      {loading ? <p className="mt-6" role="status">Loading AI discovery…</p> : null}

      {!loading ? (
        <div className="mt-6 grid gap-5">
          <section className="rounded-panel bg-surface-subtle p-4 sm:p-5" aria-label="Trip discovery brief">
            <label className="grid gap-2 font-bold">What should AI plan around?
              <textarea
                className="min-h-32 rounded-xl border bg-surface p-3 font-normal"
                value={briefDraft}
                onChange={(event) => setBriefDraft(event.target.value)}
                placeholder="Seven days in Osaka and Kyoto. We like gardens and local food, want an unhurried pace, and do not want long walking days."
              />
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className="flex min-h-11 items-center gap-2 rounded-xl bg-accent px-4 font-bold text-ink-strong" disabled={pending !== null || !briefDraft.trim()} onClick={() => void research("find")}><Search aria-hidden="true" className="size-4" />{researchLabel("Find candidates")}</button>
            </div>
            {notice?.area === "find" ? <p className="mt-3 rounded-xl border border-accent-strong/30 bg-surface p-4 text-accent-strong" role="alert">{notice.text}</p> : null}
            {!workspace?.modelAvailable ? <p className="mt-3 text-sm text-muted-foreground">AI discovery is unavailable until the server has an OpenAI API key and model. Existing trip data remains available.</p> : null}
            {!workspace?.placeProviderAvailable ? <p className="mt-2 text-sm text-muted-foreground">Google Places is unavailable. Existing proposals remain readable, but a new grounded search cannot run.</p> : null}
          </section>

          {workspace?.brief?.structured ? (
            <section className="rounded-panel border border-ink/10 p-4" aria-label="AI interpretation of trip brief">
              <h3 className="font-display text-2xl">What AI understood</h3>
              <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                <div><dt className="font-bold">Interests</dt><dd>{workspace.brief.structured.interests.join(", ") || "Unknown"}</dd></div>
                <div><dt className="font-bold">Areas</dt><dd>{workspace.brief.structured.areas.join(", ") || "Unknown"}</dd></div>
                <div><dt className="font-bold">Pace</dt><dd>{workspace.brief.structured.pace ?? "Unknown"}</dd></div>
                <div><dt className="font-bold">Budget</dt><dd>{workspace.brief.structured.budget ?? "Unknown"}</dd></div>
                <div className="sm:col-span-2"><dt className="font-bold">Avoid</dt><dd>{workspace.brief.structured.exclusions.join(", ") || "Nothing confirmed"}</dd></div>
              </dl>
              {workspace.brief.unresolvedQuestions.length ? <div className="mt-4"><strong>Questions that could change the shortlist</strong><ul className="mt-1 list-disc pl-5">{workspace.brief.unresolvedQuestions.map((question) => <li key={question}>{question}</li>)}</ul></div> : null}
            </section>
          ) : null}

          {workspace?.latestRun ? (
            <section className="rounded-panel border border-ink/10 p-4" aria-label="AI search plan">
              <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-display text-2xl">Search plan</h3><span className="text-sm text-muted-foreground">{workspace.latestRun.modelId} · {new Date(workspace.latestRun.generatedAt).toLocaleString()}</span></div>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">{workspace.latestRun.searchPlan.queries.map((query) => <li key={query} className="rounded-lg bg-surface-subtle p-3">{query}</li>)}</ul>
            </section>
          ) : null}

          {workspace?.proposals.length ? (
            <section aria-label="AI place shortlist">
              <h3 className="font-display text-3xl">AI shortlist</h3>
              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                {workspace.proposals.map((proposal) => (
                  <article key={proposal.id} className="grid content-start gap-4 rounded-panel border border-ink/10 bg-surface-subtle p-4" aria-label={`AI proposal ${proposal.name}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-[0.12em] text-accent-strong">{proposal.type} · {proposal.confidence} confidence</p><h4 className="font-display text-2xl">{proposal.name}</h4><p className="text-sm text-muted-foreground">{proposal.address ?? "Address unknown"}</p></div><span className="rounded-full border bg-surface px-3 py-1 text-sm font-bold">{statusLabels[proposal.status]}</span></div>
                    <p>{proposal.recommendation}</p>
                    <div className="grid gap-3 sm:grid-cols-3"><div><strong>Matches</strong><ul className="mt-1 list-disc pl-5 text-sm">{proposal.matchedNeeds.map((item) => <li key={item}>{item}</li>)}</ul></div><div><strong>Tradeoffs</strong><ul className="mt-1 list-disc pl-5 text-sm">{proposal.tradeoffs.map((item) => <li key={item}>{item}</li>)}</ul></div><div><strong>Unknowns</strong><ul className="mt-1 list-disc pl-5 text-sm">{proposal.unknowns.map((item) => <li key={item}>{item}</li>)}</ul></div></div>
                    <div><strong>Evidence</strong><ul className="mt-1 grid gap-1">{proposal.evidence.map((item) => <li key={item.id}><a className="inline-flex items-center gap-1 break-all font-bold text-accent-strong underline" href={item.sourceUrl} target="_blank" rel="noreferrer">{item.title}<ExternalLink aria-hidden="true" className="size-3" /></a><span className="ml-2 text-xs text-muted-foreground">{item.attribution} · observed {new Date(item.observedAt).toLocaleString()}</span></li>)}</ul></div>
                    {proposal.status === "pending" ? <div className="flex flex-wrap gap-2"><button className="flex min-h-10 items-center gap-2 rounded-lg bg-accent px-3 font-bold" disabled={pending !== null} onClick={() => void decideProposal(proposal, "accept")}><Check aria-hidden="true" className="size-4" />Accept into wishlist</button><button className="flex min-h-10 items-center gap-2 rounded-lg border px-3 font-bold" disabled={pending !== null} onClick={() => void decideProposal(proposal, "reject")}><X aria-hidden="true" className="size-4" />Not for this trip</button></div> : null}
                  </article>
                ))}
              </div>
            </section>
          ) : workspace?.latestRun ? <p className="rounded-panel border border-dashed p-5 text-center text-muted-foreground">AI found no source-grounded candidates that passed the current filters.</p> : null}

          <section className="rounded-panel bg-surface-subtle p-4" aria-label="Discovery feedback">
            <h3 className="font-display text-2xl">Refine it in your own words</h3>
            <label className="mt-3 grid gap-2 font-bold">Feedback<textarea className="min-h-24 rounded-xl border bg-surface p-3 font-normal" value={feedbackDraft} onChange={(event) => setFeedbackDraft(event.target.value)} placeholder="Too many temples. Keep one garden day and add more food markets." /></label>
            <button className="mt-3 min-h-11 rounded-xl border px-4 font-bold" disabled={pending !== null || !feedbackDraft.trim()} onClick={() => void createFeedback()}>{pending === "feedback" ? "Interpreting…" : "Interpret feedback"}</button>
            {notice?.area === "feedback" ? <p className="mt-3 rounded-xl border border-accent-strong/30 bg-surface p-4 text-accent-strong" role="alert">{notice.text}</p> : null}
            <div className="mt-4 grid gap-3">{workspace?.feedback.map((feedback) => <article key={feedback.id} className="rounded-xl bg-surface p-3"><p className="whitespace-pre-wrap">“{feedback.originalText}”</p><p className="mt-2"><strong>AI interpretation:</strong> {feedback.interpretation.summary}</p><p className="mt-1 text-sm text-muted-foreground">Interests: {feedback.interpretation.interests.join(", ") || "none"} · Avoid: {feedback.interpretation.exclusions.join(", ") || "none"} · Pace: {feedback.interpretation.pace ?? "unchanged"} · Budget: {feedback.interpretation.budget ?? "unchanged"}</p>{feedback.status === "pending" ? <div className="mt-3 flex gap-2"><button className="min-h-10 rounded-lg bg-accent px-3 font-bold" disabled={pending !== null} onClick={() => void decideFeedback(feedback.id, feedback.version, "confirm")}>Confirm interpretation</button><button className="min-h-10 rounded-lg border px-3 font-bold" disabled={pending !== null} onClick={() => void decideFeedback(feedback.id, feedback.version, "reject")}>Reject interpretation</button></div> : <span className="mt-2 inline-block text-sm font-bold">{feedback.status}</span>}</article>)}</div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
