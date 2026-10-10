import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { TripDto, TripFlightInput } from "@along-the-way/contracts/private-trips";
import { parseTripSkeletonResponse, parseItineraryItemResponse, type ItineraryItemDto, type TripLodgingInput, type TripSkeletonDto } from "@along-the-way/contracts/trip-skeleton";
import { parseProviderCandidatesResponse, type ProviderPlaceCandidateDto } from "@along-the-way/contracts/trip-places";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { countryStopLabel } from "./country-stop-label";
import { emptyFlight, FlightFields, flightComplete } from "./FlightFields";
import { useI18n } from "./i18n";
import { ConflictPanel, useVersionConflict, type EditSnapshot } from "./ConflictPanel";
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
    serviceNumber: item.details.serviceNumber, carrier: item.details.carrier,
    departureAirport: { name: startPlace.name, timeZone: start.timeZone },
    arrivalAirport: { name: endPlace.name, timeZone: end.timeZone },
    departureLocalDateTime: start.localDateTime, arrivalLocalDateTime: end.localDateTime,
    departureUtcOffset: start.utcOffset, arrivalUtcOffset: end.utcOffset,
  };
  return {
    hotel: { name: startPlace.name, timeZone: start.timeZone, address: startPlace.address, latitude: startPlace.latitude, longitude: startPlace.longitude, sourceUrl: startPlace.sourceUrl },
    countryStopId: start.countryStopId!,
    checkInLocalDateTime: start.localDateTime, checkOutLocalDateTime: end.localDateTime,
    checkInUtcOffset: start.utcOffset, checkOutUtcOffset: end.utcOffset,
  };
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
  const [flight, setFlight] = useState<TripFlightInput>(() => item?.type === "flight" && start && end ? {
    serviceNumber: item.details.serviceNumber, carrier: item.details.carrier,
    departureAirport: { name: startPlace?.name ?? "", timeZone: start.timeZone },
    arrivalAirport: { name: endPlace?.name ?? "", timeZone: end.timeZone },
    departureLocalDateTime: start.localDateTime, arrivalLocalDateTime: end.localDateTime,
    departureUtcOffset: start.utcOffset, arrivalUtcOffset: end.utcOffset,
  } : skeleton.items.some((entry) => entry.type === "flight")
    ? emptyFlight(trip.countryStops.at(-1)?.timeZone ?? "", Intl.DateTimeFormat().resolvedOptions().timeZone)
    : emptyFlight(Intl.DateTimeFormat().resolvedOptions().timeZone, trip.countryStops[0]?.timeZone ?? ""));
  const [lodging, setLodging] = useState<TripLodgingInput>(() => ({
    hotel: { name: startPlace?.name ?? "", address: startPlace?.address ?? null, latitude: startPlace?.latitude ?? null,
      longitude: startPlace?.longitude ?? null, sourceUrl: startPlace?.sourceUrl ?? null,
      timeZone: start?.timeZone ?? trip.countryStops[0]?.timeZone ?? "" },
    countryStopId: start?.countryStopId ?? trip.countryStops[0]?.id ?? "",
    checkInLocalDateTime: start?.localDateTime ?? "", checkOutLocalDateTime: end?.localDateTime ?? "",
    checkInUtcOffset: start?.utcOffset, checkOutUtcOffset: end?.utcOffset,
  }));
  // Compare against the editor's original facts, not a later shared-place refresh.
  const [loadedHotel] = useState(lodging.hotel);
  // Freeze the version displayed when the editor opens; background refresh must not mask a conflict.
  const [expectedVersion, setExpectedVersion] = useState(item?.version ?? skeleton.tripVersion);
  const [base, setBase] = useState<EditSnapshot<TripFlightInput | TripLodgingInput>>({ input: type === "flight" ? flight : lodging, version: expectedVersion });
  const resolution = useVersionConflict<TripFlightInput | TripLodgingInput>();
  const [rebased, setRebased] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<ProviderPlaceCandidateDto[]>([]);
  const [attribution, setAttribution] = useState("");
  const retry = useRef<{ payload: string; key: string } | null>(null);
  const title = type === "flight" ? (item ? t.travel.editFlight : t.travel.addFlight) : (item ? t.travel.editLodging : t.travel.addLodging);

  async function search() {
    setSearching(true);
    setError("");
    try {
      const result = parseProviderCandidatesResponse(await request(`/api/trips/${trip.id}/trip-places/search`, {
        method: "POST", body: JSON.stringify({ query }),
      }));
      setCandidates(result.candidates);
      setAttribution(result.attribution);
      if (!result.candidates.length) setError(t.travel.noCandidates);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.travel.loadError);
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
    setError("");
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
        setError(reason instanceof Error ? reason.message : t.travel.saveError);
      } catch (failure) { setError(failure instanceof Error ? failure.message : t.collaboration.loadError); }
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
        onEdit={() => { setBase(resolution.conflict!.current!); setExpectedVersion(resolution.conflict!.current!.version); setRebased(true); resolution.resume(); setError(""); }}
      /> : null}
      {resolution.conflict && error ? <p role="alert" className="text-destructive">{error}</p> : null}
      <form hidden={Boolean(resolution.conflict)} className="grid gap-5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        {type === "flight" ? <FlightFields value={flight} onChange={setFlight} legend={t.travel.flights} startDate={trip.startDate} endDate={trip.endDate} /> : <>
          <Field><FieldLabel htmlFor={`${id}-stop`}>{t.travel.countryStop}</FieldLabel>
            <select id={`${id}-stop`} required className="min-h-10 rounded-lg border border-input bg-transparent px-3" value={lodging.countryStopId} onChange={(event) => {
              const previousZone = trip.countryStops.find((stop) => stop.id === lodging.countryStopId)?.timeZone;
              const nextZone = trip.countryStops.find((stop) => stop.id === event.target.value)?.timeZone;
              const zone = !lodging.hotel.timeZone || lodging.hotel.timeZone === previousZone ? nextZone ?? "" : lodging.hotel.timeZone;
              setLodging({ ...lodging, countryStopId: event.target.value, hotel: { ...lodging.hotel, timeZone: zone },
                checkInUtcOffset: zone === lodging.hotel.timeZone ? lodging.checkInUtcOffset : null,
                checkOutUtcOffset: zone === lodging.hotel.timeZone ? lodging.checkOutUtcOffset : null });
            }}><option value="">{t.travel.chooseCountryStop}</option>
              {trip.countryStops.map((stop) => <option key={stop.id} value={stop.id}>{stop.position + 1}. {countryStopLabel(stop.countryCode)}</option>)}
            </select></Field>
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
          <p className="text-sm text-muted-foreground">{t.travel.manualHint}</p>
          <Field><FieldLabel htmlFor={`${id}-hotel`}>{t.travel.hotel}</FieldLabel>
            <Input id={`${id}-hotel`} required maxLength={200} value={lodging.hotel.name} onChange={(event) => setLodging({ ...lodging, hotel: {
              name: event.target.value, timeZone: lodging.hotel.timeZone, address: null, latitude: null, longitude: null, sourceUrl: null,
            } })} /></Field>
          <Field><FieldLabel htmlFor={`${id}-zone`}>{t.travel.hotelTimeZone}</FieldLabel>
            <Input id={`${id}-zone`} required placeholder={t.placeDialog.timeZonePlaceholder} value={lodging.hotel.timeZone} onChange={(event) => setLodging({
              ...lodging, hotel: { ...lodging.hotel, timeZone: event.target.value }, checkInUtcOffset: null, checkOutUtcOffset: null,
            })} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">{(["checkIn", "checkOut"] as const).map((side) => {
            const field = side === "checkIn" ? "checkInLocalDateTime" : "checkOutLocalDateTime";
            const offset = side === "checkIn" ? "checkInUtcOffset" : "checkOutUtcOffset";
            return <div className="grid gap-4" key={side}><Field>
              <FieldLabel htmlFor={`${id}-${field}`}>{t.travel[side]}</FieldLabel>
              <Input id={`${id}-${field}`} required type="datetime-local" min={`${trip.startDate}T00:00`} max={`${trip.endDate}T23:59`}
                value={lodging[field]} onChange={(event) => setLodging({ ...lodging, [field]: event.target.value, [offset]: null })} />
            </Field><Field><FieldLabel htmlFor={`${id}-${offset}`}>{t.travel[offset]}</FieldLabel>
              <Input id={`${id}-${offset}`} pattern="[+-][0-9]{2}:[0-9]{2}" placeholder={t.itemDialog.utcOffsetPlaceholder}
                value={lodging[offset] ?? ""} onChange={(event) => setLodging({ ...lodging, [offset]: event.target.value || null })} />
              <p className="text-sm text-muted-foreground">{t.itemDialog.utcOffsetDescription}</p>
            </Field></div>;
          })}</div>
        </>}
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={close}>{t.travel.cancel}</Button>
          <Button type="submit" disabled={busy || (type === "flight" && !flightComplete(flight))}>{busy ? t.travel.saving : t.travel.save}</Button></DialogFooter>
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
      {skeleton && (type === "lodging" || items.length < 2) ? <Button disabled={refreshing} onClick={() => setEditor({ item: null })}>{type === "flight" ? t.travel.addFlight : t.travel.addLodging}</Button> : null}
    </div>
    <p className="text-sm text-muted-foreground">{type === "flight" ? t.travel.sharedFlights : t.travel.lodgingDescription}</p>
    {error ? <div role="alert"><p className="text-destructive">{error}</p><Button variant="outline" onClick={() => void load()}>{t.travel.retry}</Button></div> : null}
    {!skeleton ? <p role="status">{t.travel.loading}</p> : type === "flight" && items.length < 2 ? <p role="status"><strong>{t.travel.missingFlights}</strong> · {t.travel.missingFlightsDescription}</p> : type === "lodging" && !items.length ? <p>{t.travel.noLodgings}</p> : null}
    <ol className="travel-list">{items.map((item, index) => <li key={item.id} data-travel-item-id={item.id} className="travel-card">
      <h4 className="font-semibold">{type === "flight" ? `${index === 0 ? t.travel.outbound : index === items.length - 1 ? t.travel.return : t.travel.otherFlight} · ` : ""}{item.title}</h4>
      {item.type === "flight" && item.details.carrier ? <p>{item.details.carrier}</p> : null}
      {item.endpoints.map((endpoint) => <p key={endpoint.role} className="text-sm [overflow-wrap:anywhere]">
        <strong>{type === "flight" ? (endpoint.role === "start" ? t.travel.departureTime : t.travel.arrivalTime) : (endpoint.role === "start" ? t.travel.checkIn : t.travel.checkOut)}</strong>{" · "}
        {endpoint.localDateTime.replace("T", " ")} · {endpoint.timeZone} · {skeleton?.places.find((place) => place.id === endpoint.placeId)?.name}
      </p>)}
      {item.lockedAt ? <p className="text-sm text-muted-foreground">{t.travel.locked}</p> : null}
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={refreshing || Boolean(item.lockedAt) || busy === item.id} onClick={() => setEditor({ item })}>{t.travel.edit(item.title)}</Button>
        <Button variant="outline" disabled={refreshing || Boolean(item.lockedAt) || busy === item.id} onClick={() => void remove(item)}>{t.travel.delete(item.title)}</Button></div>
    </li>)}</ol>
    {editor && skeleton ? <TravelEditor {...props} item={editor.item} skeleton={skeleton} close={() => setEditor(null)} saved={changed} /> : null}
  </section>;
}
