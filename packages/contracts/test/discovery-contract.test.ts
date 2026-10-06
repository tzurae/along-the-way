import { describe, expect, it } from "vitest";

import { parseDiscoveryWorkspaceResponse } from "../src/discovery";

function response() {
  return {
    discovery: {
      brief: null,
      latestRun: null,
      proposals: [{
        id: "proposal-1",
        runId: "run-1",
        providerPlaceId: "place-1",
        name: "Nishiki Market",
        type: "activity",
        address: null,
        latitude: null,
        longitude: null,
        sourceUrl: null,
        recommendation: "A compact food-market stop.",
        recommendationSentences: null,
        matchedNeeds: ["food markets"],
        tradeoffs: [],
        tradeoffSentences: null,
        unknowns: [],
        status: "pending",
        evidence: [],
        voters: [],
        voteCount: 0,
        ownVote: false,
        votingAvailable: false,
        acceptedTripPlaceId: null,
        version: 1,
        category: null,
        endorsements: [],
      }],
      decided: [],
      feedback: [],
      modelAvailable: true,
      placeProviderAvailable: true,
    },
  };
}

describe("discovery contract", () => {
  it("accepts an old stored proposal with confidence without exposing it", () => {
    const legacy = response();
    Object.assign(legacy.discovery.proposals[0]!, { confidence: "high" });

    const proposal = parseDiscoveryWorkspaceResponse(legacy).discovery.proposals[0]!;

    expect(proposal).not.toHaveProperty("confidence");
  });
});
