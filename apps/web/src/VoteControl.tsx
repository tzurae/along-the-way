import type { MemberVoteDto } from "@along-the-way/contracts/trip-places";

import { useI18n } from "./i18n";

export function VoteControl({ name, voters, voteCount, ownVote, votingAvailable, disabled, onChange }: {
  name: string;
  voters: MemberVoteDto[];
  voteCount: number;
  ownVote: boolean;
  votingAvailable: boolean;
  disabled: boolean;
  onChange(voted: boolean): void;
}) {
  const { t: { tripPlaces: { vote: t } } } = useI18n();
  if (!votingAvailable) return null;
  return (
    <section className="grid gap-2" aria-label={t.forPlace(name)}>
      <div className="flex items-center gap-3">
        <button type="button" className="min-h-11 rounded-lg border bg-surface px-3 font-bold disabled:opacity-50" aria-pressed={ownVote} disabled={disabled} onClick={() => onChange(!ownVote)}>
          {ownVote ? t.voted : t.vote}
        </button>
        <span className="text-sm font-semibold">{t.count(voteCount)}</span>
      </div>
      {voters.length > 0 ? <p className="text-sm text-muted-foreground">{t.voters(voters.map((member) => member.memberDisplayName || member.memberEmail).join("、"))}</p> : null}
    </section>
  );
}
