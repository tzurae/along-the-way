import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseTripPlanResponse,
  type TripPlanDto,
  type TripPlanResponse,
} from "@along-the-way/contracts/day-plans";
import { parseTripPlaceListResponse } from "@along-the-way/contracts/trip-places";
import { CalendarDays, Check, Clock3, Route, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "./i18n";
import { loadLabel, reasonLabel, span, TimetableRow } from "./TimetableView";

type JsonRequest = <T>(url: string, options?: RequestInit & { parse?: (value: unknown) => unknown }) => Promise<T>;

/**
 * A draft adding wishlist places that are not on any day yet. Places already on a day stay;
 * nothing is written until "Use this plan".
 */
export function TripPlanDialog({
  tripId,
  open,
  dayLabels,
  request,
  onClose,
  onApplied,
}: {
  tripId: string;
  open: boolean;
  /** "Day N" by day ID. */
  dayLabels: Map<string, string>;
  request: JsonRequest;
  onClose(): void;
  onApplied(): void;
}) {
  const { t } = useI18n();
  const [plan, setPlan] = useState<TripPlanDto | null>(null);
  const [busy, setBusy] = useState<"planning" | "saving" | null>(null);
  const [error, setError] = useState("");
  // Only the latest request may update the dialog; an answer after closing is dropped.
  const latestRequest = useRef(0);
  // A retried use of the same plan reuses its key, so it is applied once.
  const applyKey = useRef<{ basis: string; key: string } | null>(null);

  const draft = useCallback(async () => {
    const ticket = ++latestRequest.current;
    setBusy("planning");
    setError("");
    try {
      const response = await request<TripPlanResponse>(`/api/trips/${tripId}/trip-plan`, {
        method: "POST",
        parse: parseTripPlanResponse,
      });
      if (ticket === latestRequest.current) setPlan(response.plan);
    } catch (reason) {
      if (ticket === latestRequest.current) setError(reason instanceof Error ? reason.message : t.tripPlan.couldNotPlan);
    } finally {
      if (ticket === latestRequest.current) setBusy(null);
    }
  }, [request, t.tripPlan, tripId]);

  useEffect(() => {
    latestRequest.current += 1;
    setPlan(null);
    setBusy(null);
    setError("");
    if (open) void draft();
  }, [open, draft]);

  async function applyPlan() {
    if (!plan) return;
    const key = applyKey.current?.basis === plan.basis ? applyKey.current.key : crypto.randomUUID();
    applyKey.current = { basis: plan.basis, key };
    setBusy("saving");
    setError("");
    try {
      await request(`/api/trips/${tripId}/trip-plan/apply`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify({
          basis: plan.basis,
          days: plan.days.map((day) => ({
            tripDayId: day.timetable.dayId,
            orderedTripPlaceIds: day.orderedTripPlaceIds,
            expectedVersion: day.timetable.window.version,
          })),
        }),
        parse: parseTripPlaceListResponse,
      });
      applyKey.current = null;
      onApplied();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.tripPlan.couldNotUsePlan);
    } finally {
      setBusy(null);
    }
  }

  const names = new Map(plan?.days.flatMap((day) => day.timetable.rows.flatMap((row) =>
    row.kind === "visit" ? [[row.tripPlaceId, row.name] as const] : [])) ?? []);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="trip-plan-dialog max-[599px]:translate-x-0 max-[599px]:translate-y-0">
        <DialogHeader className="route-page-heading">
          <DialogTitle>{t.tripPlan.title}</DialogTitle>
          <DialogDescription>{t.tripPlan.description}</DialogDescription>
        </DialogHeader>

        {error ? <p role="alert" className="route-error">{error}</p> : null}
        {busy === "planning" ? <p role="status" className="route-status">{t.tripPlan.planning}</p> : null}

        {plan ? (
          <div className="trip-plan-content">
            <section className="route-summary">
              <Route />
              <div>
                <strong>
                  {plan.days.length > 0
                    ? `${plan.days.length} 天會加入地點`
                    : t.tripPlan.noDayGetsNewPlace}
                </strong>
                <span>
                  {plan.unplaced.length > 0
                    ? `${plan.unplaced.length} 個地點這次排不進去。`
                    : "固定事項與已排入某一天的地點都會保留。"}
                </span>
              </div>
            </section>

            {plan.days.length === 0 ? <p className="route-optimal">{t.tripPlan.noDayGetsNewPlace}</p> : null}
            <div className="trip-plan-days">
              {plan.days.map((day) => (
                <section
                  key={day.timetable.dayId}
                  className="route-version trip-plan-day"
                  aria-label={t.tripPlan.planFor(day.timetable.date)}
                >
                  <header className="route-version-heading">
                    <div>
                      <h3>
                        {dayLabels.get(day.timetable.dayId) ?? t.tripPlan.dayFallback}
                        <span>{day.timetable.date}</span>
                      </h3>
                      <p>
                        <CalendarDays />
                        {t.tripPlan.adds} {day.addedTripPlaceIds.map((id) => names.get(id) ?? id).join("、")}
                      </p>
                    </div>
                    <span>
                      {t.tripPlan.loadSummary(
                        loadLabel(day.timetable.load.level, t.timetable),
                        span(day.timetable.load.busyMinutes, t.timetable),
                        span(day.timetable.load.windowMinutes, t.timetable),
                      )}
                    </span>
                  </header>
                  <ol className="route-timeline" aria-label={t.tripPlan.draftTimetableFor(day.timetable.date)}>
                    {day.timetable.rows.map((row, index) => (
                      <TimetableRow key={`${row.kind}-${index}`} row={row} />
                    ))}
                  </ol>
                  {day.timetable.unscheduled.length > 0 ? (
                    <section className="route-unscheduled">
                      <div className="route-unscheduled-heading">
                        <TriangleAlert />
                        <div>
                          <h4>{t.tripPlan.alreadyOnDayButNotFitting}</h4>
                          <p>沒有刪除，仍留在這一天的口袋名單。</p>
                        </div>
                      </div>
                      <ul>
                        {day.timetable.unscheduled.map((place) => (
                          <li key={place.tripPlaceId}>
                            <strong>{place.name}</strong>
                            <span>{reasonLabel(place.reason, t.timetable)}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </section>
              ))}
            </div>

            {plan.unplaced.length > 0 ? (
              <section className="route-unscheduled" aria-label={t.tripPlan.notAdded}>
                <div className="route-unscheduled-heading">
                  <TriangleAlert />
                  <div>
                    <h3>{t.tripPlan.notAdded}</h3>
                    <p>這些地點沒有被刪除，仍保留在口袋名單。</p>
                  </div>
                </div>
                <ul>
                  {plan.unplaced.map((place) => (
                    <li key={place.tripPlaceId}>
                      <strong>{place.name}</strong>
                      <span>
                        {reasonLabel(place.reason, t.timetable)}
                        {place.date ? t.tripPlan.onDate(place.date) : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <div className="route-evidence" aria-label="時間資料說明">
              <span className="route-evidence-label">時間依據</span>
              <span className="route-evidence-chip"><Check /> 確定：固定行程與營業時間</span>
              <span className="route-evidence-chip route-evidence-estimated">
                <Clock3 /> 估計：路線與停留時間
              </span>
            </div>
          </div>
        ) : null}

        <DialogFooter className="route-actionbar">
          {error ? (
            <Button variant="outline" size="lg" disabled={busy !== null} onClick={() => void draft()}>
              {t.tripPlan.planAgain}
            </Button>
          ) : null}
          <Button size="lg" disabled={busy !== null || !plan || plan.days.length === 0} onClick={() => void applyPlan()}>
            <Check />
            {busy === "saving" ? t.tripPlan.saving : t.tripPlan.useThisPlan}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
