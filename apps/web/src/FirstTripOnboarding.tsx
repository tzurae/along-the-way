import { ArrowRight, Route } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "./i18n";

export function FirstTripOnboarding({ onCreateTrip }: { onCreateTrip(returnFocus: HTMLElement): void }) {
  const { t } = useI18n();

  return (
    <section className="first-trip-onboarding" aria-labelledby="first-trip-heading">
      <div className="first-trip-onboarding__copy">
        <div className="first-trip-onboarding__mark" aria-hidden="true">
          <Route />
        </div>
        <h1 id="first-trip-heading">{t.app.firstTripTitle}</h1>
        <p>{t.app.firstTripDescription}</p>
        <Button className="first-trip-onboarding__action" type="button" onClick={(event) => onCreateTrip(event.currentTarget)}>
          {t.app.createTrip}
          <ArrowRight aria-hidden="true" />
        </Button>
        <p className="first-trip-onboarding__invitation">{t.app.firstTripInvitation}</p>
      </div>
    </section>
  );
}
