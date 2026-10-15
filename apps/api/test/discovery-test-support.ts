import type { DiscoveryModule } from "../src/discovery/discovery-module";

async function unexpectedDiscoveryCall(): Promise<never> {
  throw new Error("This test does not exercise AI discovery");
}

export const unrelatedDiscoveryModule = {
  getWorkspace: unexpectedDiscoveryCall,
  saveBrief: unexpectedDiscoveryCall,
  saveQuestionAnswers: unexpectedDiscoveryCall,
  generate: unexpectedDiscoveryCall,
  setProposalVote: unexpectedDiscoveryCall,
  scheduleProposals: unexpectedDiscoveryCall,
  rejectProposal: unexpectedDiscoveryCall,
} satisfies DiscoveryModule;
