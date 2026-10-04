import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseTripPlanResponse,
  type TripPlanDto,
  type TripPlanResponse,
} from "@along-the-way/contracts/day-plans";
import { parseTripPlaceListResponse } from "@along-the-way/contracts/trip-places";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { loadLabels, reasonLabels, span, TimetableRow } from "./TimetableView";

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
      if (ticket === latestRequest.current) setError(reason instanceof Error ? reason.message : "Could not plan the trip");
    } finally {
      if (ticket === latestRequest.current) setBusy(null);
    }
  }, [request, tripId]);

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
          })),
        }),
        parse: parseTripPlaceListResponse,
      });
      applyKey.current = null;
      onApplied();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not use this plan");
    } finally {
      setBusy(null);
    }
  }

  const names = new Map(plan?.days.flatMap((day) => day.timetable.rows.flatMap((row) =>
    row.kind === "visit" ? [[row.tripPlaceId, row.name] as const] : [])) ?? []);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="h-dvh w-screen max-w-none overflow-y-auto rounded-none content-start sm:h-auto sm:max-h-[90vh] sm:w-full sm:max-w-2xl sm:rounded-xl">
        <DialogHeader>
          <DialogTitle>Plan the whole trip</DialogTitle>
          <DialogDescription>
            Adds wishlist places that are not on a day yet. Places already on a day stay where they are. Nothing is saved until you use this plan, and the itinerary never changes.
          </DialogDescription>
        </DialogHeader>

        {error ? <p role="alert" className="text-sm font-semibold text-destructive">{error}</p> : null}
        {busy === "planning" ? <p role="status" className="text-sm">Planning the trip…</p> : null}

        {plan ? (
          <div className="grid gap-5">
            {plan.days.length === 0 ? <p className="empty-state">No day gets a new place.</p> : null}
            {plan.days.map((day) => (
              <section key={day.timetable.dayId} className="grid gap-2" aria-label={`Plan for ${day.timetable.date}`}>
                <h3 className="font-display text-lg text-ink-strong">
                  {dayLabels.get(day.timetable.dayId) ?? "Day"} · {day.timetable.date}
                </h3>
                <p className="text-sm">
                  <strong>Adds:</strong> {day.addedTripPlaceIds.map((id) => names.get(id) ?? id).join(", ")}
                  {" · "}
                  {loadLabels[day.timetable.load.level]}, {span(day.timetable.load.busyMinutes)} busy of {span(day.timetable.load.windowMinutes)}
                </p>
                <ol className="grid gap-2" aria-label={`Draft timetable for ${day.timetable.date}`}>
                  {day.timetable.rows.map((row, index) => <TimetableRow key={`${row.kind}-${index}`} row={row} />)}
                </ol>
                {day.timetable.unscheduled.length > 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Already on this day but not fitting:{" "}
                    {day.timetable.unscheduled.map((place) => `${place.name} (${reasonLabels[place.reason]})`).join(", ")}
                  </p>
                ) : null}
              </section>
            ))}
            {plan.unplaced.length > 0 ? (
              <section aria-label="Not added">
                <p className="font-bold">Not added</p>
                <ul className="mt-1 grid gap-1 text-sm">
                  {plan.unplaced.map((place) => (
                    <li key={place.tripPlaceId}>
                      <strong>{place.name}</strong> · {reasonLabels[place.reason]}{place.date ? ` on ${place.date}` : ""}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          {error ? (
            <Button variant="outline" size="lg" disabled={busy !== null} onClick={() => void draft()}>Plan again</Button>
          ) : null}
          <Button size="lg" disabled={busy !== null || !plan || plan.days.length === 0} onClick={() => void applyPlan()}>
            {busy === "saving" ? "Saving…" : "Use this plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
