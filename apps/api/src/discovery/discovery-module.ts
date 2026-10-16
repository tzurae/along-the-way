import type {
  CandidateProposalDto,
  DecideCandidateProposalInput,
  DiscoveryWorkspaceDto,
  GenerateDiscoveryInput,
  SaveDiscoveryBriefInput,
  SaveDiscoveryQuestionAnswersInput,
  ScheduleDiscoveryProposalsInput,
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
  saveQuestionAnswers(
    userId: string,
    tripId: string,
    idempotencyKey: string,
    input: SaveDiscoveryQuestionAnswersInput,
  ): Promise<DiscoveryWorkspaceDto>;
  generate(
    userId: string,
    tripId: string,
    idempotencyKey: string,
    input: GenerateDiscoveryInput,
  ): Promise<DiscoveryWorkspaceDto>;
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
