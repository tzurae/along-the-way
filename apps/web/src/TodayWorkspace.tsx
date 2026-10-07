import { useEffect, useId, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Clock3, ExternalLink, Lock, TriangleAlert, Users, WifiOff } from "lucide-react";
import { Button } from "./components/ui/button";
import { useI18n } from "./i18n";
import { googleMapsCoordinatesUrl } from "./google-maps";
import { dayItems, parallelItemIds, personalState, tripClock, type TodayItem, type TodayModel } from "./today-model";
import { readTripLocation } from "./trip-location";

function safeExternalUrl(value: string | null) {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.href : null; } catch { return null; }
}

function TodayTime({ item, zone }: { item: TodayItem; zone: string | null }) {
  const { t, locale } = useI18n();
  const start = item.endpoints.find((endpoint) => endpoint.role === "start");
  const end = item.endpoints.find((endpoint) => endpoint.role === "end");
  const startZone = start?.timeZone ?? zone;
  const endZone = end?.timeZone ?? startZone;
  if (!item.start || !item.end || !startZone || !endZone) return t.today.timeUnknown;
  const showZones = startZone !== zone || endZone !== zone;
  const label = (instant: string, timeZone: string, place: TodayItem["endpoints"][number]["place"]) => {
    const time = new Intl.DateTimeFormat(locale, { timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(instant));
    return showZones ? `${time} · ${place ? `${place.name} · ` : ""}${timeZone}` : time;
  };
  return t.today.timeRange(label(item.start, startZone, start?.place ?? null), label(item.end, endZone, end ? end.place : start?.place ?? null));
}

function TodayCard({ item, zone, now, parallel, memberId }: { item: TodayItem; zone: string | null; now: number; parallel: boolean; memberId: string }) {
  const { t, locale } = useI18n();
  const text = t.today;
  const headingId = useId();
  const format = (instant: string, timeZone: string) => new Intl.DateTimeFormat(locale, { timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(instant));
  const current = item.start && item.end && Date.parse(item.start) <= now && now < Date.parse(item.end);
  const start = item.endpoints.find((endpoint) => endpoint.role === "start");
  const end = item.endpoints.find((endpoint) => endpoint.role === "end");
  const directions = item.type === "transport" && start?.place && end?.place ? googleMapsCoordinatesUrl(end.place, start.place) : null;
  const official = safeExternalUrl(item.sourceUrl);
  const startLabel = item.type === "flight" ? text.departure : item.type === "lodging" ? text.checkIn : item.type === "transport" ? text.origin : text.start;
  const endLabel = item.type === "flight" ? text.arrival : item.type === "lodging" ? text.checkOut : item.type === "transport" ? text.destination : text.end;
  return <article className="today-item" aria-labelledby={headingId} data-current={Boolean(current)}>
    <p className="font-semibold tabular-nums"><TodayTime item={item} zone={zone} /></p>
    <h4 id={headingId} className="mt-1 text-xl font-bold">{item.title}</h4>
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <span>{text.types[item.type]}</span>
      {current ? <span className="inline-flex items-center gap-1 font-bold"><Clock3 size={16} aria-hidden="true" />{text.current}</span> : null}
      {parallel ? <span className="inline-flex items-center gap-1"><Users size={16} aria-hidden="true" />{text.parallel}</span> : null}
      {item.locked ? <span className="inline-flex items-center gap-1"><Lock size={16} aria-hidden="true" />{text.locked}</span> : null}
    </div>
    <p className="mt-2 text-sm">{item.participants === null ? text.participantsUnknown : <>{text.participants}：{item.participants.length === 0 ? text.noParticipants : item.participants.map((person) => `${person.name}${person.id === memberId ? `（${text.you}）` : ""}`).join("、")}</>}</p>
    <dl className="mt-4 grid gap-3 text-sm">
      {item.endpoints.map((endpoint) => {
        const maps = endpoint.place ? googleMapsCoordinatesUrl(endpoint.place) : null;
        return <div key={endpoint.role}>
          <dt className="font-semibold">{endpoint.role === "start" ? startLabel : endLabel}</dt>
          <dd>{format(endpoint.instant, endpoint.timeZone)} · {endpoint.timeZone}{endpoint.place ? ` · ${endpoint.place.name}` : ""}</dd>
          {endpoint.place?.address ? <dd>{endpoint.place.address}</dd> : null}
          <dd>{maps ? <a className="today-link" href={maps} target="_blank" rel="noopener noreferrer">{text.maps}<ExternalLink size={14} aria-hidden="true" /><span className="text-xs">{text.leavesApp}</span></a> : <span className="inline-flex items-center gap-1"><TriangleAlert size={15} aria-hidden="true" />{text.locationMissing}</span>}</dd>
        </div>;
      })}
      {item.facts.map((fact) => <div key={fact.kind}><dt className="font-semibold">{text.facts[fact.kind]}</dt><dd className="whitespace-pre-wrap">{fact.value}</dd></div>)}
    </dl>
    {item.constraints.length || !item.start || !item.end ? <section className="mt-4 text-sm" aria-label={text.manualChecks}>
      <h5 className="flex items-center gap-1 font-semibold"><TriangleAlert size={16} aria-hidden="true" />{text.manualChecks}</h5>
      <ul className="mt-1 list-inside list-disc">
        {!item.start || !item.end ? <li>{text.timeUnknown}</li> : null}
        {item.constraints.map((constraint, index) => <li key={index}>{constraint.type === "fixed_time" ? text.fixed : constraint.type === "immovable" ? text.immovable : text.buffer(constraint.minutes)} · {text.constraintStatus[constraint.status]}</li>)}
      </ul>
    </section> : null}
    {item.type === "transport" ? <p className="mt-3 text-sm text-muted-foreground">{text.routeUnavailable}</p> : null}
    {directions ? <a className="today-link mt-2" href={directions} target="_blank" rel="noopener noreferrer">{text.directions}<ExternalLink size={16} aria-hidden="true" /><span className="text-xs">{text.leavesApp}</span></a> : null}
    {official ? <a className="today-link mt-2" href={official} target="_blank" rel="noopener noreferrer">{text.officialLink}<ExternalLink size={16} aria-hidden="true" /><span className="text-xs">{text.leavesApp}</span></a> : null}
    {item.notes ? <details className="mt-3"><summary className="min-h-11 cursor-pointer py-2 font-semibold">{text.notes}</summary><p className="whitespace-pre-wrap">{item.notes}</p></details> : null}
  </article>;
}

export function TodayWorkspace({ model, selectedDate, onDayChanged, offline = false, fetchedAt, retry, retrying = false, persisted = true }: {
  model: TodayModel; selectedDate: string | null; onDayChanged(date: string, replace?: boolean): void;
  offline?: boolean; fetchedAt: string; retry(): void; retrying?: boolean; persisted?: boolean;
}) {
  const { t, locale } = useI18n();
  const text = t.today;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 15_000);
    window.addEventListener("focus", tick);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", tick); };
  }, []);
  const clock = tripClock(model, now);
  const day = model.days.find((entry) => entry.date === selectedDate) ?? clock.today ?? (clock.phase === "after" ? model.days.at(-1) : model.days[0]);
  useEffect(() => {
    if (readTripLocation().trip === model.tripId && day && day.date !== selectedDate) onDayChanged(day.date, true);
  }, [model.tripId, day, selectedDate, onDayChanged]);
  if (!day) return <p>{text.empty}</p>;
  const index = model.days.indexOf(day);
  const items = dayItems(model, day);
  const parallel = parallelItemIds(items);
  const personal = personalState(items, model.memberId, now);
  const firstFixed = [...model.items].filter((item) => item.start && (item.type === "flight" || item.type === "reservation" || item.locked || item.constraints.some((constraint) => constraint.type === "fixed_time" && constraint.status === "confirmed")))
    .sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!))[0];
  const snapshotTime = new Intl.DateTimeFormat(locale, { timeZone: day.timeZone ?? "UTC", dateStyle: "medium", timeStyle: "short" }).format(new Date(fetchedAt));
  return <section className="today-workspace rounded-card border border-ink/10 bg-surface p-4 sm:p-8" aria-label={text.title}>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="font-display text-3xl">{text.title}</h2><p className="mt-1 text-sm text-muted-foreground">{text.version(model.tripVersion)}</p></div>
      <Button variant="outline" onClick={retry} disabled={retrying}>{retrying ? text.retrying : offline ? text.retry : text.sync}</Button>
    </header>
    {offline ? <aside className="my-4 rounded-xl border border-ink/25 bg-surface-subtle p-4" role="status">
      <h3 className="flex items-center gap-2 font-bold"><WifiOff size={18} aria-hidden="true" />{text.offline}</h3><p className="mt-2">{text.offlineHelp}</p><p className="mt-2 text-sm">{text.fetchedAt(snapshotTime)} · {day.timeZone ?? "UTC"}</p>
    </aside> : <p className="mt-3 text-sm text-muted-foreground">{text.syncedAt(snapshotTime)} · {day.timeZone ?? "UTC"}</p>}
    {!persisted ? <p className="mt-3" role="status">{text.storageUnavailable}</p> : null}
    {clock.phase === "before" ? <section className="my-5"><h3 className="text-xl font-bold">{text.before(clock.daysUntil)}</h3><p className="mt-2">{text.firstFixed}：{firstFixed?.title ?? text.noFixed}</p>{firstFixed ? <TodayCard item={firstFixed} zone={day.timeZone} now={now} parallel={false} memberId={model.memberId} /> : null}</section> : null}
    {clock.phase === "after" ? <p className="my-5 flex items-center gap-2 font-bold"><Check aria-hidden="true" size={20} />{text.finished} · {text.finishedHelp}</p> : null}
    {clock.phase === "unknown" ? <p className="my-5">{text.unknownToday}</p> : null}
    <nav className="my-6 grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-2" aria-label={text.chooseDay}>
      <Button variant="outline" aria-label={text.previous} disabled={index === 0} onClick={() => onDayChanged(model.days[index - 1]!.date)}><ArrowLeft size={18} aria-hidden="true" /><span className="sr-only sm:not-sr-only">{text.previous}</span></Button>
      <label className="grid min-w-0 gap-1 text-sm font-semibold">{text.chooseDay}<select className="min-h-11 w-full min-w-0 rounded-lg border bg-surface px-2" value={day.date} onChange={(event) => onDayChanged(event.target.value)}>{model.days.map((entry) => <option key={entry.id} value={entry.date}>{entry.date}</option>)}</select></label>
      <Button variant="outline" aria-label={text.nextDay} disabled={index === model.days.length - 1} onClick={() => onDayChanged(model.days[index + 1]!.date)}><span className="sr-only sm:not-sr-only">{text.nextDay}</span><ArrowRight size={18} aria-hidden="true" /></Button>
    </nav>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-2"><h3 className="text-xl font-bold">{day.date} · {day.timeZone ?? text.zoneUnknown}</h3>{clock.today && clock.today.id !== day.id ? <Button variant="outline" onClick={() => onDayChanged(clock.today!.date)}>{text.backToday}</Button> : null}</div>
    {clock.today?.id === day.id ? <section className="mb-7 border-y border-ink/15 py-4" aria-label={text.personal}>
      <h3 className="font-bold">{text.personal}</h3>
      {personal.current.map((item) => <p className="mt-2 flex flex-wrap items-center gap-2" key={item.id}><Clock3 size={16} aria-hidden="true" />{text.current}：{item.title} · <TodayTime item={item} zone={day.timeZone} /></p>)}
      {personal.phase === "empty" ? <p className="mt-2">{text.noPersonal}</p> : null}
      {personal.phase === "done" ? <p className="mt-2 flex items-center gap-2"><Check size={16} aria-hidden="true" />{text.done}</p> : null}
      {personal.phase === "unconfirmed" ? <p className="mt-2">{text.timeUnknown}</p> : null}
      {personal.phase === "between" ? <p className="mt-2">{text.between}</p> : null}
      {personal.next ? <p className="mt-2 font-semibold">{text.next}：{personal.next.title} · <TodayTime item={personal.next} zone={day.timeZone} /> · {text.until(personal.minutesUntil!)}</p> : personal.phase !== "empty" ? <p className="mt-2">{text.noNext}</p> : null}
    </section> : null}
    <section aria-label={text.group}><h3 className="mb-2 text-xl font-bold">{text.group}</h3>
      {items.length ? <ol className="grid grid-cols-1">{items.map((item) => <li key={item.id}><TodayCard item={item} zone={day.timeZone} now={now} parallel={parallel.has(item.id)} memberId={model.memberId} /></li>)}</ol> : <p className="py-5 text-muted-foreground">{text.empty}</p>}
    </section>
    {day.wishlist.length ? <section className="mt-8 border-t border-ink/15 pt-5" aria-label={text.wishlist}><h3 className="text-xl font-bold">{text.wishlist}</h3><p className="mt-2 text-sm text-muted-foreground">{text.wishlistHelp}</p><ul className="mt-3 list-inside list-disc">{day.wishlist.map((place) => <li key={place.id}>{place.name}</li>)}</ul></section> : null}
  </section>;
}
