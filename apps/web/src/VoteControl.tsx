import { ThumbsUp } from "lucide-react";

import type { MemberVoteDto } from "@along-the-way/contracts/trip-places";

import { useI18n } from "./i18n";

export function VoteVoters({ voters }: {
  voters: MemberVoteDto[];
}) {
  const { t: { tripPlaces: { vote: t } } } = useI18n();
  if (voters.length === 0) return null;
  return <p className="pd-voters">{t.voters(voters.map((member) => member.memberDisplayName ?? member.memberEmail ?? "成員").join("、"))}</p>;
}

export function VoteControl({ name, voters, voteCount, ownVote, votingAvailable, disabled, busy = false, compact = false, onChange }: {
  name: string;
  voters: MemberVoteDto[];
  voteCount: number;
  ownVote: boolean;
  votingAvailable: boolean;
  disabled: boolean;
  busy?: boolean;
  compact?: boolean;
  onChange(voted: boolean): void;
}) {
  const { t: { tripPlaces: { vote: t } } } = useI18n();
  if (!votingAvailable) {
    return (
      <section className="pd-vote-control" data-compact={compact ? "true" : "false"} aria-label={t.forPlace(name)}>
        <span className="pd-vote-tally" aria-label={`${t.unavailable}，${t.count(voteCount)}`} title={t.unavailable}>
          <ThumbsUp aria-hidden="true" className="size-4" />
          <span>{voteCount}</span>
        </span>
        {!compact ? <VoteVoters voters={voters} /> : null}
      </section>
    );
  }
  return (
    <section className="pd-vote-control" data-compact={compact ? "true" : "false"} aria-label={t.forPlace(name)}>
      <button
        type="button"
        className="pd-vote-button"
        aria-label={`${ownVote ? t.voted : t.vote}，${t.count(voteCount)}`}
        aria-pressed={ownVote}
        aria-busy={busy || undefined}
        disabled={disabled}
        onClick={() => onChange(!ownVote)}
      >
        <ThumbsUp aria-hidden="true" className="size-4" />
        <span>{voteCount}</span>
      </button>
      {!compact ? <VoteVoters voters={voters} /> : null}
    </section>
  );
}
