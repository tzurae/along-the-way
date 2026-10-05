import type { MemberPreferenceDto } from "@along-the-way/contracts/day-plans";
import type { PreferenceLevel } from "@along-the-way/contracts/trip-places";

const PREFERENCE_PRIORITY: Record<PreferenceLevel, number> = {
  must: 0,
  want: 1,
  optional: 2,
  neutral: 3,
  dislike: 4,
};

export interface MemberPreferenceInput {
  memberUserId: string;
  memberName: string;
  level: PreferenceLevel | null;
}

/** Lower is planned first: the best preference any member gave; unrated counts as neutral. */
export function preferencePriority(levels: ReadonlyArray<PreferenceLevel | null>) {
  let priority: number | null = null;
  for (const level of levels) {
    if (level === null) continue;
    const rank = PREFERENCE_PRIORITY[level];
    priority = priority === null ? rank : Math.min(priority, rank);
  }
  return priority ?? PREFERENCE_PRIORITY.neutral;
}

/** Keeps expressed preferences separate, strongest first and in roster order within a level. */
export function summarizeMemberPreferences(entries: readonly MemberPreferenceInput[]): {
  members: MemberPreferenceDto[];
  conflict: boolean;
} {
  const members = entries.flatMap((entry) => entry.level === null ? [] : [{
    memberUserId: entry.memberUserId,
    memberName: entry.memberName,
    level: entry.level,
  }]);
  members.sort((left, right) => PREFERENCE_PRIORITY[left.level] - PREFERENCE_PRIORITY[right.level]);
  let must = false;
  let dislike = false;
  for (const member of members) {
    must ||= member.level === "must";
    dislike ||= member.level === "dislike";
  }
  return { members, conflict: must && dislike };
}
