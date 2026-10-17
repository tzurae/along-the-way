import { type FormEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  parseDayTimetableResponse,
  parseDayWindowResponse,
  type DayTimetableDto,
  type DayTimetableOrder,
  type DayTimetableResponse,
  type DayWindowResponse,
  type DayWindowDto,
  TAXI_BUFFER_MINUTES,
  orderWithout,
  addOutcome,
  TRAVEL_MODES,
  type TravelMode,
} from "@along-the-way/contracts/day-plans";
import { parseTripPlaceListResponse, type TripPlaceListResponse } from "@along-the-way/contracts/trip-places";
import { Check, ChevronDown, Clock3, GripVertical, HelpCircle, Plus, RotateCcw, Route, TriangleAlert, X } from "lucide-react";

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
  LoadBadge,
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

/** A located place with no day yet that can be brought into the day being arranged. */
export interface AddablePlace {
  id: string;
  name: string;
  /** In 待安排: already chosen for the itinerary, waiting for a date. */
  pending: boolean;
  /** The day it was taken off, when it came from one. */
  priorDate: string | null;
}

/** How long a place's visit takes in the scheduler: entered by someone, or the default for its type. */
export interface PlaceStay {
  minutes: number;
  estimated: boolean;
}

function minuteOf(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

const TRAVEL_MODE_LABEL: Record<TravelMode, string> = { transit: "大眾運輸", taxi: "計程車", walk: "盡量走路" };
const TRAVEL_MODE_NOTE: Record<TravelMode, string> = {
  transit: "走路 15 分鐘內就走路，其他搭電車或公車；查不到大眾運輸的路段會標成查不到，不會改成走很久。",
  taxi: `每段都算計程車車程，再多留 ${TAXI_BUFFER_MINUTES} 分鐘等車。`,
  walk: "在上限內走路，超過就搭大眾運輸；查不到大眾運輸的路段會標成查不到。",
};

const placedIds = (version: DayTimetableDto) =>
  version.rows.flatMap((row) => (row.kind === "visit" ? [row.tripPlaceId] : []));

/** End of the day's plan: the return to the lodging, else the last visit's end. */
function dayEnd(version: DayTimetableDto) {
  const last = version.rows.at(-1);
  if (last?.kind === "return") return last.arriveMinute;
  const ends = version.rows.flatMap((row) => (row.kind === "visit" ? [row.endMinute] : []));
  return ends.length ? Math.max(...ends) : null;
}

/** A walk stands in for a train time that could not be found. */
const walkEstimated = (version: DayTimetableDto) => version.rows.some((row) =>
  row.kind !== "start" && row.travel?.mode === "walking" && row.travel.transitMinutes === null && (row.travel.durationMinutes ?? 0) > 15);

/** Color follows meaning, never the sign: worse travel is amber, a dropped place red, the member's own choices neutral. */
type Tone = "good" | "warn" | "bad" | "neutral";
interface Note { text: string; tone: Tone }

/**
 * How the candidate differs from the saved order. Which places get placed comes first: a shorter
 * day that lost a place is not better, so times are compared only when both place the same places.
 */
function compareToSaved(candidate: DayTimetableDto, saved: DayTimetableDto, names: Map<string, string>, messages: Parameters<typeof reasonLabel>[1]): Note[] {
  const notes: Note[] = [];
  const savedPlaced = new Set(placedIds(saved));
  const candidatePlaced = new Set(placedIds(candidate));
  const savedListed = new Set([...saved.orderedTripPlaceIds]);
  const candidateListed = new Set(candidate.orderedTripPlaceIds);
  for (const id of savedListed) if (!candidateListed.has(id)) notes.push({ text: `移到待安排：${names.get(id) ?? "地點"}`, tone: "neutral" });
  for (const id of candidateListed) if (!savedListed.has(id) && candidatePlaced.has(id)) notes.push({ text: `排進這天：${names.get(id) ?? "地點"}`, tone: "neutral" });
  for (const place of candidate.unscheduled) {
    if (savedPlaced.has(place.tripPlaceId) || !savedListed.has(place.tripPlaceId)) {
      notes.unshift({ text: `排不進去：${place.name}（${reasonLabel(place.reason, messages)}）`, tone: "bad" });
    }
  }
  for (const row of candidate.rows) {
    if (row.kind === "visit" && savedListed.has(row.tripPlaceId) && !savedPlaced.has(row.tripPlaceId)) notes.push({ text: `多排進：${row.name}`, tone: "good" });
  }
  const samePlaces = savedPlaced.size === candidatePlaced.size && [...savedPlaced].every((id) => candidatePlaced.has(id));
  // Different places: the place changes are the answer; times of different days do not compare.
  if (!samePlaces) return notes;
  const legs = (version: DayTimetableDto) => version.rows.flatMap((row) => (row.kind !== "start" && row.travel ? [row.travel.durationMinutes] : []));
  if ([...legs(candidate), ...legs(saved)].some((minutes) => minutes === null)) {
    notes.push({ text: "部分交通時間查不到，無法比較", tone: "neutral" });
    return notes;
  }
  const sum = (values: Array<number | null>) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
  const estimated = walkEstimated(candidate) || walkEstimated(saved);
  const mark = estimated ? "（估）" : "";
  // An estimate never looks certain: an estimated difference is shown without a good/worse color.
  const judged = (delta: number): Tone => (estimated ? "neutral" : delta < 0 ? "good" : "warn");
  const travel = sum(legs(candidate)) - sum(legs(saved));
  const wait = sum(candidate.rows.map((row) => (row.kind === "visit" ? row.waitMinutes : 0)))
    - sum(saved.rows.map((row) => (row.kind === "visit" ? row.waitMinutes : 0)));
  const end = dayEnd(candidate);
  const savedEnd = dayEnd(saved);
  // Same places in another order is a change even when the totals happen to match.
  const reordered = placedIds(candidate).join() !== placedIds(saved).join();
  const modesChanged = candidate.orderedTripPlaceIds.some((id) => (candidate.legModes[id] ?? null) !== (saved.legModes[id] ?? null));
  const changes = [reordered ? "順序" : null, modesChanged ? "交通方式" : null].filter(Boolean).join("、");
  if (travel === 0 && wait === 0 && end === savedEnd && notes.length === 0) {
    return [{ text: changes ? `${changes}不同，總時間跟已儲存相同` : "跟已儲存的時間相同", tone: "neutral" }];
  }
  if (changes) notes.push({ text: `${changes}不同`, tone: "neutral" });
  if (travel !== 0) notes.push({ text: `交通${travel < 0 ? "少" : "多"} ${Math.abs(travel)} 分${mark}`, tone: judged(travel) });
  if (wait !== 0) notes.push({ text: `等開門${wait < 0 ? "少" : "多"} ${Math.abs(wait)} 分${mark}`, tone: judged(wait) });
  if (end !== null && savedEnd !== null && end !== savedEnd) {
    const delta = end - savedEnd;
    const label = candidate.rows.at(-1)?.kind === "return" ? "回到住宿" : "結束";
    notes.push({ text: `${clock(end)} ${label}（${delta > 0 ? "晚" : "早"} ${Math.abs(delta)} 分）`, tone: "neutral" });
  }
  return notes;
}
/** A draft timetable for one day. Only the day's hours and an explicitly saved arrangement are stored. */
export function DayPlanDialog({
  tripId,
  day,
  canArrange,
  request,
  addablePlaces,
  coordinates,
  stays,
  onClose,
  onOrderSaved,
}: {
  tripId: string;
  day: PlannedDay | null;
  /** Owner, or an editor the owner allows to arrange the itinerary. */
  canArrange: boolean;
  request: JsonRequest;
  /** Located places with no day yet: 待安排 first, then the wishlist. */
  addablePlaces: AddablePlace[];
  /** Coordinates of the day's and addable places, for placing an added stop beside its neighbours. */
  coordinates: Map<string, { latitude: number; longitude: number }>;
  /** Each place's stay as the scheduler counts it, shown in 待選區 and used in the drag estimate. */
  stays: Map<string, PlaceStay>;
  onClose(): void;
  onOrderSaved(): Promise<void>;
}) {
  const { t } = useI18n();
  const [comparisons, setComparisons] = useState<Partial<Record<DayTimetableOrder, DayTimetableDto>>>({});
  // Phone shows one version at a time; desktop shows both side by side.
  const [view, setView] = useState<"candidate" | "saved">("candidate");
  const [start, setStart] = useState("09:00");
  // The day's way of travel, edited with its hours and saved together with them.
  const [travelMode, setTravelMode] = useState<TravelMode>("transit");
  const [walkLimit, setWalkLimit] = useState(15);
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

  const saved = comparisons.current ?? null;
  // The one alternative on offer: the member's arrangement once there is one, else the straight-line order.
  const candidate = comparisons.custom ?? comparisons.suggested ?? null;
  const shown = view === "saved" ? saved : candidate ?? saved;

  /** Drafts one version; `accept` may refuse a draft, which then leaves the dialog unchanged. */
  const plan = useCallback(async (
    dayId: string,
    nextOrder: DayTimetableOrder,
    orderedTripPlaceIds?: string[],
    legModes?: Record<string, TravelMode>,
    accept?: (timetable: DayTimetableDto) => boolean,
  ) => {
    const ticket = ++latestRequest.current;
    setBusy("planning");
    setError("");
    try {
      const response = await request<DayTimetableResponse>(`/api/trips/${tripId}/days/${dayId}/timetable`, {
        method: "POST",
        body: JSON.stringify(nextOrder === "custom" ? { order: nextOrder, orderedTripPlaceIds, legModes: legModes ?? {} } : { order: nextOrder }),
        parse: parseDayTimetableResponse,
      });
      if (ticket !== latestRequest.current) return;
      if (accept && !accept(response.timetable)) return response.timetable;
      setComparisons((current) => ({ ...current, [nextOrder]: response.timetable }));
      setStale((current) => current.filter((kind) => kind !== nextOrder));
      if (nextOrder === "current") {
        setStart(clock(response.timetable.window.startMinute));
        setEndOfDay(response.timetable.window.endMinute === 1440);
        if (response.timetable.window.endMinute !== 1440) setEnd(clock(response.timetable.window.endMinute));
        setTravelMode(response.timetable.window.travelMode);
        setWalkLimit(response.timetable.window.walkLimitMinutes);
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

  /** Drafts the saved order and the straight-line order; a member's arrangement is redrafted from its own list. */
  const planAll = useCallback(async (dayId: string, epoch: number, custom?: string[]) => {
    if (!await plan(dayId, "current") || epoch !== dialogEpoch.current) return;
    if (!await plan(dayId, "suggested") || epoch !== dialogEpoch.current) return;
    if (custom) await plan(dayId, "custom", custom);
  }, [plan]);

  // Versions drafted under the day's previous hours. Only what is on screen is redrafted after an
  // hours change (each draft costs route lookups); the rest is redrafted when it is next shown.
  const [stale, setStale] = useState<DayTimetableOrder[]>([]);

  /** After the day's hours change: the saved order (every comparison needs it) and the version on screen. */
  async function replanShown(dayId: string, epoch: number) {
    const customIds = comparisons.custom?.orderedTripPlaceIds;
    const candidateKind: DayTimetableOrder = customIds ? "custom" : "suggested";
    if (!await plan(dayId, "current") || epoch !== dialogEpoch.current) return;
    if (view === "candidate") await plan(dayId, candidateKind, customIds, comparisons.custom?.legModes);
    setStale((["suggested", "custom"] as const).filter((kind) =>
      comparisons[kind] && !(view === "candidate" && kind === candidateKind)));
  }

  /** Shows a version, redrafting it first if the day's hours changed since it was drafted. */
  function showVersion(next: "candidate" | "saved") {
    setView(next);
    const kind: DayTimetableOrder = next === "saved" ? "current" : comparisons.custom ? "custom" : "suggested";
    if (day && stale.includes(kind)) void plan(day.id, kind, kind === "custom" ? comparisons.custom?.orderedTripPlaceIds : undefined, comparisons.custom?.legModes);
  }

  useEffect(() => {
    latestRequest.current += 1;
    const epoch = ++dialogEpoch.current;
    setComparisons({});
    setView("candidate");
    setStale([]);
    setBusy(null);
    setNotice("");
    setError("");
    setBase(null);
    // An offer made for another day (or before the dialog closed) must not be taken here.
    setTrial(null);
    latestSwap.current = null;
    latestTaxi.current = null;
    resolution.clear();
    if (day) void planAll(day.id, epoch);
    return () => { dialogEpoch.current += 1; latestRequest.current += 1; };
  }, [day, planAll]);

  async function saveWindow(input: DayWindowDto & { travelMode?: TravelMode; walkLimitMinutes?: number }, expectedVersion: number, conflictBase = resolution.conflictBaseVersion) {
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
      await replanShown(day.id, epoch);
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
    const savedWindow = saved?.window;
    const settingsChanged = savedWindow !== undefined && (travelMode !== savedWindow.travelMode || walkLimit !== savedWindow.walkLimitMinutes);
    if (startMinute !== base.input.startMinute || endMinute !== base.input.endMinute || settingsChanged) {
      await saveWindow({ startMinute, endMinute, travelMode, walkLimitMinutes: walkLimit }, base.version);
    } else await replanShown(day.id, dialogEpoch.current);
  }

  // Names of every place the dialog may mention, including ones taken out of the candidate.
  const names = new Map<string, string>();
  for (const version of [saved, comparisons.suggested, comparisons.custom]) {
    for (const row of version?.rows ?? []) if (row.kind === "visit") names.set(row.tripPlaceId, row.name);
    for (const place of version?.unscheduled ?? []) names.set(place.tripPlaceId, place.name);
  }
  for (const place of addablePlaces) names.set(place.id, place.name);
  const label = (id: string) => names.get(id) ?? "地點";

  /** Saves the candidate as the day: removals go to 待安排, additions join, and the order sticks, in one transaction. */
  async function saveArrangement() {
    if (!canArrange) {
      setError(t.schedule.ownerOnlyAction);
      return;
    }
    if (!day || !candidate) return;
    const epoch = dialogEpoch.current;
    const orderedTripPlaceIds = candidate.orderedTripPlaceIds;
    const identity = `arrange:${day.id}:${candidate.window.version}:${orderedTripPlaceIds.join(",")}`;
    setBusy("saving");
    setError("");
    try {
      await request<TripPlaceListResponse>(`/api/trips/${tripId}/days/${day.id}/arrangement`, {
        method: "PUT",
        headers: { "Idempotency-Key": keyFor(identity) },
        body: JSON.stringify({ orderedTripPlaceIds, expectedVersion: candidate.window.version, legModes: candidate.legModes }),
        parse: parseTripPlaceListResponse,
      });
      keys.current.delete(identity);
      await onOrderSaved();
      if (epoch !== dialogEpoch.current) return;
      setComparisons({});
      setView("candidate");
      setNotice(`已儲存為${day.label}的安排。`);
      await planAll(day.id, epoch);
    } catch (reason) {
      if (epoch !== dialogEpoch.current) return;
      if (reason instanceof ApiRequestError && (reason.code === "forbidden" || reason.status === 403)) {
        setError(t.schedule.ownerOnlyAction);
      } else if (reason instanceof ApiRequestError && reason.code === "conflict") {
        setOrderStale(true);
        setError(t.collaboration.replanDay);
      } else setError(reason instanceof Error ? reason.message : t.dayPlan.couldNotSaveOrder);
    } finally {
      if (epoch === dialogEpoch.current) setBusy(null);
    }
  }

  /** Redrafts the candidate from a new list of places, and optionally new ways to reach them. */
  async function arrange(next: string[], legModes?: Record<string, TravelMode>, accept?: (timetable: DayTimetableDto) => boolean) {
    if (!day || !candidate) return;
    const modes = legModes ?? candidate.legModes;
    if (next.join() === candidate.orderedTripPlaceIds.join() && JSON.stringify(modes) === JSON.stringify(candidate.legModes)) return;
    setNotice("");
    setTrial(null);
    setView("candidate");
    await plan(day.id, "custom", next, modes, accept);
  }

  /**
   * Takes a place out of the day. Its way of arrival goes with it: brought back later, it arrives
   * from somewhere else and follows the day's way again. Placed stops keep their order, and a
   * removal that would still push one out (say, the new shortcut has no transit) is refused.
   */
  function takeOut(version: DayTimetableDto, id: string) {
    const { [id]: _removed, ...legModes } = version.legModes;
    const keep = placedIds(version).filter((visit) => visit !== id);
    void arrange(orderWithout(version.orderedTripPlaceIds, id, placedIds(version)), legModes, (result) => {
      const placed = new Set(placedIds(result));
      const lost = result.unscheduled.filter((entry) => keep.includes(entry.tripPlaceId) && !placed.has(entry.tripPlaceId));
      if (lost.length === 0) return true;
      setError(`拿掉「${label(id)}」後，${lost.map((entry) => `「${entry.name}」`).join("、")}會排不進去（${reasonLabel(lost[0]!.reason, t.timetable)}），所以沒有拿掉。可以先改它的交通方式再拿掉。`);
      return false;
    });
  }

  /** One leg's way of travel: `null` follows the day's. */
  function setLegMode(id: string, mode: TravelMode | null) {
    if (!candidate) return;
    const next = { ...candidate.legModes };
    if (mode === null) delete next[id];
    else next[id] = mode;
    void arrange(candidate.orderedTripPlaceIds, next);
  }

  // Adding asks the server for one draft. Only a clean fit changes the candidate; a place that
  // cannot fit, fits by taxi, or would push others out is answered beside its own button.
  const [trial, setTrial] = useState<{ placeId: string; kind: "trying" | "nofit" | "swap" | "taxi"; text: string; pushed: string[] } | null>(null);

  /**
   * Drafts the candidate with a place added: at `orderedTripPlaceIds` when the member dropped it
   * somewhere, else the server tries every slot. One request either way.
   */
  async function tryAdd(place: { id: string; name: string }, orderedTripPlaceIds?: string[]) {
    if (!day || !candidate) return;
    const epoch = dialogEpoch.current;
    setTrial({ placeId: place.id, kind: "trying", text: "", pushed: [] });
    setBusy("planning");
    setError("");
    try {
      const { timetable: result } = await request<DayTimetableResponse>(`/api/trips/${tripId}/days/${day.id}/timetable`, {
        method: "POST",
        body: JSON.stringify(orderedTripPlaceIds
          ? { order: "custom", orderedTripPlaceIds, legModes: candidate.legModes, taxiFallbackFor: place.id }
          : { order: "custom", orderedTripPlaceIds: candidate.orderedTripPlaceIds, insertTripPlaceId: place.id, legModes: candidate.legModes }),
        parse: parseDayTimetableResponse,
      });
      if (epoch !== dialogEpoch.current) return;
      const outcome = addOutcome(placedIds(candidate), placedIds(result), place.id, result.taxiAlternative);
      if (outcome.kind === "taxi") {
        // The day's way does not fit, but taxi into and/or out of the place does: offer exactly that.
        const taxi = outcome.taxi;
        const end = dayEnd(taxi.timetable);
        const changed = Object.keys(taxi.legModes).filter((id) => taxi.legModes[id] !== candidate.legModes[id]);
        const onward = changed.find((id) => id !== place.id);
        const legs = changed.includes(place.id)
          ? onward ? "前後兩段" : `前往「${place.name}」這段`
          : `從「${place.name}」到「${label(onward ?? "")}」這段`;
        setTrial({
          placeId: place.id,
          kind: "taxi",
          pushed: [],
          text: `照這天的交通方式排不下「${place.name}」；${legs}改搭計程車就排得進${end !== null ? `（會到 ${clock(end)}）` : ""}。要改嗎？`,
        });
        latestTaxi.current = taxi.timetable;
      } else if (outcome.kind === "nofit") {
        const reason = result.unscheduled.find((entry) => entry.tripPlaceId === place.id)?.reason;
        // No route answer is not "does not fit": say the lookup failed instead of blaming the day.
        setTrial({ placeId: place.id, kind: "nofit", pushed: [], text: reason === "travel_unknown"
          ? `查不到「${place.name}」的交通時間（路線服務可能暫時無法使用、額度用完，或這段沒有大眾運輸），還無法判斷排不排得下。原安排沒有變。`
          : `${orderedTripPlaceIds ? "放在這裡" : "這天"}排不下「${place.name}」${reason ? `（${reasonLabel(reason, t.timetable)}）` : ""}，${orderedTripPlaceIds ? "前後" : "放在最合適的位置"}改搭計程車也排不下。原安排沒有變。` });
      } else if (outcome.kind === "swap") {
        const pushed = result.unscheduled.filter((entry) => outcome.pushed.includes(entry.tripPlaceId));
        setTrial({
          placeId: place.id,
          kind: "swap",
          pushed: outcome.pushed,
          text: `加入「${place.name}」會讓${pushed.map((entry) => `「${entry.name}」`).join("、")}排不進去${pushed[0] ? `（${reasonLabel(pushed[0].reason, t.timetable)}）` : ""}。要交換嗎？`,
        });
        latestSwap.current = result;
      } else {
        setComparisons((current) => ({ ...current, custom: result }));
        setView("candidate");
        setTrial(null);
      }
    } catch (reason) {
      if (epoch !== dialogEpoch.current) return;
      setTrial(null);
      setError(reason instanceof Error ? reason.message : t.dayPlan.couldNotPlan);
    } finally {
      if (epoch === dialogEpoch.current) setBusy(null);
    }
  }
  const latestSwap = useRef<DayTimetableDto | null>(null);
  const latestTaxi = useRef<DayTimetableDto | null>(null);

  /** Takes the swap: the new place stays where it fit; the places it pushed out leave the day for 待安排. */
  function acceptSwap() {
    const result = latestSwap.current;
    if (!trial || trial.kind !== "swap" || !result) return;
    const pushed = new Set(trial.pushed);
    const legModes = Object.fromEntries(Object.entries(result.legModes).filter(([id]) => !pushed.has(id)));
    void arrange(result.orderedTripPlaceIds.filter((id) => !pushed.has(id)), legModes);
  }

  /** Takes the taxi draft the server already made: no further request. */
  function acceptTaxi() {
    const result = latestTaxi.current;
    if (!trial || trial.kind !== "taxi" || !result) return;
    setComparisons((current) => ({ ...current, custom: result }));
    setView("candidate");
    setTrial(null);
  }

  /** Moves `id` to `index` among the candidate's other placed visits; unplaced places keep their slots. */
  function reorder(id: string, index: number) {
    if (!candidate) return;
    const visits = placedIds(candidate);
    const others = visits.filter((visit) => visit !== id);
    const rest = candidate.orderedTripPlaceIds.filter((entry) => entry !== id);
    const anchor = others[index];
    const at = anchor !== undefined ? rest.indexOf(anchor) : rest.indexOf(others.at(-1) ?? "") + 1;
    void arrange([...rest.slice(0, at), id, ...rest.slice(at)]);
  }

  // One drag model for the candidate: a timeline row (reorder, or drop on 待選區 to take it out)
  // or a 待選區 place (drop between stops to put it in; each slot says up front whether it fits).
  const [drag, setDrag] = useState<{ id: string; source: "timeline" | "pool"; startY: number; moved: boolean; targetIndex: number; overPool: boolean } | null>(null);
  const dragRef = useRef(drag);
  function updateDrag(next: typeof drag) {
    dragRef.current = next;
    setDrag(next);
  }

  function dropIndex(id: string, y: number) {
    const rows = [...document.querySelectorAll<HTMLElement>(`[data-route-version="candidate"] li.route-stop-draggable`)]
      .filter((row) => row.dataset.tripPlaceId !== id);
    return rows.filter((row) => {
      const box = row.getBoundingClientRect();
      return box.top + box.height / 2 < y;
    }).length;
  }

  /** Position in the candidate's list for a drop before the `targetIndex`-th placed stop (after the last when past it). */
  function listIndexFor(id: string, targetIndex: number) {
    if (!candidate) return 0;
    const others = placedIds(candidate).filter((visit) => visit !== id);
    const rest = candidate.orderedTripPlaceIds.filter((entry) => entry !== id);
    const anchor = others[targetIndex];
    return anchor !== undefined ? rest.indexOf(anchor) : rest.indexOf(others.at(-1) ?? "") + 1;
  }

  /**
   * A quick guess while dragging, with no route lookup: straight-line distance turned into each
   * leg's way of travel (walk within its walk limit, else transit; or taxi), plus the place's stay,
   * against the day's end; and, like the server, taxi into the place, out of it, or both. The real
   * answer comes from one draft when the place is dropped.
   */
  function estimateSlot(id: string, targetIndex: number) {
    if (!candidate) return null;
    const others = placedIds(candidate).filter((visit) => visit !== id);
    const before = others[targetIndex - 1];
    const after = others[targetIndex];
    const dayMode = candidate.window.travelMode;
    const travel = (a: string | undefined, b: string | undefined, mode: TravelMode) => {
      const from = a ? coordinates.get(a) : undefined;
      const to = b ? coordinates.get(b) : undefined;
      if (!a || !b) return 0;
      if (!from || !to) return null;
      const km = Math.hypot(from.latitude - to.latitude, (from.longitude - to.longitude) * Math.cos(from.latitude * Math.PI / 180)) * 111;
      if (mode === "taxi") return Math.round(3 + km / 25 * 60 + TAXI_BUFFER_MINUTES);
      const walk = km / 4.8 * 60;
      const limit = mode === "walk" ? candidate.window.walkLimitMinutes : 15;
      return Math.round(walk <= limit ? walk : 10 + km / 20 * 60);
    };
    const modeTo = (target: string | undefined) => (target ? candidate.legModes[target] ?? dayMode : dayMode);
    const into = travel(before, id, modeTo(id));
    const onward = travel(id, after, modeTo(after));
    const replaced = travel(before, after, modeTo(after));
    const taxiInto = travel(before, id, "taxi");
    const taxiOnward = travel(id, after, "taxi");
    if (into === null || onward === null || replaced === null || taxiInto === null || taxiOnward === null) return null;
    const stay = stays.get(id)?.minutes ?? 60;
    const start = dayEnd(candidate) ?? candidate.window.startMinute;
    const extra = into + stay + onward - replaced;
    const end = start + extra;
    const taxiEnd = start + stay - replaced + Math.min(taxiInto + onward, into + taxiOnward, taxiInto + taxiOnward);
    return {
      fits: end <= candidate.window.endMinute,
      taxiFits: taxiEnd <= candidate.window.endMinute,
      extra, end, taxiEnd, into, stay, onward, replaced, before, after,
    };
  }

  /** Drop from 待選區: one draft at the chosen slot; only a clean fit changes the candidate. */
  function dropOnDay(id: string, targetIndex: number) {
    if (!candidate) return;
    const at = listIndexFor(id, targetIndex);
    const rest = candidate.orderedTripPlaceIds.filter((entry) => entry !== id);
    void tryAdd({ id, name: label(id) }, [...rest.slice(0, at), id, ...rest.slice(at)]);
  }

  function startDrag(event: ReactPointerEvent<HTMLButtonElement>, id: string, source: "timeline" | "pool", index: number) {
    if (busy !== null || event.button !== 0) return;
    event.preventDefault();
    setTrial(null);
    updateDrag({ id, source, startY: event.clientY, moved: false, targetIndex: index, overPool: false });
    const pointerId = event.pointerId;
    const move = (moveEvent: PointerEvent) => {
      const current = dragRef.current;
      if (moveEvent.pointerId !== pointerId || !current) return;
      const moved = current.moved || Math.abs(moveEvent.clientY - current.startY) > 6;
      const overPool = Boolean(document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest("[data-route-pool]"));
      updateDrag({ ...current, moved, overPool, targetIndex: moved ? dropIndex(id, moveEvent.clientY) : current.targetIndex });
    };
    const finish = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      const current = dragRef.current;
      updateDrag(null);
      if (endEvent.type !== "pointerup" || !current?.moved || !candidate) return;
      if (current.source === "timeline") {
        // Dragged out onto 待選區: the place leaves the day.
        if (current.overPool) takeOut(candidate, id);
        else reorder(id, current.targetIndex);
      } else if (!current.overPool) dropOnDay(id, current.targetIndex);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  function dragHandle(id: string, name: string, index: number) {
    return (
      <button
        type="button"
        className="route-drag-handle"
        aria-label={`拖曳「${name}」調整順序，或拖到待選區拿掉；也可用上下鍵`}
        aria-disabled={busy !== null}
        onPointerDown={(event) => startDrag(event, id, "timeline", index)}
        onKeyDown={(event) => {
          const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
          if (step === 0 || busy !== null) return;
          event.preventDefault();
          reorder(id, Math.max(0, index + step));
        }}
      >
        <GripVertical aria-hidden="true" />
      </button>
    );
  }

  const attributions = shown
    ? [...new Set(shown.rows.flatMap((row) =>
        row.kind !== "start" && row.travel?.attribution ? [row.travel.attribution] : []))]
    : [];
  const visitCount = shown?.rows.filter((row) => row.kind === "visit").length ?? 0;
  const hoursFound = shown?.rows.filter((row) => row.kind === "visit" && row.hours === "listed").length ?? 0;
  const unknownLegCount = shown?.rows.filter((row) =>
    row.kind !== "start" && row.travel?.durationMinutes === null).length ?? 0;
  const estimatedLegCount = shown?.rows.filter((row) =>
    row.kind !== "start" && row.travel?.mode === "walking" && row.travel.transitMinutes === null && (row.travel.durationMinutes ?? 0) > 15).length ?? 0;

  /**
   * Plain-language account of the day's room, from the scheduler's own capacity facts: what fixes
   * the start (arrival), what ends it early (departure), and the free gaps places were tried in.
   * Shown only when a place failed for lack of time; other reasons explain themselves per row.
   */
  function capacityNotes(version: DayTimetableDto) {
    if (!version.unscheduled.some((place) => place.reason === "not_enough_time")) return [];
    const { arrival, departure, gaps } = version.capacity;
    const notes: string[] = [];
    if (arrival) notes.push(t.dayPlan.afterArrival(arrival.title, clock(arrival.endMinute), arrival.afterBufferMinutes));
    if (departure) {
      const lastGap = gaps.at(-1);
      notes.push(t.dayPlan.beforeDeparture(departure.title, clock(departure.startMinute), lastGap ? clock(lastGap.endMinute) : null));
    }
    const longest = gaps.reduce<(typeof gaps)[number] | null>(
      (best, gap) => (!best || gap.endMinute - gap.startMinute > best.endMinute - best.startMinute ? gap : best),
      null,
    );
    notes.push(longest
      ? t.dayPlan.longestGap(clock(longest.startMinute), clock(longest.endMinute), span(longest.endMinute - longest.startMinute, t.timetable))
      : t.dayPlan.noGap(clock(version.window.startMinute), clock(version.window.endMinute)));
    return notes;
  }

  /** `editable`: the candidate, where a place that does not fit can be taken out right here. */
  function unscheduledSection(version: DayTimetableDto, editable = false) {
    const added = new Set(saved ? version.orderedTripPlaceIds.filter((id) => !saved.orderedTripPlaceIds.includes(id)) : []);
    return version.unscheduled.length > 0 ? (
      <section className="route-unscheduled" aria-label={t.dayPlan.notInDraft}>
        <div className="route-unscheduled-heading">
          <TriangleAlert />
          <div>
            <h4>{t.dayPlan.notInDraft}</h4>
            {capacityNotes(version).map((note) => <p key={note}>{note}</p>)}
            <p>{editable && canArrange ? "可以把它拿掉，或拿掉別的地點騰出時間。" : t.dayPlan.unscheduledNextStep}</p>
          </div>
        </div>
        <ul>
          {version.unscheduled.map((place) => (
            <li key={place.tripPlaceId}>
              <strong>{place.name}</strong>
              <span>{reasonLabel(place.reason, t.timetable)}</span>
              {editable && canArrange && version.orderedTripPlaceIds.includes(place.tripPlaceId) ? (
                <button type="button" className="route-remove-button" disabled={busy !== null}
                  onClick={() => takeOut(version, place.tripPlaceId)}>
                  <X aria-hidden="true" /> {added.has(place.tripPlaceId) ? "拿掉" : "這天不去"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    ) : null;
  }

  function savedVersion() {
    if (!saved) return null;
    return (
      <section className="route-version" data-active={view === "saved"} data-route-version="saved" aria-label="已儲存的順序">
        <header className="route-version-heading">
          <h3>已儲存</h3>
          <span>目前的行程</span>
        </header>
        {saved.rows.length > 0 ? (
          <ol className="route-timeline" aria-label={t.dayPlan.draftTimetable}>
            {saved.rows.map((row, index) => <TimetableRow key={`${row.kind}-${index}`} row={row} />)}
          </ol>
        ) : <p className="route-optimal">{t.dayPlan.nothingFits}</p>}
        {unscheduledSection(saved)}
      </section>
    );
  }

  function candidateVersion() {
    if (!candidate || !saved) return null;
    const arranged = Boolean(comparisons.custom);
    const draggable = canArrange;
    const others = drag?.moved
      ? placedIds(candidate).filter((id) => id !== drag.id)
      : [];
    // While a 待選區 place is over the day: the stops around the slot tint green or red from a
    // straight-line estimate (no route lookup while dragging); dropping asks the server once.
    const poolDrag = drag?.moved && drag.source === "pool" && !drag.overPool ? drag : null;
    const estimate = poolDrag ? estimateSlot(poolDrag.id, poolDrag.targetIndex) : null;
    const fitTone = !poolDrag ? "" : estimate === null ? " fit-pending" : estimate.fits ? " fit-ok" : estimate.taxiFits ? " fit-warn" : " fit-bad";
    const neighbours = poolDrag ? new Set([others[poolDrag.targetIndex - 1], others[poolDrag.targetIndex]].filter(Boolean)) : new Set<string>();
    const hint = !poolDrag ? ""
      : estimate === null ? "沒有位置資料，放下後才知道排不排得下"
      : `${estimate.before ? `前往約 ${estimate.into} 分 ＋ ` : ""}停留${stays.get(poolDrag.id)?.estimated === false ? "" : "約"} ${estimate.stay} 分${estimate.after ? ` ＋ 到下一站約 ${estimate.onward} 分` : ""}，比原本多約 ${Math.max(0, estimate.extra)} 分；`
        + (estimate.fits
          ? `估計排得進（會到 ${clock(estimate.end)}），放下後確認`
          : estimate.taxiFits
            ? `照這天的交通方式估計排不下（會到 ${clock(estimate.end)}）；前後改搭計程車估計可以（最早會到 ${clock(estimate.taxiEnd)}）`
            : `估計排不下：會到 ${clock(estimate.end)}，超過可安排的 ${clock(candidate.window.endMinute)}，搭計程車估計也不夠；放下後再確認`);
    const listed = new Set(candidate.orderedTripPlaceIds);
    // Nearest first, with the distance shown, so a place far from the day is easy to recognise.
    const nearestKm = (id: string) => {
      const at = coordinates.get(id);
      const distances = candidate.orderedTripPlaceIds.flatMap((other) => {
        const to = coordinates.get(other);
        return other !== id && at && to ? [Math.hypot(at.latitude - to.latitude, (at.longitude - to.longitude) * Math.cos(at.latitude * Math.PI / 180)) * 111] : [];
      });
      return distances.length ? Math.min(...distances) : null;
    };
    const poolItems = [
      ...saved.orderedTripPlaceIds.filter((id) => !listed.has(id))
        .map((id) => ({ id, name: label(id), pending: false, priorDate: null, km: nearestKm(id), fromDay: true })),
      ...addablePlaces.filter((place) => !listed.has(place.id))
        .map((place) => ({ ...place, km: nearestKm(place.id), fromDay: false }))
        .sort((left, right) => (left.km ?? Infinity) - (right.km ?? Infinity)),
    ];
    let visitIndex = 0;
    return (
      <section className="route-version" data-active={view === "candidate"} data-route-version="candidate" aria-label="可以改用的順序">
        <header className="route-version-heading">
          <h3>{arranged ? "我調整的" : "依直線距離排"}</h3>
          <span>預覽中・尚未儲存</span>
        </header>
        <p className="route-version-note">
          {arranged
            ? "從「依直線距離排」改來；時間已用新順序重算。"
            : "只看地點之間的距離，沒用電車時間或營業時間決定順序。"}
        </p>
        <div className="route-diff" aria-live="polite">
          <p className="route-diff-label">相較已儲存</p>
          <ul className="route-compare">
            {compareToSaved(candidate, saved, names, t.timetable).map((note) => (
              <li key={note.text} className={`route-compare-${note.tone}`}>{note.text}</li>
            ))}
          </ul>
          {estimatedLegCount > 0 && view === "candidate" ? (
            <p className="route-diff-estimate">{`交通時間未取得；其中 ${estimatedLegCount} 段暫以步行估算。`}</p>
          ) : null}
        </div>
        {arranged ? (
          <button type="button" className="route-link-button route-reset" disabled={busy !== null} onClick={() => {
            setComparisons((current) => ({ ...current, custom: undefined }));
            if (day && stale.includes("suggested")) void plan(day.id, "suggested");
            setTrial(null);
          }}>
            <RotateCcw aria-hidden="true" /> 還原成依直線距離排
          </button>
        ) : null}
        {candidate.rows.length > 0 ? (
          <ol className="route-timeline" aria-label={t.dayPlan.draftTimetable}>
            {hint ? <li className={`route-drop-hint${fitTone}`} aria-live="polite">{hint}</li> : null}
            {candidate.rows.map((row, index) => {
              if (row.kind !== "visit" || !draggable) return <TimetableRow key={`${row.kind}-${index}`} row={row} />;
              const position = visitIndex++;
              const dragged = drag?.moved && drag.id === row.tripPlaceId;
              const slot = others.indexOf(row.tripPlaceId);
              const marker = !drag?.moved || dragged
                ? ""
                : slot === drag.targetIndex ? " drop-before" : slot === others.length - 1 && drag.targetIndex >= others.length ? " drop-after" : "";
              const tone = neighbours.has(row.tripPlaceId) ? fitTone : "";
              return (
                <TimetableRow
                  key={`${row.kind}-${row.tripPlaceId}`}
                  row={row}
                  drag={{
                    handle: dragHandle(row.tripPlaceId, row.name, position),
                    className: `${dragged ? " is-dragging" : ""}${marker}${tone}`,
                    actions: (
                      <>
                        {/* The first stop of a day without lodging has no leg to choose a way of travel for. */}
                        {row.travel ? (
                          <select
                            className="route-leg-mode"
                            aria-label={`怎麼到「${row.name}」`}
                            value={candidate.legModes[row.tripPlaceId] ?? ""}
                            disabled={busy !== null}
                            onChange={(event) => setLegMode(row.tripPlaceId, event.target.value === "" ? null : event.target.value as TravelMode)}
                          >
                            <option value="">{`跟這天（${TRAVEL_MODE_LABEL[candidate.window.travelMode]}）`}</option>
                            {TRAVEL_MODES.map((mode) => <option key={mode} value={mode}>{TRAVEL_MODE_LABEL[mode]}</option>)}
                          </select>
                        ) : null}
                        <button type="button" className="route-remove-button" disabled={busy !== null}
                          aria-label={`${saved.orderedTripPlaceIds.includes(row.tripPlaceId) ? "這天不去" : "拿掉"}「${row.name}」`}
                          onClick={() => takeOut(candidate, row.tripPlaceId)}>
                          <X aria-hidden="true" /> {saved.orderedTripPlaceIds.includes(row.tripPlaceId) ? "這天不去" : "拿掉"}
                        </button>
                      </>
                    ),
                  }}
                />
              );
            })}
          </ol>
        ) : <p className="route-optimal">{t.dayPlan.nothingFits}</p>}
        {unscheduledSection(candidate, true)}
        {canArrange ? (
          <section
            className={`route-pool${drag?.moved && drag.source === "timeline" && drag.overPool ? " is-drop-target" : ""}`}
            data-route-pool
            aria-label="待選區"
          >
            <h4>待選區</h4>
            <p className="route-pool-help">把地點拖到上面兩站之間：綠色表示排得下，黃色表示前後有一段或兩段改搭計程車才排得下，紅色表示排不下。不想去的地點拖回這裡。</p>
            {poolItems.length === 0 ? <p className="route-pool-help">沒有其他地點。</p> : null}
            <ul>
              {poolItems.map((place) => (
                <li key={place.id} className={drag?.moved && drag.id === place.id ? "is-dragging" : ""}>
                  <div className="route-add-row">
                    <button
                      type="button"
                      className="route-drag-handle"
                      aria-label={`拖曳「${place.name}」到這天的位置`}
                      aria-disabled={busy !== null}
                      onPointerDown={(event) => startDrag(event, place.id, "pool", placedIds(candidate).length)}
                    >
                      <GripVertical aria-hidden="true" />
                    </button>
                    <span>
                      <strong>{place.name}</strong>
                      <small>
                        {place.km === null ? "" : place.km < 1 ? "離這天的地點不到 1 km・" : `離這天最近的地點約 ${Math.round(place.km)} km・`}
                        {(() => {
                          const stay = stays.get(place.id);
                          return stay ? (stay.estimated ? `停留約 ${stay.minutes} 分（依類型估計）・` : `停留 ${stay.minutes} 分・`) : "";
                        })()}
                        {place.fromDay ? "原本在這天，儲存後移到待安排" : place.pending ? `待安排${place.priorDate ? `・原本在 ${place.priorDate}` : ""}` : "口袋名單"}
                      </small>
                    </span>
                    <button type="button" className="route-link-button" disabled={busy !== null}
                      onClick={() => void tryAdd(place)}>
                      <Plus aria-hidden="true" /> {trial?.placeId === place.id && trial.kind === "trying" ? "試排中…" : "幫我放"}
                    </button>
                  </div>
                  {trial?.placeId === place.id && trial.kind !== "trying" ? (
                    <div className={`route-add-result route-add-result-${trial.kind}`} role="status">
                      <p>{trial.text}</p>
                      {trial.kind === "swap" ? (
                        <div>
                          <button type="button" className="route-swap-button" disabled={busy !== null} onClick={acceptSwap}>{`改排「${place.name}」`}</button>
                          <button type="button" className="route-link-button" disabled={busy !== null} onClick={() => setTrial(null)}>保留原安排</button>
                        </div>
                      ) : trial.kind === "taxi" ? (
                        <div>
                          <button type="button" className="route-swap-button" disabled={busy !== null} onClick={acceptTaxi}>改搭計程車</button>
                          <button type="button" className="route-link-button" disabled={busy !== null} onClick={() => setTrial(null)}>保留原安排</button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </section>
    );
  }


  // Same places in the same order, each reached the same way: nothing to save.
  const arrivals = (version: DayTimetableDto) => version.orderedTripPlaceIds.map((id) => `${id}:${version.legModes[id] ?? ""}`).join();
  const unchanged = saved && candidate ? arrivals(saved) === arrivals(candidate) : true;
  const placedCount = candidate ? placedIds(candidate).length : 0;
  const listedCount = candidate ? candidate.orderedTripPlaceIds.length : 0;

  return (
    <Dialog open={day !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="route-dialog max-[599px]:translate-x-0 max-[599px]:translate-y-0" showCloseButton>
        <DialogHeader className="route-page-heading">
          <DialogTitle>{t.dayPlan.title(day?.label ?? "", day?.date ?? "")}</DialogTitle>
          <DialogDescription>
            {saved
              ? `${describeStartAndEnd(saved, t.timetable)} 先預覽，只有按下「儲存為${day?.label ?? "這天"}的安排」才會改行程。`
              : t.dayPlan.draftNotice}
          </DialogDescription>
        </DialogHeader>
        {!canArrange ? <p className="route-status">{t.schedule.ownerOnly}</p> : null}

        {resolution.conflict ? <ConflictPanel conflict={resolution.conflict} busy={busy !== null}
          formatValue={(_path, value) => typeof value === "number" ? clock(value) : undefined}
          onAccept={() => { resolution.clear(); if (day && resolution.conflict?.current) void planAll(day.id, dialogEpoch.current, comparisons.custom?.orderedTripPlaceIds); else close(); }}
          onReapply={() => { const conflict = resolution.conflict; if (conflict?.current) void saveWindow(conflict.attempted, conflict.current.version, conflict.base.version); }}
          onEdit={() => { if (resolution.conflict?.current) setBase(resolution.conflict.current); resolution.resume(); }}
        /> : null}

        {error ? <p role="alert" className="route-error">{error}</p> : null}
        {busy === "planning" ? <p role="status" className="route-status">{t.dayPlan.planning}</p> : null}
        {notice ? <p role="status" className="route-status">{notice}</p> : null}

        {shown ? (
          <div className="route-comparison">
            <section className="route-summary" data-testid="day-load">
              <Route />
              <div>
                <strong className="route-load">
                  {candidate ? `依目前資料，${placedCount}/${listedCount} 個地點排得下` : `${visitCount} 個地點`}
                </strong>
                <span className="route-load">
                  <LoadBadge level={shown.load.level} />
                  {` ${t.dayPlan.loadSummary(span(shown.load.busyMinutes, t.timetable), span(shown.load.windowMinutes, t.timetable))}`}
                </span>
              </div>
            </section>

            {unknownLegCount > 0 ? (
              <aside className="route-unknown">
                <HelpCircle />
                <div>
                  <strong>{`${unknownLegCount} 段交通時間查不到`}</strong>
                  <span>資料不完整的路段不顯示推測的抵達時間。</span>
                </div>
              </aside>
            ) : null}

            <div className="route-evidence" aria-label="資料狀況">
              <span className="route-evidence-label">資料狀況</span>
              <span className="route-evidence-chip">{`營業時間 ${hoursFound}/${visitCount} 已查到`}</span>
              <span className="route-evidence-chip route-evidence-estimated">
                <Clock3 /> 交通與停留：估算
              </span>
              {attributions.length > 0 ? (
                <span className="route-evidence-source">{t.dayPlan.routeTimes(attributions.join("、"))}</span>
              ) : null}
            </div>

            <div className="route-segments" role="tablist" aria-label="切換查看">
              <button type="button" role="tab" aria-selected={view === "candidate"} disabled={!candidate} onClick={() => showVersion("candidate")}>
                <GripVertical />
                <span>{comparisons.custom ? "我調整的" : "依距離排"}</span>
                <Check className="route-selection-mark" />
              </button>
              <button type="button" role="tab" aria-selected={view === "saved"} disabled={!saved} onClick={() => showVersion("saved")}>
                <Clock3 />
                <span>已儲存</span>
                <Check className="route-selection-mark" />
              </button>
            </div>

            <details className="route-time-settings">
              <summary>
                <span className="route-time-settings-label">
                  <Clock3 aria-hidden="true" />
                  <span>
                    <strong>可安排時間・交通方式</strong>
                    <small>{start}–{endOfDay ? "24:00" : end}・{TRAVEL_MODE_LABEL[travelMode]}</small>
                  </span>
                </span>
                <span className="route-time-settings-action">
                  調整時間
                  <ChevronDown aria-hidden="true" />
                </span>
              </summary>
              {canArrange ? (
              <form
                hidden={Boolean(resolution.conflict)}
                className="route-constraints"
                onSubmit={(event) => void replan(event)}
              >
                <p>固定行程與已確認限制會保留不動。</p>
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
                <label>
                  <span>這天怎麼移動</span>
                  <select value={travelMode} onChange={(event) => setTravelMode(event.target.value as TravelMode)}>
                    {TRAVEL_MODES.map((mode) => <option key={mode} value={mode}>{TRAVEL_MODE_LABEL[mode]}</option>)}
                  </select>
                </label>
                {travelMode === "walk" ? (
                  <label>
                    <span>走路最多幾分鐘，超過就搭大眾運輸</span>
                    <select value={walkLimit} onChange={(event) => setWalkLimit(Number(event.target.value))}>
                      {[10, 15, 20, 30, 45, 60].map((minutes) => <option key={minutes} value={minutes}>{`${minutes} 分鐘`}</option>)}
                    </select>
                  </label>
                ) : null}
                <p className="route-mode-note">{TRAVEL_MODE_NOTE[travelMode]}</p>
                <Button type="submit" variant="outline" size="lg" disabled={busy !== null || !saved}>
                  {t.dayPlan.rePlan}
                </Button>
              </form>
              ) : null}
            </details>
            <div className="route-versions">
              {savedVersion()}
              {candidateVersion()}
            </div>
          </div>
        ) : null}

        <DialogFooter hidden={Boolean(resolution.conflict) || !saved} className="route-actionbar">
          <Button variant="outline" size="lg" disabled={busy === "saving"} onClick={close}>
            保留已儲存順序
          </Button>
          {canArrange ? (
            <Button
              size="lg"
              disabled={busy !== null || orderStale || !candidate || unchanged}
              onClick={() => void saveArrangement()}
            >
              <Check /> {busy === "saving" ? t.dayPlan.saving : `儲存為${day?.label ?? "這天"}的安排`}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
