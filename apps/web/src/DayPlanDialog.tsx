import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  parseDayTimetableResponse,
  parseDayWindowResponse,
  type DayTimetableDto,
  type DayTimetableOrder,
  type DayTimetableResponse,
  type DayWindowResponse,
  type DayWindowDto,
  type DayPlaceOrderResponse,
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
import { useI18n } from "./i18n";
import { ApiRequestError } from "./api-error";
import { ConflictPanel, useVersionConflict, type EditSnapshot } from "./ConflictPanel";
import {
  clock,
  describeStartAndEnd,
  loadLabel,
  reasonLabel,
  span,
  TimetableRow,
} from "./TimetableView";

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
  const { t } = useI18n();
  const [timetable, setTimetable] = useState<DayTimetableDto | null>(null);
  const [order, setOrder] = useState<DayTimetableOrder>("current");
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("19:00");
  const [busy, setBusy] = useState<"planning" | "saving" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [base, setBase] = useState<EditSnapshot<DayWindowDto> | null>(null);
  const [orderStale, setOrderStale] = useState(false);
  const resolution = useVersionConflict<DayWindowDto>();
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
      const { version, startMinute, endMinute } = response.timetable.window;
      setBase({ input: { startMinute, endMinute }, version });
      setOrderStale(false);
    } catch (reason) {
      if (ticket !== latestRequest.current) return;
      setError(reason instanceof Error ? reason.message : t.dayPlan.couldNotPlan);
    } finally {
      if (ticket === latestRequest.current) setBusy(null);
    }
  }, [request, t.dayPlan, tripId]);

  useEffect(() => {
    latestRequest.current += 1;
    setTimetable(null);
    setOrder("current");
    setBusy(null);
    setNotice("");
    setError("");
    setBase(null);
    resolution.clear();
    if (day) void plan(day.id, "current");
  }, [day, plan]);

  async function saveWindow(input: DayWindowDto, expectedVersion: number, conflictBase = resolution.conflictBaseVersion) {
    if (!day || !base) return;
    const identity = `window:${day.id}:${expectedVersion}:${JSON.stringify(input)}`;
    setBusy("saving");
    setError("");
    try {
      await request<DayWindowResponse>(`/api/trips/${tripId}/days/${day.id}/window`, {
        method: "PUT",
        headers: { "Idempotency-Key": keyFor(identity), ...(conflictBase ? { "Conflict-Base-Version": String(conflictBase) } : {}) },
        body: JSON.stringify({ ...input, expectedVersion }),
        parse: parseDayWindowResponse,
      });
      keys.current.delete(identity);
      resolution.clear();
      await plan(day.id, order);
      await onOrderSaved();
    } catch (reason) {
      try {
        if (await resolution.capture(reason, base, input, async () => {
          try {
            const { window } = await request<DayWindowResponse>(`/api/trips/${tripId}/days/${day.id}/window`, { parse: parseDayWindowResponse });
            return { input: { startMinute: window.startMinute, endMinute: window.endMinute }, version: window.version };
          } catch (loadError) {
            if (loadError instanceof ApiRequestError && loadError.status === 404) return null;
            throw loadError;
          }
        })) return;
        setError(reason instanceof Error ? reason.message : t.dayPlan.couldNotSaveHours);
      } catch {
        setError(t.collaboration.loadError);
      }
    } finally {
      setBusy(null);
    }
  }

  async function replan(event: FormEvent) {
    event.preventDefault();
    if (!day || !base) return;
    const startMinute = minuteOf(start);
    const endMinute = minuteOf(end);
    if (startMinute === null || endMinute === null || startMinute >= endMinute) {
      setError(t.dayPlan.endMustBeAfterStart);
      return;
    }
    setNotice("");
    if (startMinute !== base.input.startMinute || endMinute !== base.input.endMinute) {
      await saveWindow({ startMinute, endMinute }, base.version);
    } else await plan(day.id, order);
  }

  async function saveOrder() {
    if (!day || !timetable) return;
    const orderedTripPlaceIds = timetable.orderedTripPlaceIds;
    const identity = `order:${day.id}:${timetable.window.version}:${orderedTripPlaceIds.join(",")}`;
    setBusy("saving");
    setError("");
    try {
      const saved = await request<DayPlaceOrderResponse>(`/api/trips/${tripId}/days/${day.id}/place-order`, {
        method: "PUT",
        headers: { "Idempotency-Key": keyFor(identity) },
        body: JSON.stringify({ orderedTripPlaceIds, expectedVersion: timetable.window.version }),
      });
      keys.current.delete(identity);
      // The draft already uses this order, which is now the day's own.
      setOrder("current");
      setTimetable({ ...timetable, order: "current", window: { ...timetable.window, version: saved.version } });
      if (base) setBase({ ...base, version: saved.version });
      setNotice(t.dayPlan.orderSaved);
      await onOrderSaved();
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.code === "conflict") {
        setOrderStale(true);
        setError(t.collaboration.replanDay);
      } else setError(reason instanceof Error ? reason.message : t.dayPlan.couldNotSaveOrder);
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
          <DialogTitle>{t.dayPlan.title(day?.label ?? "", day?.date ?? "")}</DialogTitle>
          <DialogDescription>{t.dayPlan.draftNotice}</DialogDescription>
        </DialogHeader>

        {resolution.conflict ? <ConflictPanel conflict={resolution.conflict} busy={busy !== null}
          formatValue={(_path, value) => typeof value === "number" ? clock(value) : undefined}
          onAccept={() => { resolution.clear(); if (day && resolution.conflict?.current) void plan(day.id, order); else onClose(); }}
          onReapply={() => { const conflict = resolution.conflict; if (conflict?.current) void saveWindow(conflict.attempted, conflict.current.version, conflict.base.version); }}
          onEdit={() => { if (resolution.conflict?.current) setBase(resolution.conflict.current); resolution.resume(); }}
        /> : null}
        <form hidden={Boolean(resolution.conflict)} className="flex flex-wrap items-end gap-3" onSubmit={(event) => void replan(event)}>
          <label className="grid gap-1 text-sm font-semibold">
            {t.dayPlan.start}
            <input className="min-h-10 rounded-lg border px-2" type="time" value={start} required onChange={(event) => setStart(event.target.value)} />
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            {t.dayPlan.end}
            <input className="min-h-10 rounded-lg border px-2" type="time" value={end} required onChange={(event) => setEnd(event.target.value)} />
          </label>
          <Button type="submit" variant="outline" size="lg" disabled={busy !== null || !timetable}>{t.dayPlan.rePlan}</Button>
        </form>

        {error ? <p role="alert" className="text-sm font-semibold text-destructive">{error}</p> : null}
        {busy === "planning" ? <p role="status" className="text-sm">{t.dayPlan.planning}</p> : null}
        {notice ? <p role="status" className="text-sm font-semibold">{notice}</p> : null}

        {timetable ? (
          <div className="grid gap-4">
            <p className="font-bold" data-testid="day-load">
              {t.dayPlan.loadSummary(
                loadLabel(timetable.load.level, t.timetable),
                span(timetable.load.busyMinutes, t.timetable),
                span(timetable.load.windowMinutes, t.timetable),
              )}
            </p>
            <p className="text-sm text-muted-foreground">
              {timetable.order === "suggested"
                ? t.dayPlan.suggestedOrderDescription
                : t.dayPlan.currentOrderDescription}
              {describeStartAndEnd(timetable, t.timetable)}
            </p>
            {timetable.rows.length > 0 ? (
              <ol className="grid gap-2" aria-label={t.dayPlan.draftTimetable}>
                {timetable.rows.map((row, index) => (
                  <TimetableRow
                    key={`${row.kind}-${index}`}
                    row={row}
                  />
                ))}
              </ol>
            ) : (
              <p className="empty-state">{t.dayPlan.nothingFits}</p>
            )}
            {timetable.unscheduled.length > 0 ? (
              <section aria-label={t.dayPlan.notInDraft}>
                <p className="font-bold">{t.dayPlan.notInDraft}</p>
                <ul className="mt-1 grid gap-1 text-sm">
                  {timetable.unscheduled.map((place) => (
                    <li key={place.tripPlaceId}>
                      <strong>{place.name}</strong>・{reasonLabel(place.reason, t.timetable)}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {attributions.length > 0 || hoursChecked ? (
              <p className="text-xs text-muted-foreground">
                {attributions.length > 0 ? t.dayPlan.routeTimes(attributions.join("、")) : ""}
                {hoursChecked ? ` ${t.dayPlan.openingHoursAttribution}` : ""}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter hidden={Boolean(resolution.conflict)}>
          {order === "suggested" ? (
            <>
              <Button variant="outline" size="lg" disabled={busy !== null || !day} onClick={() => day && void plan(day.id, "current")}>
                {t.dayPlan.backToCurrentOrder}
              </Button>
              <Button
                size="lg"
                disabled={busy !== null || orderStale || !timetable || timetable.orderedTripPlaceIds.length === 0}
                onClick={() => void saveOrder()}
              >
                {busy === "saving" ? t.dayPlan.saving : t.dayPlan.useThisOrder}
              </Button>
            </>
          ) : (
            <Button variant="outline" size="lg" disabled={busy !== null || !day} onClick={() => day && void plan(day.id, "suggested")}>
              {t.dayPlan.trySuggestedOrder}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
