import { useMemo, useState } from "react";
import type { CountryStopDto, TripMemberDto } from "@along-the-way/contracts/private-trips";
import type {
  ConstraintInput,
  ConstraintStatus,
  ConstraintType,
  CreateItineraryItemInput,
  EndpointRole,
  ItineraryItemDto,
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
import { useI18n } from "./i18n";
import { ConflictPanel, useVersionConflict, type EditSnapshot } from "./ConflictPanel";

type EditableItem = Exclude<ItineraryItemDto, { type: "flight" | "lodging" }>;
type EditableItemType = EditableItem["type"];

interface ItineraryItemDialogProps {
  countryStops: CountryStopDto[];
  members: TripMemberDto[];
  places: PlaceDto[];
  item?: EditableItem;
  save(input: CreateItineraryItemInput | UpdateItineraryItemInput, conflictBase?: number): Promise<void>;
  load?(): Promise<ItineraryItemDto | null>;
  editingChanged?(open: boolean): void;
}

interface EndpointDraft {
  /** A stop id, "" while unchosen, or OUTSIDE_ROUTE for an endpoint with no stop. */
  countryStopId: string;
  placeId: string;
  localDateTime: string;
  timeZone: string;
  utcOffset: string;
}

const OUTSIDE_ROUTE = "outside-route";

const itemTypes: EditableItemType[] = [
  "transport",
  "reservation",
  "meal",
  "activity",
  "free-time",
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
        countryStopId: endpoint.countryStopId ?? OUTSIDE_ROUTE,
        placeId: endpoint.placeId,
        localDateTime: endpoint.localDateTime,
        timeZone: endpoint.timeZone,
        utcOffset: endpoint.utcOffset,
      }
    : { ...blankEndpoint };
}


function endpointInput(role: EndpointRole, draft: EndpointDraft): ZonedEndpointInput {
  return {
    role,
    countryStopId: draft.countryStopId === OUTSIDE_ROUTE ? null : draft.countryStopId,
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
  allowOutsideRoute = false,
}: {
  role: EndpointRole;
  draft: EndpointDraft;
  countryStops: CountryStopDto[];
  places: PlaceDto[];
  allowOutsideRoute?: boolean;
  onChange(value: EndpointDraft): void;
}) {
  const { t } = useI18n();
  const title = role === "start" ? t.itemDialog.start : t.itemDialog.end;
  const id = `${role}-endpoint`;
  const outsideRoute = allowOutsideRoute && draft.countryStopId === OUTSIDE_ROUTE;

  return (
    <FieldSet className="rounded-xl border p-4">
      <FieldLegend>{t.itemDialog.localTimeHeading(title)}</FieldLegend>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-country`}>{t.itemDialog.countryStop}</FieldLabel>
          <select
            id={`${id}-country`}
            className="min-h-10 rounded-lg border border-input bg-transparent px-3"
            required
            // A leftover outside-route choice from transport is unchosen for other types.
            value={allowOutsideRoute || draft.countryStopId !== OUTSIDE_ROUTE ? draft.countryStopId : ""}
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
            <option value="">{t.itemDialog.chooseStop}</option>
            {countryStops.map((stop) => (
              <option key={stop.id} value={stop.id}>
                {stop.position + 1}、{stop.countryCode}
              </option>
            ))}
            {allowOutsideRoute ? <option value={OUTSIDE_ROUTE}>{t.itemDialog.outsideRoute}</option> : null}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-place`}>{t.itemDialog.place}</FieldLabel>
          <select
            id={`${id}-place`}
            className="min-h-10 rounded-lg border border-input bg-transparent px-3"
            required
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
            <option value="">{t.itemDialog.choosePlace}</option>
            {places.map((place) => (
              <option key={place.id} value={place.id}>{place.name}</option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-time`}>{t.itemDialog.localDateTime}</FieldLabel>
          <Input
            id={`${id}-time`}
            type="datetime-local"
            required
            value={draft.localDateTime}
            onChange={(event) => onChange({ ...draft, localDateTime: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-zone`}>{t.itemDialog.ianaTimeZone}</FieldLabel>
          <Input
            id={`${id}-zone`}
            required
            placeholder={t.itemDialog.timeZonePlaceholder}
            value={draft.timeZone}
            onChange={(event) => onChange({ ...draft, timeZone: event.target.value })}
          />
          <FieldDescription>
            {outsideRoute ? t.itemDialog.outsideRouteTimeZoneDescription : t.itemDialog.timeZoneDescription}
          </FieldDescription>
        </Field>
      </div>
      <Field>
        <FieldLabel htmlFor={`${id}-offset`}>{t.itemDialog.utcOffset}</FieldLabel>
        <Input
          id={`${id}-offset`}
          placeholder={t.itemDialog.utcOffsetPlaceholder}
          pattern="[+-][0-9]{2}:[0-9]{2}"
          value={draft.utcOffset}
          onChange={(event) => onChange({ ...draft, utcOffset: event.target.value })}
        />
        <FieldDescription>{t.itemDialog.utcOffsetDescription}</FieldDescription>
      </Field>
    </FieldSet>
  );
}

function itemDraft(item?: EditableItem) {
  return {
    type: item?.type ?? "activity" as EditableItemType,
    title: item?.title ?? "",
    notes: item?.notes ?? "",
    sourceUrl: item?.sourceUrl ?? "",
    amountMinor: item?.money?.amountMinor.toString() ?? "",
    currency: item?.money?.currency ?? "",
    start: draftEndpoint(item, "start"),
    end: draftEndpoint(item, "end"),
    bookedBy: item && (item.type === "reservation" || item.type === "meal" || item.type === "activity")
      ? item.details.bookedBy ?? ""
      : "",
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

function itemValues(item: ItineraryItemDto): CreateItineraryItemInput {
  return {
    type: item.type, title: item.title, notes: item.notes, sourceUrl: item.sourceUrl, money: item.money,
    participantMemberIds: item.participants?.map((member) => member.memberId) ?? null,
    endpoints: item.endpoints.map(({ role, countryStopId, placeId, localDateTime, timeZone, utcOffset }) => ({ role, countryStopId, placeId, localDateTime, timeZone, utcOffset })),
    details: item.details,
  };
}

export function ItineraryItemDialog({ countryStops, members, places, item, save, load, editingChanged }: ItineraryItemDialogProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const initialDraft = itemDraft(item);
  const [type, setType] = useState<EditableItemType>(initialDraft.type);
  const [title, setTitle] = useState(initialDraft.title);
  const [notes, setNotes] = useState(initialDraft.notes);
  const [sourceUrl, setSourceUrl] = useState(initialDraft.sourceUrl);
  const [amountMinor, setAmountMinor] = useState(initialDraft.amountMinor);
  const [currency, setCurrency] = useState(initialDraft.currency);
  const [start, setStart] = useState(initialDraft.start);
  const [end, setEnd] = useState(initialDraft.end);
  const [bookedBy, setBookedBy] = useState(initialDraft.bookedBy);
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
  const [baseSnapshot, setBaseSnapshot] = useState<EditSnapshot<CreateItineraryItemInput> | null>(item ? { input: itemValues(item), version: item.version } : null);
  const resolution = useVersionConflict<CreateItineraryItemInput>();

  function resetDraft() {
    resolution.clear();
    setBaseSnapshot(item ? { input: itemValues(item), version: item.version } : null);
    const latest = itemDraft(item);
    setType(latest.type);
    setTitle(latest.title);
    setNotes(latest.notes);
    setSourceUrl(latest.sourceUrl);
    setAmountMinor(latest.amountMinor);
    setCurrency(latest.currency);
    setStart(latest.start);
    setEnd(latest.end);
    setBookedBy(latest.bookedBy);
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
    editingChanged?.(nextOpen);
  }

  const details = useMemo<CreateItineraryItemInput["details"]>(() => {
    switch (type) {
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
  }, [bookedBy, confirmationStatus, durationMinutes, mode, ticketInfo, type]);
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

  async function persist(input: CreateItineraryItemInput, version: number | null, conflictBase = resolution.conflictBaseVersion) {
    setSubmitting(true);
    setError("");
    const { constraints: _constraints, ...updatable } = input;
    try {
      await save(item ? { ...updatable, expectedVersion: version! } : input, conflictBase);
      resolution.clear();
      changeOpen(false);
    } catch (reason) {
      try {
        if (baseSnapshot && load && await resolution.capture(reason, baseSnapshot, updatable, async () => {
          const current = await load();
          return current ? { input: itemValues(current), version: current.version } : null;
        })) return;
        setError(reason instanceof Error ? reason.message : t.itemDialog.saveError);
      } catch (failure) { setError(failure instanceof Error ? failure.message : t.collaboration.loadError); }
    } finally { setSubmitting(false); }
  }

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
      endpoints: [endpointInput("start", start), ...(type === "transport" ? [endpointInput("end", end)] : [])],
      details,
      constraints,
    };

    await persist(base, expectedVersion);
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        render={
          <Button variant={item ? "outline" : "default"} size={item ? "sm" : "default"} disabled={!item && places.length === 0} />
        }
      >
        {item ? <Pencil /> : <Plus />}
        {item ? t.itemDialog.editTrigger(item.title) : t.itemDialog.addCommitment}
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{item ? t.itemDialog.editCommitment : t.itemDialog.addCommitment}</DialogTitle>
          <DialogDescription>{t.itemDialog.endpointDescription}</DialogDescription>
        </DialogHeader>
        {resolution.conflict ? <ConflictPanel conflict={resolution.conflict} busy={submitting}
          formatValue={(path, value) => {
            if (path.endsWith(".placeId")) return places.find((place) => place.id === value)?.name;
            if (path.startsWith("participantMemberIds.")) {
              const participant = participantChoices.find((member) => member.memberId === value);
              return participant?.displayName ?? participant?.email ?? t.collaboration.unknownActor;
            }
            if (path.endsWith(".countryStopId")) return countryStops.find((stop) => stop.id === value)?.countryCode;
          }}
          onAccept={() => { resolution.clear(); changeOpen(false); }}
          onReapply={() => void persist(resolution.conflict!.attempted, resolution.conflict!.current!.version, resolution.conflict!.base.version)}
          onEdit={() => { setBaseSnapshot(resolution.conflict!.current!); setExpectedVersion(resolution.conflict!.current!.version); resolution.resume(); setError(""); }}
        /> : null}
        {resolution.conflict && error ? <p role="alert" className="text-destructive">{error}</p> : null}
        <form hidden={Boolean(resolution.conflict)} className="grid gap-5" onSubmit={(event) => event.preventDefault()}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`item-type-${item?.id ?? "new"}`}>{t.itemDialog.type}</FieldLabel>
              <select
                id={`item-type-${item?.id ?? "new"}`}
                className="min-h-10 rounded-lg border border-input bg-transparent px-3"
                value={type}
                onChange={(event) => setType(event.target.value as EditableItemType)}
              >
                {itemTypes.map((itemType) => <option key={itemType} value={itemType}>{t.itemDialog.itemTypes[itemType]}</option>)}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`item-title-${item?.id ?? "new"}`}>{t.itemDialog.title}</FieldLabel>
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
            <FieldLegend>{t.itemDialog.participants}</FieldLegend>
            <FieldDescription>{t.itemDialog.participantsDescription}</FieldDescription>
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
                      {participant.displayName ? `${participant.email}・` : ""}
                      {participant.removed ? t.itemDialog.removedMember : t.itemDialog.tripMember}
                    </small>
                  </span>
                </label>
              );
            })}
          </FieldSet>


          <EndpointEditor
            role="start"
            draft={start}
            countryStops={countryStops}
            places={places}
            allowOutsideRoute={type === "transport"}
            onChange={setStart}
          />
          {type === "transport" ? (
            <EndpointEditor
              role="end"
              draft={end}
              countryStops={countryStops}
              places={places}
              allowOutsideRoute
              onChange={setEnd}
            />
          ) : null}

          {type === "transport" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field><FieldLabel htmlFor="transport-mode">{t.itemDialog.transportMode}</FieldLabel><Input id="transport-mode" required value={mode} onChange={(event) => setMode(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="transport-ticket">{t.itemDialog.ticketDetails}</FieldLabel><Input id="transport-ticket" value={ticketInfo} onChange={(event) => setTicketInfo(event.target.value)} /></Field>
            </div>
          ) : null}
          {type === "reservation" || type === "meal" || type === "activity" ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field><FieldLabel htmlFor="appointment-duration">{t.itemDialog.durationMinutes}</FieldLabel><Input id="appointment-duration" type="number" min="1" required value={durationMinutes} onChange={(event) => setDurationMinutes(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="appointment-booked-by">{t.itemDialog.bookedBy}</FieldLabel><Input id="appointment-booked-by" value={bookedBy} onChange={(event) => setBookedBy(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="appointment-status">{t.itemDialog.confirmationStatus}</FieldLabel><Input id="appointment-status" value={confirmationStatus} onChange={(event) => setConfirmationStatus(event.target.value)} /></Field>
            </div>
          ) : null}
          {type === "free-time" ? (
            <Field><FieldLabel htmlFor="free-time-duration">{t.itemDialog.durationMinutes}</FieldLabel><Input id="free-time-duration" type="number" min="1" required value={durationMinutes} onChange={(event) => setDurationMinutes(event.target.value)} /></Field>
          ) : null}

          {type !== "free-time" ? (
            <FieldSet className="rounded-xl border p-4">
              <FieldLegend>{t.itemDialog.money}</FieldLegend>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="item-amount">{t.itemDialog.minorAmount}</FieldLabel>
                  <Input id="item-amount" type="number" min="0" step="1" placeholder={t.itemDialog.minorAmountPlaceholder} value={amountMinor} onChange={(event) => setAmountMinor(event.target.value)} />
                  <FieldDescription>{t.itemDialog.minorAmountDescription}</FieldDescription>
                </Field>
                <Field><FieldLabel htmlFor="item-currency">{t.itemDialog.currency}</FieldLabel><Input id="item-currency" maxLength={3} placeholder={t.itemDialog.currencyPlaceholder} value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} /></Field>
              </div>
            </FieldSet>
          ) : null}

          {!item ? (
            <FieldSet className="rounded-xl border p-4">
              <FieldLegend>{t.itemDialog.initialConstraint}</FieldLegend>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field>
                  <FieldLabel htmlFor="constraint-type">{t.itemDialog.constraint}</FieldLabel>
                  <select id="constraint-type" className="min-h-10 rounded-lg border border-input bg-transparent px-3" value={constraintType} onChange={(event) => setConstraintType(event.target.value as ConstraintType | "")}>
                    <option value="">{t.itemDialog.none}</option>
                    <option value="fixed_time">{t.itemDialog.constraintTypes.fixed_time}</option>
                    <option value="immovable">{t.itemDialog.constraintTypes.immovable}</option>
                    <option value="minimum_buffer">{t.itemDialog.constraintTypes.minimum_buffer}</option>
                  </select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="constraint-status">{t.itemDialog.knowledgeStatus}</FieldLabel>
                  <select id="constraint-status" className="min-h-10 rounded-lg border border-input bg-transparent px-3" value={constraintStatus} onChange={(event) => setConstraintStatus(event.target.value as ConstraintStatus)}>
                    <option value="confirmed">{t.itemDialog.constraintStatuses.confirmed}</option>
                    <option value="unknown">{t.itemDialog.constraintStatuses.unknown}</option>
                    <option value="conflicted">{t.itemDialog.constraintStatuses.conflicted}</option>
                  </select>
                </Field>
                {constraintType === "minimum_buffer" ? (
                  <Field><FieldLabel htmlFor="constraint-buffer">{t.itemDialog.bufferMinutes}</FieldLabel><Input id="constraint-buffer" type="number" min="0" required value={minimumBufferMinutes} onChange={(event) => setMinimumBufferMinutes(event.target.value)} /></Field>
                ) : null}
              </div>
            </FieldSet>
          ) : null}

          <Field><FieldLabel htmlFor="item-source">{t.itemDialog.sourceUrl}</FieldLabel><Input id="item-source" type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} /></Field>
          <Field><FieldLabel htmlFor="item-notes">{t.itemDialog.notes}</FieldLabel><Textarea id="item-notes" value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
          {error ? <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" disabled={submitting} onClick={() => void submit()}>{submitting ? t.itemDialog.saving : t.itemDialog.save}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
