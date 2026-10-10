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
import { Check, Clock3, HelpCircle, ListOrdered, Route, Sparkles, TriangleAlert } from "lucide-react";

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
  const [comparisons, setComparisons] = useState<Partial<Record<DayTimetableOrder, DayTimetableDto>>>({});
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("19:00");
  const [endOfDay, setEndOfDay] = useState(false);
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
  // A save may finish on the server after closing; its continuations must not enter a new dialog.
  const dialogEpoch = useRef(0);
  function close() {
    dialogEpoch.current += 1;
    latestRequest.current += 1;
    onClose();
  }

  const plan = useCallback(async (dayId: string, nextOrder: DayTimetableOrder, activate = true) => {
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
      setComparisons((current) => ({ ...current, [nextOrder]: response.timetable }));
      if (activate) {
        setTimetable(response.timetable);
        setOrder(nextOrder);
        setStart(clock(response.timetable.window.startMinute));
        setEndOfDay(response.timetable.window.endMinute === 1440);
        if (response.timetable.window.endMinute !== 1440) setEnd(clock(response.timetable.window.endMinute));
        const { version, startMinute, endMinute } = response.timetable.window;
        setBase({ input: { startMinute, endMinute }, version });
        setOrderStale(false);
      }
      return response.timetable;
    } catch (reason) {
      if (ticket !== latestRequest.current) return;
      setError(reason instanceof Error ? reason.message : t.dayPlan.couldNotPlan);
    } finally {
      if (ticket === latestRequest.current) setBusy(null);
    }
  }, [request, t.dayPlan, tripId]);

  useEffect(() => {
    latestRequest.current += 1;
    const epoch = ++dialogEpoch.current;
    setTimetable(null);
    setComparisons({});
    setOrder("current");
    setBusy(null);
    setNotice("");
    setError("");
    setBase(null);
    resolution.clear();
    if (day) {
      void (async () => {
        if (await plan(day.id, "current") && epoch === dialogEpoch.current) await plan(day.id, "suggested");
      })();
    }
    return () => { dialogEpoch.current += 1; latestRequest.current += 1; };
  }, [day, plan]);

  async function saveWindow(input: DayWindowDto, expectedVersion: number, conflictBase = resolution.conflictBaseVersion) {
    if (!day || !base) return;
    const epoch = dialogEpoch.current;
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
      if (epoch !== dialogEpoch.current) { await onOrderSaved(); return; }
      resolution.clear();
      if (await plan(day.id, order) && epoch === dialogEpoch.current) {
        await plan(day.id, order === "current" ? "suggested" : "current", false);
      }
      await onOrderSaved();
    } catch (reason) {
      if (epoch !== dialogEpoch.current) return;
      try {
        const captured = await resolution.capture(reason, base, input, async () => {
          try {
            const { window } = await request<DayWindowResponse>(`/api/trips/${tripId}/days/${day.id}/window`, { parse: parseDayWindowResponse });
            if (epoch !== dialogEpoch.current) throw new DOMException("Dialog closed", "AbortError");
            return { input: { startMinute: window.startMinute, endMinute: window.endMinute }, version: window.version };
          } catch (loadError) {
            if (epoch !== dialogEpoch.current) throw loadError;
            if (loadError instanceof ApiRequestError && loadError.status === 404) return null;
            throw loadError;
          }
        });
        if (epoch !== dialogEpoch.current || captured) return;
        setError(reason instanceof Error ? reason.message : t.dayPlan.couldNotSaveHours);
      } catch {
        if (epoch === dialogEpoch.current) setError(t.collaboration.loadError);
      }
    } finally {
      if (epoch === dialogEpoch.current) setBusy(null);
    }
  }

  async function replan(event: FormEvent) {
    event.preventDefault();
    if (!day || !base) return;
    const startMinute = minuteOf(start);
    const endMinute = endOfDay ? 1440 : minuteOf(end);
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
    const epoch = dialogEpoch.current;
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
      if (epoch !== dialogEpoch.current) { await onOrderSaved(); return; }
      // The draft already uses this order, which is now the day's own.
      const savedTimetable = { ...timetable, order: "current" as const, window: { ...timetable.window, version: saved.version } };
      setOrder("current");
      setTimetable(savedTimetable);
      setComparisons((current) => ({ ...current, current: savedTimetable }));
      if (base) setBase({ ...base, version: saved.version });
      setNotice(t.dayPlan.orderSaved);
      await onOrderSaved();
    } catch (reason) {
      if (epoch !== dialogEpoch.current) return;
      if (reason instanceof ApiRequestError && reason.code === "conflict") {
        setOrderStale(true);
        setError(t.collaboration.replanDay);
      } else setError(reason instanceof Error ? reason.message : t.dayPlan.couldNotSaveOrder);
    } finally {
      if (epoch === dialogEpoch.current) setBusy(null);
    }
  }

  const attributions = timetable
    ? [...new Set(timetable.rows.flatMap((row) =>
        row.kind !== "start" && row.travel?.attribution ? [row.travel.attribution] : []))]
    : [];
  const hoursChecked = timetable?.rows.some((row) => row.kind === "visit" && row.hours === "listed") ?? false;
  const unknownLegCount = timetable?.rows.filter((row) =>
    row.kind !== "start" && row.travel?.durationMinutes === null).length ?? 0;

  function selectDisplayedOrder(nextOrder: DayTimetableOrder) {
    const selected = comparisons[nextOrder];
    if (!selected) return;
    setOrder(nextOrder);
    setTimetable(selected);
    setStart(clock(selected.window.startMinute));
    setEndOfDay(selected.window.endMinute === 1440);
    if (selected.window.endMinute !== 1440) setEnd(clock(selected.window.endMinute));
    setBase({
      input: { startMinute: selected.window.startMinute, endMinute: selected.window.endMinute },
      version: selected.window.version,
    });
    setNotice("");
    setOrderStale(false);
  }

  function timetableVersion(kind: DayTimetableOrder) {
    const version = comparisons[kind];
    if (!version) return null;
    const suggested = kind === "suggested";
    return (
      <section
        className="route-version"
        data-active={order === kind}
        aria-label={suggested ? t.dayPlan.suggestedOrderDescription : t.dayPlan.currentOrderDescription}
      >
        <header className="route-version-heading">
          <h3>{suggested ? "建議順序" : "目前順序"}</h3>
          <span>{suggested ? "還沒套用" : version.date}</span>
        </header>
        {version.rows.length > 0 ? (
          <ol className="route-timeline" aria-label={t.dayPlan.draftTimetable}>
            {version.rows.map((row, index) => (
              <TimetableRow key={`${row.kind}-${index}`} row={row} />
            ))}
          </ol>
        ) : (
          <p className="route-optimal">{t.dayPlan.nothingFits}</p>
        )}
        {version.unscheduled.length > 0 ? (
          <section className="route-unscheduled" aria-label={t.dayPlan.notInDraft}>
            <div className="route-unscheduled-heading">
              <TriangleAlert />
              <div>
                <h4>{t.dayPlan.notInDraft}</h4>
                <p>沒有刪除，仍留在這一天的口袋名單。</p>
              </div>
            </div>
            <ul>
              {version.unscheduled.map((place) => (
                <li key={place.tripPlaceId}>
                  <strong>{place.name}</strong>
                  <span>{reasonLabel(place.reason, t.timetable)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </section>
    );
  }

  return (
    <Dialog open={day !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="route-dialog max-[599px]:translate-x-0 max-[599px]:translate-y-0" showCloseButton>
        <DialogHeader className="route-page-heading">
          <DialogTitle>{t.dayPlan.title(day?.label ?? "", day?.date ?? "")}</DialogTitle>
          <DialogDescription>
            {timetable
              ? `${describeStartAndEnd(timetable, t.timetable)} ${t.dayPlan.draftNotice}`
              : t.dayPlan.draftNotice}
          </DialogDescription>
        </DialogHeader>

        {resolution.conflict ? <ConflictPanel conflict={resolution.conflict} busy={busy !== null}
          formatValue={(_path, value) => typeof value === "number" ? clock(value) : undefined}
          onAccept={() => { resolution.clear(); if (day && resolution.conflict?.current) void plan(day.id, order); else close(); }}
          onReapply={() => { const conflict = resolution.conflict; if (conflict?.current) void saveWindow(conflict.attempted, conflict.current.version, conflict.base.version); }}
          onEdit={() => { if (resolution.conflict?.current) setBase(resolution.conflict.current); resolution.resume(); }}
        /> : null}

        <form
          hidden={Boolean(resolution.conflict)}
          className="route-constraints"
          onSubmit={(event) => void replan(event)}
        >
          <div className="route-constraints-heading">
            <Clock3 />
            <div>
              <strong>可安排時間</strong>
              <span>固定行程與已確認限制會保留不動。</span>
            </div>
          </div>
          <label>
            <span>{t.dayPlan.start}</span>
            <input type="time" value={start} required onChange={(event) => setStart(event.target.value)} />
          </label>
          <label>
            <span>{t.dayPlan.end}</span>
            <input type="time" value={end} hidden={endOfDay} disabled={endOfDay} required={!endOfDay} onChange={(event) => setEnd(event.target.value)} />
            {endOfDay ? <span className="route-end-of-day">當天結束（24:00）</span> : null}
          </label>
          <label className="route-endday-toggle">
            <input type="checkbox" checked={endOfDay} onChange={(event) => setEndOfDay(event.target.checked)} />
            <span>安排到當天結束（24:00）</span>
          </label>
          <Button type="submit" variant="outline" size="lg" disabled={busy !== null || !timetable}>
            {t.dayPlan.rePlan}
          </Button>
        </form>

        {error ? <p role="alert" className="route-error">{error}</p> : null}
        {busy === "planning" ? <p role="status" className="route-status">{t.dayPlan.planning}</p> : null}
        {notice ? <p role="status" className="route-status">{notice}</p> : null}

        {timetable ? (
          <div className="route-comparison">
            <section className="route-summary" data-testid="day-load">
              <Route />
              <div>
                <strong>
                  {t.dayPlan.loadSummary(
                    loadLabel(timetable.load.level, t.timetable),
                    span(timetable.load.busyMinutes, t.timetable),
                    span(timetable.load.windowMinutes, t.timetable),
                  )}
                </strong>
                <span>
                  {timetable.unscheduled.length > 0
                    ? `${timetable.unscheduled.length} 個地點排不進去；先比較，再決定要不要改。`
                    : "固定事項不會移動；先比較，再決定要不要改。"}
                </span>
              </div>
            </section>

            {unknownLegCount > 0 ? (
              <aside className="route-unknown">
                <HelpCircle />
                <div>
                  <strong>{unknownLegCount} 段交通時間查不到</strong>
                  <span>資料不完整的路段不顯示推測的抵達時間。</span>
                </div>
              </aside>
            ) : null}

            <div className="route-evidence" aria-label="時間資料說明">
              <span className="route-evidence-label">時間依據</span>
              {hoursChecked ? <span className="route-evidence-chip"><Check /> 確定：營業時間</span> : null}
              <span className="route-evidence-chip route-evidence-estimated">
                <Clock3 /> 估計：路線與停留時間
              </span>
              {attributions.length > 0 ? (
                <span className="route-evidence-source">{t.dayPlan.routeTimes(attributions.join("、"))}</span>
              ) : null}
            </div>

            <div className="route-segments" role="tablist" aria-label="比較順序">
              <button
                type="button"
                role="tab"
                aria-selected={order === "suggested"}
                disabled={!comparisons.suggested}
                onClick={() => selectDisplayedOrder("suggested")}
              >
                <Sparkles />
                <span>建議</span>
                <Check className="route-selection-mark" />
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={order === "current"}
                disabled={!comparisons.current}
                onClick={() => selectDisplayedOrder("current")}
              >
                <ListOrdered />
                <span>目前</span>
                <Check className="route-selection-mark" />
              </button>
            </div>

            <div className="route-versions">
              {timetableVersion("current")}
              {timetableVersion("suggested")}
            </div>
          </div>
        ) : null}

        <DialogFooter hidden={Boolean(resolution.conflict) || !timetable} className="route-actionbar">
          {order === "suggested" ? (
            <>
              <Button
                variant="outline"
                size="lg"
                disabled={busy !== null || !comparisons.current}
                onClick={() => selectDisplayedOrder("current")}
              >
                <ListOrdered /> {t.dayPlan.backToCurrentOrder}
              </Button>
              <Button
                size="lg"
                disabled={busy !== null || orderStale || !timetable || timetable.orderedTripPlaceIds.length === 0}
                onClick={() => void saveOrder()}
              >
                <Check /> {busy === "saving" ? t.dayPlan.saving : t.dayPlan.useThisOrder}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="lg"
              disabled={busy !== null || !comparisons.suggested}
              onClick={() => selectDisplayedOrder("suggested")}
            >
              <Sparkles /> {t.dayPlan.trySuggestedOrder}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
