import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CalendarDays, ChevronRight, CircleDot, Clock3, ExternalLink, Lock, MapPin, Navigation, TriangleAlert, Users, WifiOff } from "lucide-react";
import type { PlaceDetailReference, PlacePhotoDto } from "@along-the-way/contracts/place-details";
import { useI18n } from "./i18n";
import { googleMapsCoordinatesUrl, googleMapsNavigationUrl } from "./google-maps";
import { dayItems, localDate, parallelItemIds, personalState, tripClock, type TodayItem, type TodayModel } from "./today-model";
import { readTripLocation } from "./trip-location";
import { PlaceDetailContent } from "./PlaceDetailContent";
import { PlacePhotoCredit, PlaceThumbnail, usePlacePreviews, type PlaceDetailRequest } from "./PlaceThumbnail";
import { PlaceDetailSheet } from "./PlaceDetailSheet";

interface TodayDetailSelection {
  reference: PlaceDetailReference;
  name: string;
  triggerKey: string;
  date: string;
}

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

function TodayItemDetails({ item, zone, now, parallel, memberId, date, previews, previewsLoading, openPlace }: {
  item: TodayItem;
  zone: string | null;
  now: number;
  parallel: boolean;
  memberId: string;
  date: string;
  previews: Map<string, PlacePhotoDto | null>;
  previewsLoading: boolean;
  openPlace?: (selection: TodayDetailSelection) => void;
}) {
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
  return <article className="today-item-detail" aria-labelledby={headingId} data-current={Boolean(current)}>
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
        const detailIdentity = endpoint.place?.id ?? null;
        const triggerKey = detailIdentity ? encodeURIComponent(`${item.id}:${endpoint.role}:${detailIdentity}`) : "";
        return <div key={endpoint.role} className="flex min-w-0 items-start gap-3">
          {endpoint.place && detailIdentity && openPlace ? <PlaceThumbnail photo={previews.get(detailIdentity)} loading={previewsLoading} /> : null}
          <div className="min-w-0">
            <dt className="font-semibold">{endpoint.role === "start" ? startLabel : endLabel}</dt>
            <dd>
              {format(endpoint.instant, endpoint.timeZone)} · {endpoint.timeZone}
              {endpoint.place ? <> · {detailIdentity && openPlace ? <button
                type="button"
                className="min-h-11 max-w-full break-words text-left font-bold underline decoration-ink/30 underline-offset-4 outline-none hover:decoration-ink focus-visible:rounded focus-visible:ring-4 focus-visible:ring-focus/30"
                aria-label={text.viewPlaceDetail(endpoint.place.name)}
                data-today-place-detail-trigger={triggerKey}
                onClick={() => openPlace({ reference: { kind: "itinerary-place", id: detailIdentity }, name: endpoint.place!.name, triggerKey, date })}
              >{endpoint.place.name}</button> : endpoint.place.name}</> : null}
            </dd>
            {endpoint.place?.address ? <dd>{endpoint.place.address}</dd> : null}
            <dd>{maps ? <a className="today-link" href={maps} target="_blank" rel="noopener noreferrer">{text.maps}<ExternalLink size={14} aria-hidden="true" /><span className="text-xs">{text.leavesApp}</span></a> : <span className="inline-flex items-center gap-1"><TriangleAlert size={15} aria-hidden="true" />{text.locationMissing}</span>}</dd>
          </div>
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

type TimelineState = "past" | "current" | "next" | "later" | "unscheduled";

function TodayCard({ item, zone, selectedDate, parallel, state, onOpen }: {
  item: TodayItem;
  zone: string | null;
  selectedDate: string;
  parallel: boolean;
  state: TimelineState;
  onOpen(item: TodayItem): void;
}) {
  const { t, locale } = useI18n();
  const start = item.endpoints.find((endpoint) => endpoint.role === "start");
  const end = item.endpoints.find((endpoint) => endpoint.role === "end");
  const startZone = start?.timeZone ?? zone;
  const endZone = end?.timeZone ?? startZone;
  const startLocalDate = item.start && startZone ? localDate(Date.parse(item.start), startZone) : null;
  const endLocalDate = item.end && endZone ? localDate(Date.parse(item.end), endZone) : null;
  const startsOnSelectedDay = startLocalDate === selectedDate;
  const endsOnSelectedDay = endLocalDate === selectedDate;
  const displayedInstant = startsOnSelectedDay ? item.start : endsOnSelectedDay ? item.end : null;
  const displayedZone = startsOnSelectedDay ? startZone : endsOnSelectedDay ? endZone : null;
  const displayedTime = displayedInstant && displayedZone ? new Intl.DateTimeFormat(locale, {
    timeZone: displayedZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(displayedInstant)) : item.start && item.end ? "—" : t.today.timeUnknown;
  const endTime = item.end && endZone ? new Intl.DateTimeFormat(locale, {
    timeZone: endZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(item.end)) : null;
  const continuesFromPreviousDay = Boolean(item.start && item.end && !startsOnSelectedDay);
  const destination = end?.place ?? start?.place ?? null;
  const zoneCopy = startZone && (startZone !== zone || endZone !== startZone)
    ? endZone && endZone !== startZone ? `${startZone} → ${endZone}` : startZone
    : null;
  return <li className={`today-stop is-${state}`} data-current={state === "current"}>
    <time dateTime={displayedInstant ?? undefined}>{displayedTime}</time>
    <span className="today-stop-track" aria-hidden="true" />
    <button
      type="button"
      className="today-stop-body"
      data-today-item-trigger={item.id}
      aria-label={t.today.viewItemDetail(item.title)}
      onClick={() => onOpen(item)}
    >
      <span className="today-stop-title">
        <strong>{item.title}</strong>
        <span className="today-chip today-chip-category">{t.today.types[item.type]}</span>
        {state === "current" ? <span className="today-chip"><CircleDot size={14} aria-hidden="true" />{t.today.current}</span> : null}
        {state === "next" ? <span className="today-chip today-chip-status"><MapPin size={14} aria-hidden="true" />{t.today.nextStop}</span> : null}
        {parallel ? <span className="today-chip today-chip-status"><Users size={14} aria-hidden="true" />{t.today.parallel}</span> : null}
        {item.locked ? <span className="today-chip today-chip-status"><Lock size={14} aria-hidden="true" />{t.today.locked}</span> : null}
      </span>
      <span className="today-stop-meta">
        {continuesFromPreviousDay ? <span>{t.today.continuesFromPreviousDay}</span> : null}
        {endTime && (!endsOnSelectedDay || startsOnSelectedDay) ? <span>{t.today.endsAt(endTime)}</span> : !endTime ? <span>{t.today.timeUnknown}</span> : null}
        {zoneCopy ? <span>{zoneCopy}</span> : null}
        {destination ? <span>{destination.name}</span> : null}
        {!destination ? <span>{t.today.locationMissing}</span> : null}
      </span>
    </button>
  </li>;
}

export function TodayWorkspace({ model, selectedDate, onDayChanged, onArrangeDay, offline = false, fetchedAt, retry, retrying = false, persisted = true, request }: {
  model: TodayModel;
  selectedDate: string | null;
  onDayChanged(date: string, replace?: boolean): void;
  onArrangeDay?(date: string): void;
  offline?: boolean;
  fetchedAt: string;
  retry(): void;
  retrying?: boolean;
  persisted?: boolean;
  request?: PlaceDetailRequest;
}) {
  const { t, locale } = useI18n();
  const text = t.today;
  const [now, setNow] = useState(Date.now);
  const [selectedDetail, setSelectedDetail] = useState<TodayDetailSelection | null>(null);
  const [selectedItem, setSelectedItem] = useState<TodayItem | null>(null);
  const detailReturnPosition = useRef<{ x: number; y: number } | null>(null);
  const itemReturnPosition = useRef<{ x: number; y: number } | null>(null);
  const timelineRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 15_000);
    window.addEventListener("focus", tick);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", tick); };
  }, []);
  const clock = tripClock(model, now);
  const day = model.days.find((entry) => entry.date === selectedDate)
    ?? clock.today
    ?? (clock.phase === "after" ? model.days.at(-1) : model.days[0]);
  useEffect(() => {
    if (readTripLocation().trip === model.tripId && day && day.date !== selectedDate) onDayChanged(day.date, true);
  }, [model.tripId, day, selectedDate, onDayChanged]);
  useEffect(() => {
    if (selectedDetail && day?.date !== selectedDetail.date) setSelectedDetail(null);
  }, [day?.date, selectedDetail]);
  useEffect(() => { setSelectedItem(null); }, [day?.date]);
  const endpointIds = useMemo(() => [...new Set(model.items.flatMap((item) => item.endpoints.flatMap((endpoint) => endpoint.place?.id ? [endpoint.place.id] : [])))], [model.items]);
  const wishlistIds = useMemo(() => [...new Set(model.days.flatMap((entry) => entry.wishlist.map((place) => place.id)))], [model.days]);
  const endpointPreviews = usePlacePreviews({ tripId: model.tripId, kind: "itinerary-place", ids: endpointIds, request, enabled: Boolean(request) && !offline });
  const wishlistPreviews = usePlacePreviews({ tripId: model.tripId, kind: "trip-place", ids: wishlistIds, request, enabled: Boolean(request) && !offline });

  if (!day) return <p>{text.empty}</p>;
  const index = model.days.indexOf(day);
  const items = dayItems(model, day);
  const parallel = parallelItemIds(items);
  const selectedIsToday = clock.phase === "during" && clock.today?.id === day.id;
  const personal = personalState(items, model.memberId, now);
  const leadEligibleItems = items.filter((item) => item.participants === null || item.participants.some((participant) => participant.id === model.memberId));
  const leadCurrent = selectedIsToday ? leadEligibleItems.find((item) => item.start && item.end && Date.parse(item.start) <= now && now < Date.parse(item.end)) ?? null : null;
  const leadNext = selectedIsToday ? leadEligibleItems.filter((item) => item.start && Date.parse(item.start) > now)
    .sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!) || a.id.localeCompare(b.id))[0] ?? null : null;
  const firstFixed = [...model.items].filter((item) => item.start && (item.type === "flight" || item.type === "reservation" || item.locked || item.constraints.some((constraint) => constraint.type === "fixed_time" && constraint.status === "confirmed")))
    .sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!))[0] ?? null;
  const firstFixedDay = firstFixed ? model.days.find((entry) => entry.itemIds.includes(firstFixed.id)) ?? null : null;
  const snapshotTime = new Intl.DateTimeFormat(locale, { timeZone: day.timeZone ?? "UTC", dateStyle: "medium", timeStyle: "short" }).format(new Date(fetchedAt));
  const openPlace = request && !offline ? (selection: TodayDetailSelection) => {
    detailReturnPosition.current = { x: window.scrollX, y: window.scrollY };
    setSelectedDetail(selection);
  } : undefined;

  function closeDetail() {
    const triggerKey = selectedDetail?.triggerKey;
    const position = detailReturnPosition.current;
    detailReturnPosition.current = null;
    setSelectedDetail(null);
    if (triggerKey) {
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-today-place-detail-trigger="${triggerKey}"]`)?.focus({ preventScroll: true });
        if (position) window.scrollTo({ left: position.x, top: position.y, behavior: "instant" });
      });
    }
  }

  const detail = selectedDetail && request ? <PlaceDetailContent tripId={model.tripId} reference={selectedDetail.reference} date={selectedDetail.date} request={request} /> : null;
  const formattedDay = new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", day: "numeric", weekday: "short" }).format(new Date(`${day.date}T12:00:00Z`));
  const leadItem = clock.phase === "before"
    ? firstFixed
    : selectedIsToday
      ? leadCurrent ?? leadNext
      : null;
  const leadItemDay = leadItem
    ? (day.itemIds.includes(leadItem.id) ? day : model.days.find((entry) => entry.itemIds.includes(leadItem.id)) ?? day)
    : day;
  const navigationItem = selectedIsToday ? leadNext : null;
  const navigationPlace = navigationItem?.endpoints.find((endpoint) => endpoint.role === "start")?.place ?? null;
  const navigationUrl = navigationPlace ? googleMapsNavigationUrl(navigationPlace) : null;
  const previousMemberOrUnknown = selectedIsToday ? [...leadEligibleItems]
    .filter((item) => item.end && Date.parse(item.end) <= now)
    .sort((a, b) => Date.parse(a.end!) - Date.parse(b.end!))
    .at(-1) ?? null : null;
  const navigationOrigin = (leadCurrent ?? previousMemberOrUnknown)?.endpoints.find((endpoint) => endpoint.role === "end")?.place ?? null;
  const routeCopy = navigationItem
    ? navigationPlace
      ? navigationOrigin ? text.route(navigationOrigin.name, navigationPlace.name) : text.destinationCopy(navigationPlace.name)
      : text.locationMissing
    : null;
  const leadUsesGroupFallback = leadItem?.participants === null;
  const leadHasUnknownParticipants = leadUsesGroupFallback || navigationItem?.participants === null;
  const leadMinutesUntil = leadNext?.start ? Math.ceil((Date.parse(leadNext.start) - now) / 60_000) : null;

  const timed = items.filter((item) => item.start && item.end);
  const pastItems = selectedIsToday ? timed.filter((item) => Date.parse(item.end!) <= now) : [];
  const currentItems = selectedIsToday ? timed.filter((item) => Date.parse(item.start!) <= now && now < Date.parse(item.end!)) : [];
  const upcomingItems = timed.filter((item) => !pastItems.includes(item) && !currentItems.includes(item));
  const nextItem = selectedIsToday ? upcomingItems[0] ?? null : null;
  const laterItems = selectedIsToday ? upcomingItems.slice(nextItem ? 1 : 0) : upcomingItems;
  const untimedItems = items.filter((item) => !item.start || !item.end);
  const stateById: Record<string, TimelineState> = Object.fromEntries([
    ...pastItems.map((item) => [item.id, "past"] as const),
    ...currentItems.map((item) => [item.id, "current"] as const),
    ...(nextItem ? [[nextItem.id, "next"] as const] : []),
    ...laterItems.map((item) => [item.id, "later"] as const),
    ...untimedItems.map((item) => [item.id, "unscheduled"] as const),
  ]);
  const activeItems = items.filter((item) => stateById[item.id] !== "past");
  let firstPastInstant: number | null = null;
  let lastPastInstant: number | null = null;
  let firstPastZone: string | null = null;
  let lastPastZone: string | null = null;
  for (const item of pastItems) {
    const startZone = item.endpoints.find((endpoint) => endpoint.role === "start")?.timeZone ?? day.timeZone;
    const endZone = item.endpoints.find((endpoint) => endpoint.role === "end")?.timeZone ?? startZone;
    const start = Date.parse(item.start!);
    const end = Date.parse(item.end!);
    const startsToday = startZone && localDate(start, startZone) === day.date;
    const endsToday = endZone && localDate(end, endZone) === day.date;
    const first = startsToday ? start : endsToday ? end : null;
    if (first !== null && (firstPastInstant === null || first < firstPastInstant)) {
      firstPastInstant = first;
      firstPastZone = startsToday ? startZone : endZone;
    }
    if (endsToday && (lastPastInstant === null || end > lastPastInstant)) {
      lastPastInstant = end;
      lastPastZone = endZone;
    }
  }
  const pastRange = firstPastInstant !== null && lastPastInstant !== null && firstPastZone && lastPastZone
    ? text.elapsedRange(
      new Intl.DateTimeFormat(locale, { timeZone: firstPastZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(firstPastInstant)),
      new Intl.DateTimeFormat(locale, { timeZone: lastPastZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(lastPastInstant)),
    )
    : null;

  function openItem(item: TodayItem) {
    itemReturnPosition.current = { x: window.scrollX, y: window.scrollY };
    setSelectedItem(item);
  }
  function closeItem() {
    const id = selectedItem?.id;
    const position = itemReturnPosition.current;
    setSelectedItem(null);
    itemReturnPosition.current = null;
    window.requestAnimationFrame(() => {
      if (id) document.querySelector<HTMLElement>(`[data-today-item-trigger="${id}"]`)?.focus({ preventScroll: true });
      if (position) window.scrollTo({ left: position.x, top: position.y, behavior: "instant" });
    });
  }

  const heading = clock.phase === "before"
    ? text.departureBefore
    : selectedIsToday ? `${text.title}・${formattedDay}` : formattedDay;
  const headingContext = clock.phase === "before"
    ? `${text.before(clock.daysUntil)}・${formattedDay}`
    : day.timeZone ? `${text.localTime(day.timeZone)}・${text.version(model.tripVersion)}` : `${text.zoneUnknown}・${text.version(model.tripVersion)}`;
  const leadLabel = clock.phase === "before"
    ? text.departureBefore
    : clock.phase === "after"
      ? text.finished
      : clock.phase === "unknown" || !selectedIsToday
        ? text.selectedDay
        : leadUsesGroupFallback ? text.group : leadCurrent ? text.current : leadNext ? text.nextStop : text.personal;
  const leadTitle = clock.phase === "before"
    ? text.beforeTitle(clock.daysUntil, model.tripName)
    : clock.phase === "after"
      ? text.finished
      : clock.phase === "unknown" || !selectedIsToday
        ? text.selectedDayTitle(formattedDay)
        : leadCurrent
          ? leadCurrent.title
          : leadNext
            ? navigationPlace ? text.goTo(navigationPlace.name) : leadNext.title
            : personal.phase === "done" ? text.done : personal.phase === "unconfirmed" ? text.personalTimeUnknown : text.noPersonal;
  const selectedItemDay = selectedItem
    ? (day.itemIds.includes(selectedItem.id) ? day : model.days.find((entry) => entry.itemIds.includes(selectedItem.id)) ?? day)
    : day;
  const selectedItemParallel = selectedItem
    ? parallelItemIds(dayItems(model, selectedItemDay)).has(selectedItem.id)
    : false;

  return <section className="today-workspace" aria-label={text.title}>
    <header className="today-pagehead">
      <div><h2>{heading}</h2><p>{headingContext}</p></div>
      <div className="today-headnav">
        <nav className="today-dayrow" aria-label={text.chooseDay}>
          <button type="button" aria-label={text.previous} disabled={index === 0} onClick={() => onDayChanged(model.days[index - 1]!.date)}><ArrowLeft size={16} /><span>{text.previous}</span></button>
          <select aria-label={text.chooseDay} value={day.date} onChange={(event) => onDayChanged(event.target.value)}>{model.days.map((entry) => <option key={entry.id} value={entry.date}>{new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "numeric", day: "numeric", weekday: "short" }).format(new Date(`${entry.date}T12:00:00Z`))}</option>)}</select>
          <button type="button" aria-label={text.nextDay} disabled={index === model.days.length - 1} onClick={() => onDayChanged(model.days[index + 1]!.date)}><span>{text.nextDay}</span><ArrowRight size={16} /></button>
        </nav>
        <div className="today-zone"><span><Clock3 size={13} />{day.timeZone ? text.localTime(day.timeZone) : text.zoneUnknown}</span><button type="button" onClick={retry} disabled={retrying}>{retrying ? text.retrying : offline ? text.retry : text.sync}</button></div>
      </div>
    </header>
    {offline ? <aside className="today-notice" role="status"><WifiOff size={20} /><div><strong>{text.offline}</strong><p>{text.offlineHelp}</p><small>{text.fetchedAt(snapshotTime)}</small></div></aside> : null}
    {!persisted ? <p className="today-notice" role="status">{text.storageUnavailable}</p> : null}
    <div className="today-grid">
      <section className="today-lead" aria-label={leadLabel}>
        <div className="today-lead-label">{clock.phase === "before" || !selectedIsToday ? <CalendarDays size={16} /> : leadCurrent ? <CircleDot size={16} /> : <MapPin size={16} />}{leadLabel}</div>
        <h3>{leadTitle}</h3>
        {clock.phase === "before" && firstFixed ? <div className="today-before-summary"><strong>{text.firstFixed}</strong><span><TodayTime item={firstFixed} zone={firstFixedDay?.timeZone ?? null} />・{firstFixed.title}</span></div> : null}
        {clock.phase === "before" && !firstFixed ? <p className="today-lead-time">{text.noFixed}</p> : null}
        {clock.phase === "unknown" ? <p className="today-lead-time">{text.unknownToday}</p> : null}
        {clock.phase === "after" ? <p className="today-lead-time">{text.finishedHelp}</p> : null}
        {clock.phase !== "before" && clock.phase !== "after" && !selectedIsToday ? <p className="today-lead-time">{text.selectedDayHelp(items.length)}</p> : null}
        {selectedIsToday && leadItem ? <p className="today-lead-time"><TodayTime item={leadItem} zone={leadItemDay.timeZone} /></p> : null}
        {selectedIsToday && leadNext && leadCurrent && leadMinutesUntil !== null ? <p className="today-lead-next">{text.nextStop}：{leadNext.title}・{text.until(leadMinutesUntil)}</p> : null}
        {selectedIsToday && (routeCopy || leadHasUnknownParticipants) ? <div className="today-route">{routeCopy ? <><MapPin size={18} aria-hidden="true" /><span>{routeCopy}</span></> : null}{leadHasUnknownParticipants ? <><TriangleAlert size={18} aria-hidden="true" /><span>{text.participantsUnknownTimeline}</span></> : null}</div> : null}
        <div className="today-lead-actions">
          {navigationUrl && navigationPlace ? <a className="today-primary-action" href={navigationUrl} target="_blank" rel="noopener noreferrer"><Navigation size={17} aria-hidden="true" />{text.navigateTo(navigationPlace.name)}</a> : null}
          {leadItem ? <button type="button" className="today-secondary-action" onClick={() => openItem(leadItem)}>{text.viewItemDetail(leadItem.title)}<ChevronRight size={17} aria-hidden="true" /></button> : null}
          <button type="button" className="today-secondary-action" onClick={() => timelineRef.current?.scrollIntoView({ block: "start" })}>{text.viewTimeline}<ChevronRight size={17} aria-hidden="true" /></button>
        </div>
        {navigationUrl && offline ? <span className="today-navnote">{text.navigationOffline}</span> : null}
      </section>
      <section ref={timelineRef} className="today-timeline" aria-label={text.group} tabIndex={-1}>
        <div className="today-sectionhead"><h3>{clock.phase === "before" && index === 0 ? text.firstDayPlan : text.timeline}</h3><span>{text.itemCount(items.length)}</span></div>
        {items.length ? <>
          {pastItems.length ? <>
            <div className="today-past-label"><Clock3 size={15} aria-hidden="true" />{text.elapsedItems(pastItems.length)}{pastRange ? <span>{pastRange}</span> : null}</div>
            <ol className="today-timeline-list today-pastlist">{pastItems.map((item) => <TodayCard key={item.id} item={item} zone={day.timeZone} selectedDate={day.date} parallel={parallel.has(item.id)} state="past" onOpen={openItem} />)}</ol>
          </> : null}
          <ol className="today-timeline-list">{activeItems.map((item) => <TodayCard key={item.id} item={item} zone={day.timeZone} selectedDate={day.date} parallel={parallel.has(item.id)} state={stateById[item.id] ?? "later"} onOpen={openItem} />)}</ol>
        </> : <div className="today-empty"><p>{text.empty}</p>{onArrangeDay && !offline ? <button type="button" className="today-secondary-action mt-3" onClick={() => onArrangeDay(day.date)}><CalendarDays size={18} aria-hidden="true" />{t.tripSkeleton.arrangeThisDay}</button> : null}</div>}
        {day.wishlist.length ? <section className="today-wishlist" aria-label={text.wishlist}><div className="today-sectionhead"><h3>{text.wishlist}</h3><span>{day.wishlist.length}</span></div><p>{text.wishlistHelp}</p><ul>{day.wishlist.map((place) => {
          const triggerKey = encodeURIComponent(`wishlist:${place.id}`);
          return <li key={place.id}>
            {openPlace ? <PlaceThumbnail photo={wishlistPreviews.photos.get(place.id)} loading={wishlistPreviews.loading} /> : null}
            <div className="today-wishlist-copy">{openPlace ? <button type="button" aria-label={text.viewPlaceDetail(place.name)} data-today-place-detail-trigger={triggerKey} onClick={() => openPlace({ reference: { kind: "trip-place", id: place.id }, name: place.name, triggerKey, date: day.date })}>{place.name}<ChevronRight size={16} /></button> : <span>{place.name}</span>}<PlacePhotoCredit photo={wishlistPreviews.photos.get(place.id)} /></div>
          </li>;
        })}</ul></section> : null}
      </section>
    </div>
    <p className="today-last-sync">{text.syncedAt(snapshotTime)}</p>
    <PlaceDetailSheet appearance="workspace" open={Boolean(selectedItem) && !selectedDetail} title={selectedItem?.title ?? ""} onClose={closeItem}>
      {selectedItem ? <TodayItemDetails item={selectedItem} zone={selectedItemDay.timeZone} now={now} parallel={selectedItemParallel} memberId={model.memberId} date={selectedItemDay.date} previews={endpointPreviews.photos} previewsLoading={endpointPreviews.loading} openPlace={openPlace} /> : null}
    </PlaceDetailSheet>
    <PlaceDetailSheet open={Boolean(selectedDetail)} title={selectedDetail ? text.detailTitle(selectedDetail.name) : ""} onClose={closeDetail}>{detail}</PlaceDetailSheet>
  </section>;
}
