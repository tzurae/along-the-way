import { BedDouble, MapPinned, UserPlus, X, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { useI18n } from "./i18n";
import type { TripSegment, TripTab } from "./trip-location";

interface ChecklistFacts {
  hasLodging: boolean;
  placeCount: number;
  hasAssignedPlace: boolean;
  hasCompanionOrPendingInvite: boolean;
}

interface ChecklistItem {
  id: "lodging" | "place" | "invite";
  label: string;
  Icon: LucideIcon;
  tab: TripTab;
  segment: TripSegment | null;
}

export function TripOnboardingChecklist({
  tripId,
  userId,
  isOwner,
  facts,
  showCreatedConfirmation = false,
  navigate,
}: {
  tripId: string;
  userId: string;
  isOwner: boolean;
  facts: ChecklistFacts;
  showCreatedConfirmation?: boolean;
  navigate(tab: TripTab, segment: TripSegment | null): void;
}) {
  const { t } = useI18n();
  const storageKey = `along-the-way:trip-onboarding:${userId}:${tripId}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(storageKey) === "dismissed";
    } catch {
      return false;
    }
  });

  const items: ChecklistItem[] = [];
  if (!facts.hasLodging) {
    items.push({
      id: "lodging",
      label: t.app.onboardingChecklist.addLodging,
      Icon: BedDouble,
      tab: "itinerary",
      segment: "lodging",
    });
  }
  if (facts.placeCount === 0) {
    items.push({
      id: "place",
      label: t.app.onboardingChecklist.addFirstPlace,
      Icon: MapPinned,
      tab: "places",
      segment: "wishlist",
    });
  } else if (isOwner && !facts.hasAssignedPlace) {
    items.push({
      id: "place",
      label: t.app.onboardingChecklist.assignPlace,
      Icon: MapPinned,
      tab: "itinerary",
      segment: "daily",
    });
  }
  if (isOwner && !facts.hasCompanionOrPendingInvite) {
    items.push({
      id: "invite",
      label: t.app.onboardingChecklist.inviteCompanion,
      Icon: UserPlus,
      tab: "members",
      segment: null,
    });
  }

  if (dismissed || items.length === 0) return null;

  return (
    <section className="trip-onboarding-checklist" aria-labelledby="trip-onboarding-heading">
      <div className="trip-onboarding-checklist__heading">
        <div>
          {showCreatedConfirmation ? (
            <p className="trip-onboarding-checklist__confirmation" role="status">
              {t.app.onboardingChecklist.created}
            </p>
          ) : null}
          <h2 id="trip-onboarding-heading">{t.app.onboardingChecklist.title}</h2>
        </div>
        <button
          className="trip-onboarding-checklist__dismiss"
          type="button"
          onClick={() => {
            try {
              window.localStorage.setItem(storageKey, "dismissed");
            } catch {
              // Dismiss for this view even when browser storage is unavailable.
            }
            setDismissed(true);
          }}
        >
          <X aria-hidden="true" />
          <span>{t.app.onboardingChecklist.dismiss}</span>
        </button>
      </div>
      <div className="trip-onboarding-checklist__items">
        {items.slice(0, 3).map(({ id, label, Icon, tab, segment }) => (
          <button key={id} type="button" onClick={() => navigate(tab, segment)}>
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
