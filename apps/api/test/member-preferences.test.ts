import { describe, expect, it } from "vitest";

import { summarizeMemberPreferences } from "../src/member-preferences";

describe("member preference summaries", () => {
  it("orders expressed choices by strength, preserves roster order within a level, and reports only must-dislike conflicts", () => {
    const entries = [
      { memberUserId: "dad", memberName: "Dad", level: "dislike" as const },
      { memberUserId: "mum", memberName: "Mum", level: "must" as const },
      { memberUserId: "kid", memberName: "Kid", level: null },
      { memberUserId: "gran", memberName: "Gran", level: "dislike" as const },
    ];

    expect(summarizeMemberPreferences(entries)).toEqual({
      members: [
        { memberUserId: "mum", memberName: "Mum", level: "must" },
        { memberUserId: "dad", memberName: "Dad", level: "dislike" },
        { memberUserId: "gran", memberName: "Gran", level: "dislike" },
      ],
      conflict: true,
    });
    expect(summarizeMemberPreferences([
      { memberUserId: "mum", memberName: "Mum", level: "want" },
      { memberUserId: "dad", memberName: "Dad", level: "dislike" },
    ])).toMatchObject({ conflict: false });
    expect(summarizeMemberPreferences([
      { memberUserId: "kid", memberName: "Kid", level: null },
    ])).toEqual({ members: [], conflict: false });
  });
});
