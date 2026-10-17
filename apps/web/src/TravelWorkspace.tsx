import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import type { TripDto, TripFlightInput } from "@along-the-way/contracts/private-trips";
import { parseTripSkeletonResponse, parseItineraryItemResponse, type ItineraryItemDto, type TripLodgingInput, type TripSkeletonDto } from "@along-the-way/contracts/trip-skeleton";
import { parseProviderCandidatesResponse, type ProviderPlaceCandidateDto } from "@along-the-way/contracts/trip-places";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { countryStopLabel } from "./country-stop-label";
import { ambiguousUtcOffsets, emptyFlight, FlightFields, flightComplete, validUtcOffsets } from "./FlightFields";
import { useI18n } from "./i18n";
import { ConflictPanel, useVersionConflict, type EditSnapshot } from "./ConflictPanel";
import { notify } from "./AppToaster";
import "./plan-route.css";

interface TravelWorkspaceProps {
  trip: TripDto;
  type: "flight" | "lodging";
  request<T>(url: string, options?: RequestInit & { parse?: (value: unknown) => unknown }): Promise<T>;
  revision: number;
  onChanged(): Promise<void>;
}

function travelValues(item: ItineraryItemDto, skeleton: TripSkeletonDto): TripFlightInput | TripLodgingInput {
  const start = item.endpoints.find((endpoint) => endpoint.role === "start")!;
  const end = item.endpoints.find((endpoint) => endpoint.role === "end")!;
  const startPlace = skeleton.places.find((place) => place.id === start.placeId)!;
  const endPlace = skeleton.places.find((place) => place.id === end.placeId)!;
  if (item.type === "flight") return {
    serviceNumber: item.details.serviceNumber,
    carrier: item.details.carrier,
    departureAirport: {
      name: startPlace.name,
      timeZone: start.timeZone,
      ...(startPlace.latitude !== null && startPlace.longitude !== null
        ? { latitude: startPlace.latitude, longitude: startPlace.longitude } : {}),
    },
    arrivalAirport: {
      name: endPlace.name,
      timeZone: end.timeZone,
      ...(endPlace.latitude !== null && endPlace.longitude !== null
        ? { latitude: endPlace.latitude, longitude: endPlace.longitude } : {}),
    },
    departureLocalDateTime: start.localDateTime,
    arrivalLocalDateTime: end.localDateTime,
    departureUtcOffset: start.utcOffset,
    arrivalUtcOffset: end.utcOffset,
  };
  return {
    hotel: { name: startPlace.name, timeZone: start.timeZone, address: startPlace.address, latitude: startPlace.latitude, longitude: startPlace.longitude, sourceUrl: startPlace.sourceUrl },
    countryStopId: start.countryStopId!,
    checkInLocalDateTime: start.localDateTime, checkOutLocalDateTime: end.localDateTime,
    checkInUtcOffset: start.utcOffset, checkOutUtcOffset: end.utcOffset,
  };
}

function newFlightValues(skeleton: TripSkeletonDto) {
  const existingFlights = skeleton.items.filter((entry) => entry.type === "flight");
  if (existingFlights.length !== 1) return emptyFlight();
  const existing = travelValues(existingFlights[0]!, skeleton);
  if (!("serviceNumber" in existing)) return emptyFlight();
  return {
    ...emptyFlight(),
    departureAirport: { ...existing.arrivalAirport },
    arrivalAirport: { ...existing.departureAirport },
  };
}

const DEFAULT_CHECK_IN_TIME = "15:00";
const DEFAULT_CHECK_OUT_TIME = "11:00";

function localDate(localDateTime: string) {
  return /^\d{4}-\d{2}-\d{2}T/.test(localDateTime) ? localDateTime.slice(0, 10) : "";
}

function localTime(localDateTime: string, fallback: string) {
  const match = /T(\d{2}:\d{2})/.exec(localDateTime);
  return match?.[1] ?? fallback;
}

function lodgingEndpointInstant(localDateTime: string, timeZone: string, utcOffset: string | null | undefined) {
  const offsets = validUtcOffsets(localDateTime, timeZone);
  if (!offsets) return null;
  const selectedOffset = utcOffset ?? (offsets.length === 1 ? offsets[0] : null);
  if (!selectedOffset || !offsets.includes(selectedOffset)) return null;
  const local = Temporal.PlainDateTime.from(localDateTime);
  const earlier = local.toZonedDateTime(timeZone, { disambiguation: "earlier" });
  const later = local.toZonedDateTime(timeZone, { disambiguation: "later" });
  return (earlier.offset === selectedOffset ? earlier : later).epochNanoseconds;
}

function LodgingStayFields({ id, value, dates, times, usedCheckInDates, usedCheckOutDates, onChange }: {
  id: string;
  value: TripLodgingInput;
  dates: string[];
  times: { checkIn: string; checkOut: string };
  usedCheckInDates: ReadonlySet<string>;
  usedCheckOutDates: ReadonlySet<string>;
  onChange(value: TripLodgingInput): void;
}) {
  const { locale, t } = useI18n();
  const checkInDate = localDate(value.checkInLocalDateTime);
  const checkOutDate = localDate(value.checkOutLocalDateTime);
  const summaryId = `${id}-stay-date-summary`;
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    timeZone: "UTC",
  }), [locale]);
  const shortDate = (date: string) => {
    const [, month, day] = date.split("-");
    return `${Number(month)}/${Number(day)}`;
  };
  const summary = checkInDate
    ? checkOutDate
      ? t.travel.stayDateSummary(
        shortDate(checkInDate),
        shortDate(checkOutDate),
        Math.round((Date.parse(`${checkOutDate}T00:00:00Z`) - Date.parse(`${checkInDate}T00:00:00Z`)) / 86_400_000),
      )
      : t.travel.chooseStayCheckOut
    : t.travel.chooseStayCheckIn;

  function chooseDate(date: string) {
    const choosingCheckOut = Boolean(checkInDate && !checkOutDate && date >= checkInDate);
    if (!choosingCheckOut) {
      onChange({
        ...value,
        checkInLocalDateTime: `${date}T${times.checkIn}`,
        checkOutLocalDateTime: "",
        ...(checkInDate === date ? {} : { checkInUtcOffset: null }),
        checkOutUtcOffset: null,
      });
      return;
    }
    onChange({
      ...value,
      checkOutLocalDateTime: `${date}T${times.checkOut}`,
      ...(checkOutDate === date ? {} : { checkOutUtcOffset: null }),
    });
  }

  return (
    <fieldset className="travel-stay-dates" aria-describedby={summaryId}>
      <legend>{t.travel.stayDates}</legend>
      <p id={summaryId} className="travel-stay-dates__summary" aria-live="polite">{summary}</p>
      <div className="travel-date-picker__options">
        {dates.map((date) => {
          const role = checkInDate && !checkOutDate && date >= checkInDate ? "checkOut" : "checkIn";
          const alreadyUsed = (role === "checkIn" ? usedCheckInDates : usedCheckOutDates).has(date);
          const formattedDate = dateFormatter.format(new Date(`${date}T12:00:00Z`));
          const isCheckIn = date === checkInDate;
          const isCheckOut = date === checkOutDate;
          const isBetween = Boolean(checkInDate && checkOutDate && date > checkInDate && date < checkOutDate);
          const roleLabel = role === "checkIn" ? t.travel.checkInDate : t.travel.checkOutDate;
          const usedLabel = role === "checkIn" ? t.travel.checkInDateUsed : t.travel.checkOutDateUsed;
          return (
            <button
              type="button"
              className="travel-date-choice"
              data-range={isCheckIn ? "start" : isCheckOut ? "end" : isBetween ? "middle" : undefined}
              aria-label={`${roleLabel}：${formattedDate}${alreadyUsed ? `，${usedLabel}` : ""}`}
              aria-pressed={isCheckIn || isCheckOut}
              disabled={alreadyUsed}
              key={date}
              onClick={() => chooseDate(date)}
            >
              <strong>{formattedDate.split("（")[0]}</strong>
              <span className="travel-date-choice__weekday">{formattedDate.split("（")[1]?.replace("）", "")}</span>
              {isCheckIn ? <small>{t.travel.checkInMarker}</small>
                : isCheckOut ? <small>{t.travel.checkOutMarker}</small>
                  : alreadyUsed ? <small>{usedLabel}</small> : null}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function TravelEditor({ trip, type, item, skeleton, request, saved, close }: TravelWorkspaceProps & {
  item: ItineraryItemDto | null;
  skeleton: TripSkeletonDto;
  saved(): Promise<void>;
  close(): void;
}) {
  const { t } = useI18n();
  const id = useId();
  const start = item?.endpoints.find((endpoint) => endpoint.role === "start");
  const end = item?.endpoints.find((endpoint) => endpoint.role === "end");
  const startPlace = skeleton.places.find((place) => place.id === start?.placeId);
  const endPlace = skeleton.places.find((place) => place.id === end?.placeId);
  const singleCountryStop = trip.countryStops.length === 1 ? trip.countryStops[0] : null;
  const [flight, setFlight] = useState<TripFlightInput>(() => item?.type === "flight" && start && end ? {
    serviceNumber: item.details.serviceNumber,
    carrier: item.details.carrier,
    departureAirport: {
      name: startPlace?.name ?? "",
      timeZone: start.timeZone,
      ...(startPlace?.latitude != null && startPlace.longitude != null
        ? { latitude: startPlace.latitude, longitude: startPlace.longitude } : {}),
    },
    arrivalAirport: {
      name: endPlace?.name ?? "",
      timeZone: end.timeZone,
      ...(endPlace?.latitude != null && endPlace.longitude != null
        ? { latitude: endPlace.latitude, longitude: endPlace.longitude } : {}),
    },
    departureLocalDateTime: start.localDateTime,
    arrivalLocalDateTime: end.localDateTime,
    departureUtcOffset: start.utcOffset,
    arrivalUtcOffset: end.utcOffset,
  } : type === "flight" ? newFlightValues(skeleton) : emptyFlight());
  const [lodging, setLodging] = useState<TripLodgingInput>(() => ({
    hotel: { name: startPlace?.name ?? "", address: startPlace?.address ?? null, latitude: startPlace?.latitude ?? null,
      longitude: startPlace?.longitude ?? null, sourceUrl: startPlace?.sourceUrl ?? null,
      timeZone: start?.timeZone ?? singleCountryStop?.timeZone ?? trip.countryStops[0]?.timeZone ?? "" },
    countryStopId: singleCountryStop?.id ?? start?.countryStopId ?? trip.countryStops[0]?.id ?? "",
    checkInLocalDateTime: start?.localDateTime ?? "", checkOutLocalDateTime: end?.localDateTime ?? "",
    checkInUtcOffset: start?.utcOffset, checkOutUtcOffset: end?.utcOffset,
  }));
  const [lodgingTimes, setLodgingTimes] = useState(() => ({
    checkIn: localTime(start?.localDateTime ?? "", DEFAULT_CHECK_IN_TIME),
    checkOut: localTime(end?.localDateTime ?? "", DEFAULT_CHECK_OUT_TIME),
  }));
  // Compare against the editor's original facts, not a later shared-place refresh.
  const [loadedHotel] = useState(lodging.hotel);
  // Freeze the version displayed when the editor opens; background refresh must not mask a conflict.
  const [expectedVersion, setExpectedVersion] = useState(item?.version ?? skeleton.tripVersion);
  const [base, setBase] = useState<EditSnapshot<TripFlightInput | TripLodgingInput>>({ input: type === "flight" ? flight : lodging, version: expectedVersion });
  const resolution = useVersionConflict<TripFlightInput | TripLodgingInput>();
  const [rebased, setRebased] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<ProviderPlaceCandidateDto[]>([]);
  const [attribution, setAttribution] = useState("");
  const retry = useRef<{ payload: string; key: string } | null>(null);
  const title = type === "flight" ? (item ? t.travel.editFlight : t.travel.addFlight) : (item ? t.travel.editLodging : t.travel.addLodging);
  const lodgingDates = useMemo(() => trip.days.map((day) => day.date).sort(), [trip.days]);
  const lodgingDateSet = useMemo(() => new Set(lodgingDates), [lodgingDates]);
  const usedLodgingDates = useMemo(() => {
    const checkIn = new Set<string>();
    const checkOut = new Set<string>();
    for (const other of skeleton.items) {
      if (other.type !== "lodging" || other.id === item?.id) continue;
      const otherCheckIn = other.endpoints.find((endpoint) => endpoint.role === "start");
      const otherCheckOut = other.endpoints.find((endpoint) => endpoint.role === "end");
      if (otherCheckIn) checkIn.add(localDate(otherCheckIn.localDateTime));
      if (otherCheckOut) checkOut.add(localDate(otherCheckOut.localDateTime));
    }
    return { checkIn, checkOut };
  }, [item?.id, skeleton.items]);
  const checkInDate = localDate(lodging.checkInLocalDateTime);
  const checkOutDate = localDate(lodging.checkOutLocalDateTime);
  const checkInInstant = lodgingEndpointInstant(lodging.checkInLocalDateTime, lodging.hotel.timeZone, lodging.checkInUtcOffset);
  const checkOutInstant = lodgingEndpointInstant(lodging.checkOutLocalDateTime, lodging.hotel.timeZone, lodging.checkOutUtcOffset);
  const lodgingDatesValid = lodgingDateSet.has(checkInDate)
    && lodgingDateSet.has(checkOutDate)
    && checkOutDate >= checkInDate
    && checkInInstant !== null
    && checkOutInstant !== null
    && checkOutInstant >= checkInInstant
    && !usedLodgingDates.checkIn.has(checkInDate)
    && !usedLodgingDates.checkOut.has(checkOutDate);
  // Why 儲存 cannot proceed, said out loud instead of a silently disabled button.
  const lodgingDatesProblem = !lodgingDateSet.has(checkInDate) ? "請先點選入住日。"
    : !lodgingDateSet.has(checkOutDate) || checkOutDate < checkInDate ? "請點選不早於入住日的退房日。"
      : usedLodgingDates.checkIn.has(checkInDate) ? `${checkInDate.slice(5).replace("-", "/")} 已經有另一間住宿入住；一天只能有一間住宿入住，請先修改或刪除那一間。`
        : usedLodgingDates.checkOut.has(checkOutDate) ? `${checkOutDate.slice(5).replace("-", "/")} 已經有另一間住宿退房；一天只能有一間住宿退房，請先修改或刪除那一間。`
          : checkInInstant === null || checkOutInstant === null ? "請選擇有效的住宿時間；當地時間重複時也要選擇 UTC 時差。"
            : checkOutInstant < checkInInstant ? "退房時間不可早於入住時間。"
              : "";

  function chooseLodgingTime(side: "checkIn" | "checkOut", time: string) {
    const nextTime = time || (side === "checkIn" ? DEFAULT_CHECK_IN_TIME : DEFAULT_CHECK_OUT_TIME);
    const field = side === "checkIn" ? "checkInLocalDateTime" : "checkOutLocalDateTime";
    const offset = side === "checkIn" ? "checkInUtcOffset" : "checkOutUtcOffset";
    const date = localDate(lodging[field]);
    setLodgingTimes({ ...lodgingTimes, [side]: nextTime });
    if (date) setLodging({ ...lodging, [field]: `${date}T${nextTime}`, [offset]: null });
  }

  async function search() {
    setSearching(true);
    try {
      const result = parseProviderCandidatesResponse(await request(`/api/trips/${trip.id}/trip-places/search`, {
        method: "POST", body: JSON.stringify({ query }),
      }));
      setCandidates(result.candidates);
      setAttribution(result.attribution);
      if (!result.candidates.length) notify("error", t.travel.noCandidates);
    } catch (reason) {
      notify("error", reason instanceof Error ? reason.message : t.travel.loadError);
    } finally { setSearching(false); }
  }

  async function save(reapplied?: TripFlightInput | TripLodgingInput, version = expectedVersion, conflictBase = resolution.conflictBaseVersion) {
    let input: TripFlightInput | TripLodgingInput = flight;
    if (type === "lodging") {
      const current = lodging.hotel;
      const hotel: TripLodgingInput["hotel"] = { name: current.name, timeZone: current.timeZone };
      const replacingHotel = !item || current.name !== loadedHotel.name || current.timeZone !== loadedHotel.timeZone;
      if (replacingHotel || current.address !== loadedHotel.address) hotel.address = current.address;
      if (replacingHotel || current.sourceUrl !== loadedHotel.sourceUrl) hotel.sourceUrl = current.sourceUrl;
      if (replacingHotel || current.latitude !== loadedHotel.latitude || current.longitude !== loadedHotel.longitude) {
        hotel.latitude = current.latitude;
        hotel.longitude = current.longitude;
      }
      input = { ...lodging, hotel };
    }
    if (reapplied || rebased) input = reapplied ?? (type === "flight" ? flight : lodging);
    const attempted = reapplied ?? (type === "flight" ? flight : lodging);
    const payload = JSON.stringify({ ...input, [item ? "expectedVersion" : "expectedTripVersion"]: version });
    if (retry.current?.payload !== payload) retry.current = { payload, key: crypto.randomUUID() };
    setBusy(true);
    try {
      await request(`/api/trips/${trip.id}/${type === "flight" ? "flights" : "lodgings"}${item ? `/${item.id}` : ""}`, {
        method: item ? "PATCH" : "POST", headers: { "Idempotency-Key": retry.current.key, ...(conflictBase ? { "Conflict-Base-Version": String(conflictBase) } : {}) }, body: payload,
        parse: parseItineraryItemResponse,
      });
      close();
      await saved();
    } catch (reason) {
      try {
        if (await resolution.capture(reason, base, attempted, async () => {
          const latest = parseTripSkeletonResponse(await request(`/api/trips/${trip.id}/skeleton`)).skeleton;
          if (!item) return { input: attempted, version: latest.tripVersion };
          const current = latest.items.find((entry) => entry.id === item.id);
          return current ? { input: travelValues(current, latest), version: current.version } : null;
        })) return;
        notify("error", reason instanceof Error ? reason.message : t.travel.saveError);
      } catch (failure) { notify("error", failure instanceof Error ? failure.message : t.collaboration.loadError); }
    } finally { setBusy(false); }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) close(); }}>
    <DialogContent className="travel-editor max-[599px]:translate-x-0 max-[599px]:translate-y-0">
      <DialogHeader><DialogTitle>{title}</DialogTitle>
        <DialogDescription>{type === "flight" ? t.travel.sharedFlights : t.travel.lodgingDescription}</DialogDescription></DialogHeader>
      {resolution.conflict ? <ConflictPanel conflict={resolution.conflict} busy={busy}
        formatValue={(path, value) => path === "countryStopId" ? trip.countryStops.find((stop) => stop.id === value)?.countryCode : undefined}
        onAccept={() => { resolution.clear(); close(); void saved(); }}
        onReapply={() => void save(resolution.conflict!.attempted, resolution.conflict!.current!.version, resolution.conflict!.base.version)}
        onEdit={() => { setBase(resolution.conflict!.current!); setExpectedVersion(resolution.conflict!.current!.version); setRebased(true); resolution.resume(); }}
      /> : null}
      <form hidden={Boolean(resolution.conflict)} className="grid gap-5" onSubmit={(event) => {
        event.preventDefault();
        if (type === "lodging" && !lodgingDatesValid) { notify("error", lodgingDatesProblem); return; }
        void save();
      }}>
        {type === "flight" ? <FlightFields value={flight} onChange={setFlight} legend={t.travel.flights} startDate={trip.startDate} endDate={trip.endDate} /> : <>
          <Field><FieldLabel htmlFor={`${id}-search`}>{t.travel.hotelSearch}</FieldLabel>
            <div className="flex gap-2"><Input id={`${id}-search`} value={query} onChange={(event) => setQuery(event.target.value)} />
              <Button type="button" variant="outline" disabled={searching || !query.trim()} onClick={() => void search()}>{searching ? t.travel.searching : t.travel.search}</Button></div>
            {candidates.length ? <ul className="grid gap-2">{candidates.map((candidate) => <li key={candidate.providerPlaceId}>
              <Button type="button" variant="outline" className="h-auto w-full justify-start whitespace-normal text-left" onClick={() => {
                const zone = candidate.timeZone ?? lodging.hotel.timeZone;
                setLodging({ ...lodging, hotel: { name: candidate.name, address: candidate.address, latitude: candidate.latitude,
                  longitude: candidate.longitude, sourceUrl: candidate.sourceUrl, timeZone: zone },
                  checkInUtcOffset: zone === lodging.hotel.timeZone ? lodging.checkInUtcOffset : null,
                  checkOutUtcOffset: zone === lodging.hotel.timeZone ? lodging.checkOutUtcOffset : null });
                setCandidates([]);
              }}>{t.travel.selectHotel(candidate.name)}{candidate.address ? ` · ${candidate.address}` : ""}</Button>
            </li>)}</ul> : null}
            {attribution ? <p className="text-sm text-muted-foreground">{attribution}</p> : null}
          </Field>
          <Field><FieldLabel htmlFor={`${id}-hotel`}>{t.travel.hotel}</FieldLabel>
            <Input id={`${id}-hotel`} required maxLength={200} value={lodging.hotel.name} onChange={(event) => setLodging({ ...lodging, hotel: {
              name: event.target.value, timeZone: lodging.hotel.timeZone, address: null, latitude: null, longitude: null, sourceUrl: null,
            } })} /></Field>
          <LodgingStayFields
            id={id}
            value={lodging}
            dates={lodgingDates}
            times={lodgingTimes}
            usedCheckInDates={usedLodgingDates.checkIn}
            usedCheckOutDates={usedLodgingDates.checkOut}
            onChange={setLodging}
          />
          <details className="travel-lodging-advanced">
            <summary>{t.travel.optionalAdvancedSettings}</summary>
            <div className="travel-lodging-advanced__fields">
              {trip.countryStops.length > 1 ? <Field><FieldLabel htmlFor={`${id}-stop`}>{t.travel.countryStop}</FieldLabel>
                <NativeSelect
                  id={`${id}-stop`}
                  required
                  className="w-full rounded-lg border border-input bg-transparent"
                  value={lodging.countryStopId}
                  onChange={(event) => {
                    const previousZone = trip.countryStops.find((stop) => stop.id === lodging.countryStopId)?.timeZone;
                    const nextZone = trip.countryStops.find((stop) => stop.id === event.target.value)?.timeZone;
                    const zone = !lodging.hotel.timeZone || lodging.hotel.timeZone === previousZone ? nextZone ?? "" : lodging.hotel.timeZone;
                    setLodging({ ...lodging, countryStopId: event.target.value, hotel: { ...lodging.hotel, timeZone: zone },
                      checkInUtcOffset: zone === lodging.hotel.timeZone ? lodging.checkInUtcOffset : null,
                      checkOutUtcOffset: zone === lodging.hotel.timeZone ? lodging.checkOutUtcOffset : null });
                  }}
                >
                  <option value="">{t.travel.chooseCountryStop}</option>
                  {trip.countryStops.map((stop) => <option key={stop.id} value={stop.id}>{stop.position + 1}. {countryStopLabel(stop.countryCode)}</option>)}
                </NativeSelect>
              </Field> : null}
              <Field><FieldLabel htmlFor={`${id}-zone`}>{t.travel.hotelTimeZone}</FieldLabel>
                <Input id={`${id}-zone`} required placeholder={t.placeDialog.timeZonePlaceholder} value={lodging.hotel.timeZone} onChange={(event) => setLodging({
                  ...lodging, hotel: { ...lodging.hotel, timeZone: event.target.value }, checkInUtcOffset: null, checkOutUtcOffset: null,
                })} /></Field>
              <div className="travel-lodging-advanced__times">
                {(["checkIn", "checkOut"] as const).map((side) => {
                  const field = side === "checkIn" ? "checkInLocalDateTime" : "checkOutLocalDateTime";
                  const offset = side === "checkIn" ? "checkInUtcOffset" : "checkOutUtcOffset";
                  const offsets = ambiguousUtcOffsets(lodging[field], lodging.hotel.timeZone);
                  return (
                    <div className="grid gap-3" key={side}>
                      <Field>
                        <FieldLabel htmlFor={`${id}-${side}-time`}>{side === "checkIn" ? t.travel.checkInTime : t.travel.checkOutTime}</FieldLabel>
                        <Input id={`${id}-${side}-time`} type="time" value={lodgingTimes[side]} onChange={(event) => chooseLodgingTime(side, event.target.value)} />
                      </Field>
                      {offsets.length > 1 ? (
                        <Field>
                          <FieldLabel htmlFor={`${id}-${side}-occurrence`}>{side === "checkIn" ? t.travel.checkInOccurrence : t.travel.checkOutOccurrence}</FieldLabel>
                          <NativeSelect
                            id={`${id}-${side}-occurrence`}
                            value={lodging[offset] ?? ""}
                            onChange={(event) => setLodging({ ...lodging, [offset]: event.target.value || null })}
                          >
                            <option value="">{t.travel.chooseUtcOffset}</option>
                            {offsets.map((value) => <option key={value} value={value}>{t.travel.utcOffsetOption(value)}</option>)}
                          </NativeSelect>
                          <FieldDescription>{t.travel.repeatedHourDescription}</FieldDescription>
                        </Field>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </details>
        </>}
        <DialogFooter>
          {type === "lodging" && !lodgingDatesValid ? <p className="travel-editor__blocked" role="status">{lodgingDatesProblem}</p> : null}
          <Button type="button" variant="outline" disabled={busy} onClick={close}>{t.travel.cancel}</Button>
          <Button type="submit" disabled={busy || (type === "flight" && !flightComplete(flight, trip.startDate, trip.endDate))}>{busy ? t.travel.saving : t.travel.save}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function TravelWorkspace(props: TravelWorkspaceProps) {
  const { trip, type, request, revision, onChanged } = props;
  const { t } = useI18n();
  const id = useId();
  const [skeleton, setSkeleton] = useState<TripSkeletonDto | null>(null);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<{ item: ItineraryItemDto | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const loadGeneration = useRef(0);
  const deleteKeys = useRef(new Map<string, string>());
  useEffect(() => {
    if (error) notify("error", error);
  }, [error]);
  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setRefreshing(true);
    try {
      const response = await request<{ skeleton: TripSkeletonDto }>(`/api/trips/${trip.id}/skeleton`, { parse: parseTripSkeletonResponse });
      if (generation !== loadGeneration.current) return;
      setSkeleton(response.skeleton);
      setError("");
    } catch (reason) {
      if (generation === loadGeneration.current) setError(reason instanceof Error ? reason.message : t.travel.loadError);
    } finally {
      if (generation === loadGeneration.current) setRefreshing(false);
    }
  }, [request, trip.id, t]);
  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load, revision]);
  const items = (skeleton?.items.filter((item) => item.type === type) ?? []).sort((left, right) => {
    const a = left.endpoints.find((endpoint) => endpoint.role === "start")!.instant;
    const b = right.endpoints.find((endpoint) => endpoint.role === "start")!.instant;
    return new Date(a).valueOf() - new Date(b).valueOf() || left.id.localeCompare(right.id);
  });

  async function changed() {
    // Do not reopen an editor against the old version while the shared revision reloads.
    loadGeneration.current += 1;
    setRefreshing(true);
    await onChanged();
  }

  async function remove(item: ItineraryItemDto) {
    if (!window.confirm(t.travel.confirmDelete(item.title))) return;
    const identity = `${item.id}:${item.version}`;
    const key = deleteKeys.current.get(identity) ?? crypto.randomUUID();
    deleteKeys.current.set(identity, key);
    setBusy(item.id);
    try {
      await request(`/api/trips/${trip.id}/items/${item.id}`, { method: "DELETE", headers: { "Idempotency-Key": key }, body: JSON.stringify({ expectedVersion: item.version }) });
      deleteKeys.current.delete(identity);
      await changed();
    } catch (reason) { setError(reason instanceof Error ? reason.message : t.travel.saveError); }
    finally { setBusy(null); }
  }

  return <section aria-labelledby={`${id}-heading`} className="travel-workspace">
    <div className="travel-pagehead">
      <h3 id={`${id}-heading`}>{type === "flight" ? t.travel.flights : t.travel.lodgings}</h3>
      {skeleton ? <Button disabled={refreshing} onClick={() => setEditor({ item: null })}>{type === "flight" ? t.travel.addFlight : t.travel.addLodging}</Button> : null}
    </div>
    <p className="text-sm text-muted-foreground">{type === "flight" ? t.travel.sharedFlights : t.travel.lodgingDescription}</p>
    {error ? <Button variant="outline" onClick={() => void load()}>{t.travel.retry}</Button> : null}
    {!skeleton ? <p role="status">{t.travel.loading}</p> : type === "flight" && items.length < 2 ? <p role="status"><strong>{t.travel.missingFlights}</strong> · {t.travel.missingFlightsDescription}</p> : type === "lodging" && !items.length ? <p>{t.travel.noLodgings}</p> : null}
    <ol className="travel-list">{items.map((item, index) => <li key={item.id} data-travel-item-id={item.id} className="travel-card">
      <div className="travel-card__head">
        <h4 className="font-semibold">{type === "flight" ? `${index === 0 ? t.travel.outbound : index === items.length - 1 ? t.travel.return : t.travel.otherFlight} · ` : ""}{item.title}</h4>
        <div className="travel-card__actions">
          <Button variant="outline" size="sm" aria-label={t.travel.edit(item.title)} disabled={refreshing || Boolean(item.lockedAt) || busy === item.id} onClick={() => setEditor({ item })}>{t.travel.editAction}</Button>
          <Button variant="ghost" size="sm" className="travel-card__delete" aria-label={t.travel.delete(item.title)} disabled={refreshing || Boolean(item.lockedAt) || busy === item.id} onClick={() => void remove(item)}>{t.travel.deleteAction}</Button>
        </div>
      </div>
      {item.type === "flight" && item.details.carrier ? <p>{item.details.carrier}</p> : null}
      {item.endpoints.map((endpoint) => <p key={endpoint.role} className="text-sm [overflow-wrap:anywhere]">
        <strong>{type === "flight" ? (endpoint.role === "start" ? t.travel.departureTime : t.travel.arrivalTime) : (endpoint.role === "start" ? t.travel.checkIn : t.travel.checkOut)}</strong>{" · "}
        {endpoint.localDateTime.replace("T", " ")} · {endpoint.timeZone} · {skeleton?.places.find((place) => place.id === endpoint.placeId)?.name}
      </p>)}
      {item.lockedAt ? <p className="text-sm text-muted-foreground">{t.travel.locked}</p> : null}
    </li>)}</ol>
    {editor && skeleton ? <TravelEditor {...props} item={editor.item} skeleton={skeleton} close={() => setEditor(null)} saved={changed} /> : null}
  </section>;
}
