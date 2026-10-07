import { useState } from "react";
import type {
  CreatePlaceInput,
  PlaceDto,
  PlaceType,
  UpdatePlaceInput,
} from "@along-the-way/contracts/trip-skeleton";
import { MapPin, Pencil, Plus } from "lucide-react";

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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "./i18n";
import { ConflictPanel, useVersionConflict, type EditSnapshot } from "./ConflictPanel";

interface PlaceDialogProps {
  place?: PlaceDto;
  save(input: CreatePlaceInput | UpdatePlaceInput, conflictBase?: number): Promise<void>;
  load?(): Promise<PlaceDto | null>;
  editingChanged?(open: boolean): void;
}

const placeTypes: PlaceType[] = [
  "airport",
  "station",
  "lodging",
  "restaurant",
  "activity",
  "other",
];

function placeValues(place: PlaceDto): CreatePlaceInput {
  return { name: place.name, type: place.type, address: place.address, latitude: place.latitude, longitude: place.longitude, timeZone: place.timeZone, sourceUrl: place.sourceUrl, notes: place.notes };
}

export function PlaceDialog({ place, save, load, editingChanged }: PlaceDialogProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(place?.name ?? "");
  const [type, setType] = useState<PlaceType>(place?.type ?? "other");
  const [address, setAddress] = useState(place?.address ?? "");
  const [latitude, setLatitude] = useState(place?.latitude?.toString() ?? "");
  const [longitude, setLongitude] = useState(place?.longitude?.toString() ?? "");
  const [timeZone, setTimeZone] = useState(place?.timeZone ?? "");
  const [sourceUrl, setSourceUrl] = useState(place?.sourceUrl ?? "");
  const [notes, setNotes] = useState(place?.notes ?? "");
  const [expectedVersion, setExpectedVersion] = useState<number | null>(
    place?.version ?? null,
  );
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [base, setBase] = useState<EditSnapshot<CreatePlaceInput> | null>(place ? { input: placeValues(place), version: place.version } : null);
  const resolution = useVersionConflict<CreatePlaceInput>();

  function resetDraft() {
    resolution.clear();
    setBase(place ? { input: placeValues(place), version: place.version } : null);
    setName(place?.name ?? "");
    setType(place?.type ?? "other");
    setAddress(place?.address ?? "");
    setLatitude(place?.latitude?.toString() ?? "");
    setLongitude(place?.longitude?.toString() ?? "");
    setTimeZone(place?.timeZone ?? "");
    setSourceUrl(place?.sourceUrl ?? "");
    setNotes(place?.notes ?? "");
    setExpectedVersion(place?.version ?? null);
    setError("");
  }

  function changeOpen(nextOpen: boolean) {
    if (nextOpen && !open) resetDraft();
    setOpen(nextOpen);
    editingChanged?.(nextOpen);
  }

  async function persist(input: CreatePlaceInput, version: number | null, conflictBase = resolution.conflictBaseVersion) {
    setSubmitting(true);
    setError("");
    try {
      await save(place ? { ...input, expectedVersion: version! } : input, conflictBase);
      resolution.clear();
      changeOpen(false);
    } catch (reason) {
      try {
        if (base && load && await resolution.capture(reason, base, input, async () => {
          const current = await load();
          return current ? { input: placeValues(current), version: current.version } : null;
        })) return;
        setError(reason instanceof Error ? reason.message : t.placeDialog.saveError);
      } catch (failure) { setError(failure instanceof Error ? failure.message : t.collaboration.loadError); }
    } finally { setSubmitting(false); }
  }

  async function submit() {
    setError("");
    const latitudeMissing = latitude.trim() === "";
    const longitudeMissing = longitude.trim() === "";
    if (latitudeMissing !== longitudeMissing) {
      setError(t.placeDialog.coordinatesTogether);
      return;
    }
    const latitudeNumber = latitudeMissing ? null : Number(latitude);
    const longitudeNumber = longitudeMissing ? null : Number(longitude);
    if (
      latitudeNumber !== null
      && (!Number.isFinite(latitudeNumber) || latitudeNumber < -90 || latitudeNumber > 90)
    ) {
      setError(t.placeDialog.latitudeRange);
      return;
    }
    if (
      longitudeNumber !== null
      && (!Number.isFinite(longitudeNumber) || longitudeNumber < -180 || longitudeNumber > 180)
    ) {
      setError(t.placeDialog.longitudeRange);
      return;
    }
    setSubmitting(true);
    try {
      const input: CreatePlaceInput = {
        name,
        type,
        address: address || null,
        latitude: latitudeNumber,
        longitude: longitudeNumber,
        timeZone: timeZone || null,
        sourceUrl: sourceUrl || null,
        notes: notes || null,
      };
      if (place && expectedVersion === null) {
        throw new Error(t.placeDialog.unavailableVersion);
      }
      await persist(input, expectedVersion);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.placeDialog.saveError);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        render={
          <Button variant={place ? "outline" : "default"} size={place ? "sm" : "default"} />
        }
      >
        {place ? <Pencil /> : <Plus />}
        {place ? t.placeDialog.editTrigger(place.name) : t.placeDialog.addPlace}
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{place ? t.placeDialog.editPlace : t.placeDialog.addPlace}</DialogTitle>
          <DialogDescription>{t.placeDialog.description}</DialogDescription>
        </DialogHeader>
        {resolution.conflict ? <ConflictPanel conflict={resolution.conflict} busy={submitting}
          onAccept={() => { resolution.clear(); changeOpen(false); }}
          onReapply={() => void persist(resolution.conflict!.attempted, resolution.conflict!.current!.version, resolution.conflict!.base.version)}
          onEdit={() => { setBase(resolution.conflict!.current!); setExpectedVersion(resolution.conflict!.current!.version); resolution.resume(); setError(""); }}
        /> : null}
        {resolution.conflict && error ? <p role="alert" className="text-destructive">{error}</p> : null}
        <form hidden={Boolean(resolution.conflict)} className="grid gap-4" onSubmit={(event) => event.preventDefault()}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`place-name-${place?.id ?? "new"}`}>{t.placeDialog.placeName}</FieldLabel>
              <Input
                id={`place-name-${place?.id ?? "new"}`}
                required
                maxLength={200}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`place-type-${place?.id ?? "new"}`}>{t.placeDialog.placeType}</FieldLabel>
              <select
                id={`place-type-${place?.id ?? "new"}`}
                className="min-h-10 rounded-lg border border-input bg-transparent px-3"
                value={type}
                onChange={(event) => setType(event.target.value as PlaceType)}
              >
                {placeTypes.map((placeType) => (
                  <option key={placeType} value={placeType}>{t.placeDialog.placeTypes[placeType]}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor={`place-address-${place?.id ?? "new"}`}>{t.placeDialog.address}</FieldLabel>
            <Input
              id={`place-address-${place?.id ?? "new"}`}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`place-latitude-${place?.id ?? "new"}`}>{t.placeDialog.latitude}</FieldLabel>
              <Input
                id={`place-latitude-${place?.id ?? "new"}`}
                inputMode="decimal"
                value={latitude}
                onChange={(event) => setLatitude(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`place-longitude-${place?.id ?? "new"}`}>{t.placeDialog.longitude}</FieldLabel>
              <Input
                id={`place-longitude-${place?.id ?? "new"}`}
                inputMode="decimal"
                value={longitude}
                onChange={(event) => setLongitude(event.target.value)}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor={`place-time-zone-${place?.id ?? "new"}`}>{t.placeDialog.ianaTimeZone}</FieldLabel>
            <Input
              id={`place-time-zone-${place?.id ?? "new"}`}
              placeholder={t.placeDialog.timeZonePlaceholder}
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
            />
            <FieldDescription>{t.placeDialog.timeZoneDescription}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`place-source-${place?.id ?? "new"}`}>{t.placeDialog.sourceUrl}</FieldLabel>
            <Input
              id={`place-source-${place?.id ?? "new"}`}
              type="url"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`place-notes-${place?.id ?? "new"}`}>{t.placeDialog.notes}</FieldLabel>
            <Textarea
              id={`place-notes-${place?.id ?? "new"}`}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
          {latitude === "" || longitude === "" ? (
            <p className="flex items-center gap-2 rounded-lg bg-surface-subtle px-3 py-2 text-sm text-muted-foreground">
              <MapPin className="size-4" /> {t.placeDialog.locationIncomplete}
            </p>
          ) : null}
          {error ? <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" disabled={submitting} onClick={() => void submit()}>
              {submitting ? t.placeDialog.saving : t.placeDialog.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
