import { useMemo, useState } from "react";
import type { CountryStopDto, TripMemberDto } from "@along-the-way/contracts/private-trips";
import type {
  ConstraintInput,
  ConstraintStatus,
  ConstraintType,
  CreateItineraryItemInput,
  EndpointRole,
  ItineraryItemDto,
  ItineraryItemType,
  PlaceDto,
  UpdateItineraryItemInput,
  ZonedEndpointInput,
} from "@along-the-way/contracts/trip-skeleton";
import { Pencil, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

interface ItineraryItemDialogProps {
  countryStops: CountryStopDto[];
  members: TripMemberDto[];
  places: PlaceDto[];
  item?: ItineraryItemDto;
  save(input: CreateItineraryItemInput | UpdateItineraryItemInput): Promise<void>;
}

interface EndpointDraft {
  countryStopId: string;
  placeId: string;
  localDateTime: string;
  timeZone: string;
  utcOffset: string;
}

const itemTypes: Array<{ value: ItineraryItemType; label: string }> = [
  { value: "flight", label: "Flight" },
  { value: "lodging", label: "Lodging" },
  { value: "transport", label: "Transport" },
  { value: "reservation", label: "Reservation" },
  { value: "meal", label: "Meal" },
  { value: "activity", label: "Activity" },
  { value: "free-time", label: "Free time" },
];

const blankEndpoint: EndpointDraft = {
  countryStopId: "",
  placeId: "",
  localDateTime: "",
  timeZone: "",
  utcOffset: "",
};

function draftEndpoint(item: ItineraryItemDto | undefined, role: EndpointRole): EndpointDraft {
  const endpoint = item?.endpoints.find((candidate) => candidate.role === role);
  return endpoint
    ? {
        countryStopId: endpoint.countryStopId,
        placeId: endpoint.placeId,
        localDateTime: endpoint.localDateTime,
        timeZone: endpoint.timeZone,
        utcOffset: endpoint.utcOffset,
      }
    : { ...blankEndpoint };
}

function hasEndEndpoint(type: ItineraryItemType) {
  return type === "flight" || type === "lodging" || type === "transport";
}

function endpointInput(role: EndpointRole, draft: EndpointDraft): ZonedEndpointInput {
  return {
    role,
    countryStopId: draft.countryStopId,
    placeId: draft.placeId,
    localDateTime: draft.localDateTime,
    timeZone: draft.timeZone,
    utcOffset: draft.utcOffset || null,
  };
}

function EndpointEditor({
  role,
  draft,
  countryStops,
  places,
  onChange,
  locationLocked = false,
}: {
  role: EndpointRole;
  draft: EndpointDraft;
  countryStops: CountryStopDto[];
  places: PlaceDto[];
  locationLocked?: boolean;
  onChange(value: EndpointDraft): void;
}) {
  const title = role === "start" ? "Start" : "End";
  const id = `${role}-endpoint`;

  return (
    <FieldSet className="rounded-xl border p-4">
      <FieldLegend>{title} in local time</FieldLegend>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-country`}>Country stop</FieldLabel>
          <select
            id={`${id}-country`}
            className="min-h-10 rounded-lg border border-input bg-transparent px-3"
            required
            disabled={locationLocked}
            value={draft.countryStopId}
            onChange={(event) => {
              const stop = countryStops.find((candidate) => candidate.id === event.target.value);
              const place = places.find((candidate) => candidate.id === draft.placeId);
              onChange({
                ...draft,
                countryStopId: event.target.value,
                timeZone: place?.timeZone ?? stop?.timeZone ?? "",
              });
            }}
          >
            <option value="">Choose a stop</option>
            {countryStops.map((stop) => (
              <option key={stop.id} value={stop.id}>
                {stop.position + 1}. {stop.countryCode}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-place`}>Place</FieldLabel>
          <select
            id={`${id}-place`}
            className="min-h-10 rounded-lg border border-input bg-transparent px-3"
            required
            disabled={locationLocked}
            value={draft.placeId}
            onChange={(event) => {
              const place = places.find((candidate) => candidate.id === event.target.value);
              const stop = countryStops.find((candidate) => candidate.id === draft.countryStopId);
              onChange({
                ...draft,
                placeId: event.target.value,
                timeZone: place?.timeZone ?? stop?.timeZone ?? "",
              });
            }}
          >
            <option value="">Choose a place</option>
            {places.map((place) => (
              <option key={place.id} value={place.id}>{place.name}</option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-time`}>Local date and time</FieldLabel>
          <Input
            id={`${id}-time`}
            type="datetime-local"
            required
            value={draft.localDateTime}
            onChange={(event) => onChange({ ...draft, localDateTime: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-zone`}>IANA time zone</FieldLabel>
          <Input
            id={`${id}-zone`}
            required
            disabled={locationLocked}
            placeholder="Asia/Tokyo"
            value={draft.timeZone}
            onChange={(event) => onChange({ ...draft, timeZone: event.target.value })}
          />
          {!locationLocked ? (
            <FieldDescription>
              Uses the Place time zone first, then the Country Stop. If neither is known, confirm the IANA zone here.
            </FieldDescription>
          ) : null}
        </Field>
      </div>
      {locationLocked ? (
        <FieldDescription>
          Lodging checkout uses the same place and time zone as check-in.
        </FieldDescription>
      ) : null}
      <Field>
        <FieldLabel htmlFor={`${id}-offset`}>UTC offset when local time occurs twice</FieldLabel>
        <Input
          id={`${id}-offset`}
          placeholder="-08:00"
          pattern="[+-][0-9]{2}:[0-9]{2}"
          value={draft.utcOffset}
          onChange={(event) => onChange({ ...draft, utcOffset: event.target.value })}
        />
        <FieldDescription>
          Leave blank normally. During a daylight-saving overlap, enter the offset for the intended occurrence.
        </FieldDescription>
      </Field>
    </FieldSet>
  );
}

function itemDraft(item?: ItineraryItemDto) {
  return {
    type: item?.type ?? "activity" as ItineraryItemType,
    title: item?.title ?? "",
    notes: item?.notes ?? "",
    sourceUrl: item?.sourceUrl ?? "",
    amountMinor: item?.money?.amountMinor.toString() ?? "",
    currency: item?.money?.currency ?? "",
    start: draftEndpoint(item, "start"),
    end: draftEndpoint(item, "end"),
    carrier: item?.type === "flight" ? item.details.carrier ?? "" : "",
    serviceNumber: item?.type === "flight" ? item.details.serviceNumber : "",
    confirmationNotes: item?.type === "flight" ? item.details.confirmationNotes ?? "" : "",
    bookedBy: item && (item.type === "lodging" || item.type === "reservation" || item.type === "meal" || item.type === "activity")
      ? item.details.bookedBy ?? ""
      : "",
    confirmationCode: item?.type === "lodging" ? item.details.confirmationCode ?? "" : "",
    mode: item?.type === "transport" ? item.details.mode : "",
    ticketInfo: item?.type === "transport" ? item.details.ticketInfo ?? "" : "",
    durationMinutes: item && (item.type === "reservation" || item.type === "meal" || item.type === "activity" || item.type === "free-time")
      ? item.details.durationMinutes.toString()
      : "60",
    confirmationStatus: item && (item.type === "reservation" || item.type === "meal" || item.type === "activity")
      ? item.details.confirmationStatus ?? ""
      : "",
    participantMemberIds: item?.participants?.map((participant) => participant.memberId) ?? [],
    expectedVersion: item?.version ?? null,
  };
}

export function ItineraryItemDialog({ countryStops, members, places, item, save }: ItineraryItemDialogProps) {
  const [open, setOpen] = useState(false);
  const initialDraft = itemDraft(item);
  const [type, setType] = useState<ItineraryItemType>(initialDraft.type);
  const [title, setTitle] = useState(initialDraft.title);
  const [notes, setNotes] = useState(initialDraft.notes);
  const [sourceUrl, setSourceUrl] = useState(initialDraft.sourceUrl);
  const [amountMinor, setAmountMinor] = useState(initialDraft.amountMinor);
  const [currency, setCurrency] = useState(initialDraft.currency);
  const [start, setStart] = useState(initialDraft.start);
  const [end, setEnd] = useState(initialDraft.end);
  const [carrier, setCarrier] = useState(initialDraft.carrier);
  const [serviceNumber, setServiceNumber] = useState(initialDraft.serviceNumber);
  const [confirmationNotes, setConfirmationNotes] = useState(initialDraft.confirmationNotes);
  const [bookedBy, setBookedBy] = useState(initialDraft.bookedBy);
  const [confirmationCode, setConfirmationCode] = useState(initialDraft.confirmationCode);
  const [mode, setMode] = useState(initialDraft.mode);
  const [ticketInfo, setTicketInfo] = useState(initialDraft.ticketInfo);
  const [durationMinutes, setDurationMinutes] = useState(initialDraft.durationMinutes);
  const [participantMemberIds, setParticipantMemberIds] = useState<string[]>(
    initialDraft.participantMemberIds,
  );
  const [confirmationStatus, setConfirmationStatus] = useState(initialDraft.confirmationStatus);
  const [expectedVersion, setExpectedVersion] = useState<number | null>(
    initialDraft.expectedVersion,
  );
  const [constraintType, setConstraintType] = useState<ConstraintType | "">("");
  const [constraintStatus, setConstraintStatus] = useState<ConstraintStatus>("unknown");
  const [minimumBufferMinutes, setMinimumBufferMinutes] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function resetDraft() {
    const latest = itemDraft(item);
    setType(latest.type);
    setTitle(latest.title);
    setNotes(latest.notes);
    setSourceUrl(latest.sourceUrl);
    setAmountMinor(latest.amountMinor);
    setCurrency(latest.currency);
    setStart(latest.start);
    setEnd(latest.end);
    setCarrier(latest.carrier);
    setServiceNumber(latest.serviceNumber);
    setConfirmationNotes(latest.confirmationNotes);
    setBookedBy(latest.bookedBy);
    setConfirmationCode(latest.confirmationCode);
    setMode(latest.mode);
    setTicketInfo(latest.ticketInfo);
    setDurationMinutes(latest.durationMinutes);
    setConfirmationStatus(latest.confirmationStatus);
    setParticipantMemberIds(latest.participantMemberIds);
    setExpectedVersion(latest.expectedVersion);
    setConstraintType("");
    setConstraintStatus("unknown");
    setMinimumBufferMinutes("");
    setError("");
  }

  function changeOpen(nextOpen: boolean) {
    if (nextOpen && !open) resetDraft();
    setOpen(nextOpen);
  }
  const effectiveEnd = type === "lodging"
    ? {
        ...end,
        countryStopId: start.countryStopId,
        placeId: start.placeId,
        timeZone: start.timeZone,
      }
    : end;

  const details = useMemo<CreateItineraryItemInput["details"]>(() => {
    switch (type) {
      case "flight":
        return { carrier: carrier || null, serviceNumber, confirmationNotes: confirmationNotes || null };
      case "lodging":
        return { bookedBy: bookedBy || null, confirmationCode: confirmationCode || null };
      case "transport":
        return { mode, ticketInfo: ticketInfo || null };
      case "reservation":
      case "meal":
      case "activity":
        return {
          durationMinutes: Number(durationMinutes),
          bookedBy: bookedBy || null,
          confirmationStatus: confirmationStatus || null,
        };
      case "free-time":
        return { durationMinutes: Number(durationMinutes) };
    }
  }, [bookedBy, carrier, confirmationCode, confirmationNotes, confirmationStatus, durationMinutes, mode, serviceNumber, ticketInfo, type]);
  const participantChoices = useMemo(() => {
    const activeIds = new Set(members.map((member) => member.id));
    return [
      ...members.map((member) => ({
        memberId: member.id,
        displayName: member.displayName,
        email: member.email,
        removed: false,
      })),
      ...(item?.participants?.filter((participant) => !activeIds.has(participant.memberId)) ?? []),
    ];
  }, [item?.participants, members]);

  async function submit() {
    const constraints: ConstraintInput[] = constraintType
      ? [{
          type: constraintType,
          status: constraintStatus,
          minimumBufferMinutes: constraintType === "minimum_buffer" ? Number(minimumBufferMinutes) : null,
        }]
      : [];
    const base: CreateItineraryItemInput = {
      participantMemberIds: participantMemberIds.length > 0 ? participantMemberIds : null,
      type,
      title,
      notes: notes || null,
      sourceUrl: sourceUrl || null,
      money: type === "free-time" || amountMinor === ""
        ? null
        : { amountMinor: Number(amountMinor), currency },
      endpoints: [endpointInput("start", start), ...(hasEndEndpoint(type) ? [endpointInput("end", effectiveEnd)] : [])],
      details,
      constraints,
    };

    setSubmitting(true);
    setError("");
    try {
      if (item) {
        if (expectedVersion === null) {
          throw new Error("The itinerary item version is unavailable");
        }
        const { constraints: _constraints, ...updatable } = base;
        await save({ ...updatable, expectedVersion });
      } else {
        await save(base);
      }
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the itinerary item");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        render={
          <Button variant={item ? "outline" : "default"} size={item ? "sm" : "default"} disabled={!item && places.length === 0} />
        }
      >
        {item ? <Pencil /> : <Plus />}
        {item ? `Edit ${item.title}` : "Add commitment"}
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{item ? "Edit itinerary item" : "Add a commitment"}</DialogTitle>
          <DialogDescription>
            Each endpoint keeps its local wall time, IANA time zone, offset, and UTC instant.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={(event) => event.preventDefault()}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`item-type-${item?.id ?? "new"}`}>Type</FieldLabel>
              <select
                id={`item-type-${item?.id ?? "new"}`}
                className="min-h-10 rounded-lg border border-input bg-transparent px-3"
                value={type}
                onChange={(event) => setType(event.target.value as ItineraryItemType)}
              >
                {itemTypes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`item-title-${item?.id ?? "new"}`}>Title</FieldLabel>
              <Input
                id={`item-title-${item?.id ?? "new"}`}
                required
                maxLength={200}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
          </div>
          <FieldSet className="grid max-h-64 auto-rows-min gap-2 overflow-y-auto rounded-xl border p-4">
            <FieldLegend>Participants</FieldLegend>
            <FieldDescription>
              Select only confirmed participants. Leave everyone unchecked to keep participation pending.
            </FieldDescription>
            {participantChoices.map((participant) => {
              const label = participant.displayName ?? participant.email;
              return (
                <label
                  key={participant.memberId}
                  className="flex min-h-11 items-start gap-3 rounded-lg border border-ink/10 p-3"
                >
                  <input
                    className="mt-1"
                    type="checkbox"
                    checked={participantMemberIds.includes(participant.memberId)}
                    onChange={(event) => setParticipantMemberIds((current) =>
                      event.target.checked
                        ? [...current, participant.memberId]
                        : current.filter((id) => id !== participant.memberId)
                    )}
                  />
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    <strong className="block">{label}</strong>
                    <small className="text-muted-foreground">
                      {participant.displayName ? `${participant.email} · ` : ""}
                      {participant.removed ? "No longer a trip member" : "Trip member"}
                    </small>
                  </span>
                </label>
              );
            })}
          </FieldSet>


          <EndpointEditor role="start" draft={start} countryStops={countryStops} places={places} onChange={setStart} />
          {hasEndEndpoint(type) ? (
            <EndpointEditor
              role="end"
              draft={effectiveEnd}
              countryStops={countryStops}
              places={places}
              locationLocked={type === "lodging"}
              onChange={setEnd}
            />
          ) : null}

          {type === "flight" ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field><FieldLabel htmlFor="flight-carrier">Carrier</FieldLabel><Input id="flight-carrier" value={carrier} onChange={(event) => setCarrier(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="flight-number">Flight number</FieldLabel><Input id="flight-number" required value={serviceNumber} onChange={(event) => setServiceNumber(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="flight-confirmation">Confirmation notes</FieldLabel><Input id="flight-confirmation" value={confirmationNotes} onChange={(event) => setConfirmationNotes(event.target.value)} /></Field>
            </div>
          ) : null}
          {type === "lodging" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field><FieldLabel htmlFor="lodging-booked-by">Booked by</FieldLabel><Input id="lodging-booked-by" value={bookedBy} onChange={(event) => setBookedBy(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="lodging-confirmation">Confirmation code</FieldLabel><Input id="lodging-confirmation" value={confirmationCode} onChange={(event) => setConfirmationCode(event.target.value)} /></Field>
            </div>
          ) : null}
          {type === "transport" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field><FieldLabel htmlFor="transport-mode">Mode</FieldLabel><Input id="transport-mode" required value={mode} onChange={(event) => setMode(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="transport-ticket">Ticket details</FieldLabel><Input id="transport-ticket" value={ticketInfo} onChange={(event) => setTicketInfo(event.target.value)} /></Field>
            </div>
          ) : null}
          {type === "reservation" || type === "meal" || type === "activity" ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field><FieldLabel htmlFor="appointment-duration">Duration (minutes)</FieldLabel><Input id="appointment-duration" type="number" min="1" required value={durationMinutes} onChange={(event) => setDurationMinutes(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="appointment-booked-by">Booked by</FieldLabel><Input id="appointment-booked-by" value={bookedBy} onChange={(event) => setBookedBy(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="appointment-status">Confirmation status</FieldLabel><Input id="appointment-status" value={confirmationStatus} onChange={(event) => setConfirmationStatus(event.target.value)} /></Field>
            </div>
          ) : null}
          {type === "free-time" ? (
            <Field><FieldLabel htmlFor="free-time-duration">Duration (minutes)</FieldLabel><Input id="free-time-duration" type="number" min="1" required value={durationMinutes} onChange={(event) => setDurationMinutes(event.target.value)} /></Field>
          ) : null}

          {type !== "free-time" ? (
            <FieldSet className="rounded-xl border p-4">
              <FieldLegend>Money</FieldLegend>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="item-amount">Amount in minor units</FieldLabel>
                  <Input id="item-amount" type="number" min="0" step="1" placeholder="12500" value={amountMinor} onChange={(event) => setAmountMinor(event.target.value)} />
                  <FieldDescription>Store 12500 for JPY 12,500 or USD 125.00.</FieldDescription>
                </Field>
                <Field><FieldLabel htmlFor="item-currency">Currency</FieldLabel><Input id="item-currency" maxLength={3} placeholder="JPY" value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} /></Field>
              </div>
            </FieldSet>
          ) : null}

          {!item ? (
            <FieldSet className="rounded-xl border p-4">
              <FieldLegend>Initial constraint</FieldLegend>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field>
                  <FieldLabel htmlFor="constraint-type">Constraint</FieldLabel>
                  <select id="constraint-type" className="min-h-10 rounded-lg border border-input bg-transparent px-3" value={constraintType} onChange={(event) => setConstraintType(event.target.value as ConstraintType | "")}>
                    <option value="">None</option>
                    <option value="fixed_time">Fixed time</option>
                    <option value="immovable">Immovable</option>
                    <option value="minimum_buffer">Minimum buffer</option>
                  </select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="constraint-status">Knowledge status</FieldLabel>
                  <select id="constraint-status" className="min-h-10 rounded-lg border border-input bg-transparent px-3" value={constraintStatus} onChange={(event) => setConstraintStatus(event.target.value as ConstraintStatus)}>
                    <option value="confirmed">Confirmed</option>
                    <option value="unknown">Unknown</option>
                    <option value="conflicted">Conflicted</option>
                  </select>
                </Field>
                {constraintType === "minimum_buffer" ? (
                  <Field><FieldLabel htmlFor="constraint-buffer">Buffer minutes</FieldLabel><Input id="constraint-buffer" type="number" min="0" required value={minimumBufferMinutes} onChange={(event) => setMinimumBufferMinutes(event.target.value)} /></Field>
                ) : null}
              </div>
            </FieldSet>
          ) : null}

          <Field><FieldLabel htmlFor="item-source">Official or source URL</FieldLabel><Input id="item-source" type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} /></Field>
          <Field><FieldLabel htmlFor="item-notes">Notes</FieldLabel><Textarea id="item-notes" value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
          {error ? <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" disabled={submitting} onClick={() => void submit()}>{submitting ? "Saving…" : "Save item"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
