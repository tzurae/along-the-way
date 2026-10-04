import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  parseDayTimetableResponse,
  parseDayWindowResponse,
  type DayTimetableDto,
  type DayTimetableOrder,
  type DayTimetableResponse,
  type DayWindowResponse,
} from "@along-the-way/contracts/day-plans";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { clock, loadLabels, reasonLabels, span, TimetableRow } from "./TimetableView";

type JsonRequest = <T>(url: string, options?: RequestInit & { parse?: (value: unknown) => unknown }) => Promise<T>;

export interface PlannedDay {
  id: string;
  date: string;
  label: string;
}

function minuteOf(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** A draft timetable for one day. Only the day's hours and an explicitly used order are saved. */
export function DayPlanDialog({
  tripId,
  day,
  request,
  onClose,
  onOrderSaved,
}: {
  tripId: string;
  day: PlannedDay | null;
  request: JsonRequest;
  onClose(): void;
  onOrderSaved(): Promise<void>;
}) {
  const [timetable, setTimetable] = useState<DayTimetableDto | null>(null);
  const [order, setOrder] = useState<DayTimetableOrder>("current");
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("19:00");
  const [busy, setBusy] = useState<"planning" | "saving" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  // A retried save reuses its key; a successful one forgets it so a later identical change is new.
  const keys = useRef(new Map<string, string>());
  const keyFor = (identity: string) => {
    const existing = keys.current.get(identity);
    if (existing) return existing;
    const created = crypto.randomUUID();
    keys.current.set(identity, created);
    return created;
  };
  // Only the latest request may update the dialog; an answer for a day closed meanwhile is dropped.
  const latestRequest = useRef(0);

  const plan = useCallback(async (dayId: string, nextOrder: DayTimetableOrder) => {
    const ticket = ++latestRequest.current;
    setBusy("planning");
    setError("");
    try {
      const response = await request<DayTimetableResponse>(`/api/trips/${tripId}/days/${dayId}/timetable`, {
        method: "POST",
        body: JSON.stringify({ order: nextOrder }),
        parse: parseDayTimetableResponse,
      });
      if (ticket !== latestRequest.current) return;
      setTimetable(response.timetable);
      setOrder(nextOrder);
      setStart(clock(response.timetable.window.startMinute));
      setEnd(clock(response.timetable.window.endMinute));
    } catch (reason) {
      if (ticket !== latestRequest.current) return;
      setError(reason instanceof Error ? reason.message : "Could not plan this day");
    } finally {
      if (ticket === latestRequest.current) setBusy(null);
    }
  }, [request, tripId]);

  useEffect(() => {
    latestRequest.current += 1;
    setTimetable(null);
    setOrder("current");
    setBusy(null);
    setNotice("");
    setError("");
    if (day) void plan(day.id, "current");
  }, [day, plan]);

  async function replan(event: FormEvent) {
    event.preventDefault();
    if (!day || !timetable) return;
    const startMinute = minuteOf(start);
    const endMinute = minuteOf(end);
    if (startMinute === null || endMinute === null || startMinute >= endMinute) {
      setError("The day must end after it starts.");
      return;
    }
    setNotice("");
    if (startMinute !== timetable.window.startMinute || endMinute !== timetable.window.endMinute) {
      const identity = `window:${day.id}:${startMinute}-${endMinute}`;
      setBusy("saving");
      setError("");
      try {
        await request<DayWindowResponse>(`/api/trips/${tripId}/days/${day.id}/window`, {
          method: "PUT",
          headers: { "Idempotency-Key": keyFor(identity) },
          body: JSON.stringify({ startMinute, endMinute }),
          parse: parseDayWindowResponse,
        });
        keys.current.delete(identity);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not save this day's hours");
        setBusy(null);
        return;
      }
    }
    await plan(day.id, order);
  }

  async function saveOrder() {
    if (!day || !timetable) return;
    const orderedTripPlaceIds = timetable.orderedTripPlaceIds;
    const identity = `order:${day.id}:${orderedTripPlaceIds.join(",")}`;
    setBusy("saving");
    setError("");
    try {
      await request(`/api/trips/${tripId}/days/${day.id}/place-order`, {
        method: "PUT",
        headers: { "Idempotency-Key": keyFor(identity) },
        body: JSON.stringify({ orderedTripPlaceIds }),
      });
      keys.current.delete(identity);
      // The draft already uses this order, which is now the day's own.
      setOrder("current");
      setTimetable({ ...timetable, order: "current" });
      setNotice("Order saved for this day.");
      await onOrderSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save this order");
    } finally {
      setBusy(null);
    }
  }

  const attributions = timetable
    ? [...new Set(timetable.rows.flatMap((row) =>
        row.kind !== "start" && row.travel?.attribution ? [row.travel.attribution] : []))]
    : [];
  const hoursChecked = timetable?.rows.some((row) => row.kind === "visit" && row.hours === "listed") ?? false;

  return (
    <Dialog open={day !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="h-dvh w-screen max-w-none overflow-y-auto rounded-none content-start sm:h-auto sm:max-h-[90vh] sm:w-full sm:max-w-2xl sm:rounded-xl">
        <DialogHeader>
          <DialogTitle>Plan {day?.label} · {day?.date}</DialogTitle>
          <DialogDescription>
            This is a draft. It never changes the itinerary; only this day&apos;s hours, and an order you choose to use, are saved.
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void replan(event)}>
          <label className="grid gap-1 text-sm font-semibold">
            Start
            <input className="min-h-10 rounded-lg border px-2" type="time" value={start} required onChange={(event) => setStart(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            End
            <input className="min-h-10 rounded-lg border px-2" type="time" value={end} required onChange={(event) => setEnd(event.target.value)} />
          </label>
          <Button type="submit" variant="outline" size="lg" disabled={busy !== null || !timetable}>Re-plan</Button>
        </form>

        {error ? <p role="alert" className="text-sm font-semibold text-destructive">{error}</p> : null}
        {busy === "planning" ? <p role="status" className="text-sm">Planning this day…</p> : null}
        {notice ? <p role="status" className="text-sm font-semibold">{notice}</p> : null}

        {timetable ? (
          <div className="grid gap-4">
            <p className="font-bold" data-testid="day-load">
              {loadLabels[timetable.load.level]} · {span(timetable.load.busyMinutes)} busy of {span(timetable.load.windowMinutes)}
            </p>
            <p className="text-sm text-muted-foreground">
              {timetable.order === "suggested" ? "Suggested order: closest places first." : "This day's current order."}
              {" "}
              {timetable.lodging
                ? `Starts and ends at ${timetable.lodging.name}.`
                : "No lodging that night, so the day starts at the first place."}
            </p>
            {timetable.rows.length > 0 ? (
              <ol className="grid gap-2" aria-label="Draft timetable">
                {timetable.rows.map((row, index) => <TimetableRow key={`${row.kind}-${index}`} row={row} />)}
              </ol>
            ) : (
              <p className="empty-state">Nothing fits in this day yet.</p>
            )}
            {timetable.unscheduled.length > 0 ? (
              <section aria-label="Not in this draft">
                <p className="font-bold">Not in this draft</p>
                <ul className="mt-1 grid gap-1 text-sm">
                  {timetable.unscheduled.map((place) => (
                    <li key={place.tripPlaceId}>
                      <strong>{place.name}</strong> · {reasonLabels[place.reason]}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {attributions.length > 0 || hoursChecked ? (
              <p className="text-xs text-muted-foreground">
                {attributions.length > 0 ? `Route times: ${attributions.join(", ")}.` : ""}
                {hoursChecked ? " Opening hours: Google Maps." : ""}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          {order === "suggested" ? (
            <>
              <Button variant="outline" size="lg" disabled={busy !== null || !day} onClick={() => day && void plan(day.id, "current")}>
                Back to current order
              </Button>
              <Button
                size="lg"
                disabled={busy !== null || !timetable || timetable.orderedTripPlaceIds.length === 0}
                onClick={() => void saveOrder()}
              >
                {busy === "saving" ? "Saving…" : "Use this order"}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="lg" disabled={busy !== null || !day} onClick={() => day && void plan(day.id, "suggested")}>
              Try suggested order
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
