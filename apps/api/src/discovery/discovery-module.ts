import type {
  AnswerDiscoveryClarificationInput,
  CandidateProposalDto,
  DecideCandidateProposalInput,
  DiscoveryJobDto,
  DiscoveryWorkspaceDto,
  SaveDiscoveryBriefInput,
  ScheduleDiscoveryProposalsInput,
  StartDiscoveryClarificationInput,
  StartDiscoveryResearchInput,
  UpdateCandidateProposalVoteInput,
} from "@along-the-way/contracts/discovery";

export interface DiscoveryModule {
  getWorkspace(userId: string, tripId: string): Promise<DiscoveryWorkspaceDto>;
  saveBrief(
    userId: string,
    tripId: string,
    idempotencyKey: string,
    input: SaveDiscoveryBriefInput,
  ): Promise<DiscoveryWorkspaceDto>;
  /** 調查: the AI worker drafts the ≤5-question checklist for the current brief version. */
  startClarification(userId: string, tripId: string, input: StartDiscoveryClarificationInput): Promise<DiscoveryWorkspaceDto>;
  /** 調查: saves answers and has the AI reviewer judge the required ones. */
  answerClarification(userId: string, tripId: string, input: AnswerDiscoveryClarificationInput): Promise<DiscoveryWorkspaceDto>;
  /** 調查: queues background research once the checklist is ready. */
  startResearch(
    userId: string,
    tripId: string,
    clientIp: string,
    idempotencyKey: string,
    input: StartDiscoveryResearchInput,
  ): Promise<DiscoveryWorkspaceDto>;
  latestJob(userId: string, tripId: string): Promise<DiscoveryJobDto | null>;
  acknowledgeJob(userId: string, tripId: string, jobId: string): Promise<DiscoveryJobDto | null>;
  setProposalVote(
    userId: string,
    tripId: string,
    proposalId: string,
    idempotencyKey: string,
    input: UpdateCandidateProposalVoteInput,
  ): Promise<CandidateProposalDto>;
  scheduleProposals(
    userId: string,
    tripId: string,
    idempotencyKey: string,
    input: ScheduleDiscoveryProposalsInput,
  ): Promise<DiscoveryWorkspaceDto>;
  rejectProposal(
    userId: string,
    tripId: string,
    proposalId: string,
    idempotencyKey: string,
    input: DecideCandidateProposalInput,
  ): Promise<DiscoveryWorkspaceDto>;
  /** Undoes 「不要再推薦」: the place returns to the shortlist and later research may recommend it. */
  restoreProposal(
    userId: string,
    tripId: string,
    proposalId: string,
    idempotencyKey: string,
    input: DecideCandidateProposalInput,
  ): Promise<DiscoveryWorkspaceDto>;
}
