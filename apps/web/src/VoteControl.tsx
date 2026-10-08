import type { MemberVoteDto } from "@along-the-way/contracts/trip-places";

import { useI18n } from "./i18n";

export function VoteVoters({ voters }: {
  voters: MemberVoteDto[];
}) {
  const { t: { tripPlaces: { vote: t } } } = useI18n();
  if (voters.length === 0) return null;
  return <p className="text-sm text-muted-foreground">{t.voters(voters.map((member) => member.memberDisplayName || member.memberEmail).join("、"))}</p>;
}

export function VoteControl({ name, voters, voteCount, ownVote, votingAvailable, disabled, compact = false, onChange }: {
  name: string;
  voters: MemberVoteDto[];
  voteCount: number;
  ownVote: boolean;
  votingAvailable: boolean;
  disabled: boolean;
  compact?: boolean;
  onChange(voted: boolean): void;
}) {
  const { t: { tripPlaces: { vote: t } } } = useI18n();
  if (!votingAvailable) return null;
  return (
    <section className={compact ? "flex items-center gap-2" : "grid gap-2"} aria-label={t.forPlace(name)}>
      <div className={`flex items-center gap-2 ${compact ? "flex-nowrap" : "flex-wrap"}`}>
        <button type="button" className="min-h-11 whitespace-nowrap rounded-lg border bg-surface px-3 font-bold disabled:opacity-50" aria-pressed={ownVote} disabled={disabled} onClick={() => onChange(!ownVote)}>
          {ownVote ? t.voted : t.vote}
        </button>
        <span className="whitespace-nowrap text-sm font-semibold tabular-nums">{t.count(voteCount)}</span>
      </div>
      {!compact ? <VoteVoters voters={voters} /> : null}
    </section>
  );
}
