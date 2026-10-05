import type {
  CreateDiscoveryFeedbackInput,
  DecideCandidateProposalInput,
  DecideDiscoveryFeedbackInput,
  DiscoveryWorkspaceDto,
  GenerateDiscoveryInput,
  SaveDiscoveryBriefInput,
  SaveDiscoveryQuestionAnswersInput,
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
  ): Promise<DiscoveryWorkspaceDto>;
  acceptProposal(
    userId: string,
    tripId: string,
    proposalId: string,
    idempotencyKey: string,
    input: DecideCandidateProposalInput,
  ): Promise<DiscoveryWorkspaceDto>;
  rejectProposal(
    userId: string,
    tripId: string,
    proposalId: string,
    idempotencyKey: string,
    input: DecideCandidateProposalInput,
  ): Promise<DiscoveryWorkspaceDto>;
  createFeedback(
    userId: string,
    tripId: string,
    idempotencyKey: string,
    input: CreateDiscoveryFeedbackInput,
  ): Promise<DiscoveryWorkspaceDto>;
  decideFeedback(
    userId: string,
    tripId: string,
    feedbackId: string,
    idempotencyKey: string,
    input: DecideDiscoveryFeedbackInput,
  ): Promise<DiscoveryWorkspaceDto>;
}
