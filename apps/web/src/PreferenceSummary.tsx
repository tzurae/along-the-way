import type { PlacePreferencesDto } from "@along-the-way/contracts/day-plans";

import { useI18n } from "./i18n";

/** Each member's preference for a place; a must next to a dislike is called out first. */
export function PreferenceSummary({ preferences }: {
  preferences: Pick<PlacePreferencesDto, "members" | "conflict"> | undefined;
}) {
  const { t } = useI18n();
  if (!preferences) return null;
  const members = preferences.members
    .map((member) => t.timetable.memberPreference(member.memberName, t.tripPlaces.preference[member.level]))
    .join("、");
  return (
    <div className="grid justify-items-start gap-1 text-sm text-muted-foreground">
      {preferences.conflict ? (
        <p className="rounded bg-destructive/10 px-1.5 py-0.5 font-semibold text-destructive">
          {t.timetable.preferenceConflict}
        </p>
      ) : null}
      <p>{t.timetable.preferences(members)}</p>
    </div>
  );
}
