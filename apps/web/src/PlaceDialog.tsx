import { useRef, useState, type ReactNode } from "react";
import {
  PLACE_TYPES,
  type PlaceDto,
  type PlaceType,
  type UpdatePlaceInput,
} from "@along-the-way/contracts/trip-skeleton";
import { MapPin, Pencil } from "lucide-react";

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
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "./i18n";
import { notify } from "./AppToaster";
import { ConflictPanel, useVersionConflict, type EditSnapshot } from "./ConflictPanel";
import "./form-sheet.css";

type PlaceValues = Omit<UpdatePlaceInput, "expectedVersion">;

interface PlaceDialogProps {
  place: PlaceDto;
  save(input: UpdatePlaceInput, conflictBase?: number): Promise<void>;
  load?(): Promise<PlaceDto | null>;
  editingChanged?(open: boolean): void;
  focusLocationOnOpen?: boolean;
  initiallyOpen?: boolean;
  triggerLabel?: ReactNode;
  triggerClassName?: string;
  triggerDisabled?: boolean;
}

const placeTypes: readonly PlaceType[] = PLACE_TYPES;

function placeValues(place: PlaceDto): PlaceValues {
  return { name: place.name, type: place.type, address: place.address, latitude: place.latitude, longitude: place.longitude, timeZone: place.timeZone, sourceUrl: place.sourceUrl, notes: place.notes };
}

export function PlaceDialog({
  place,
  save,
  load,
  editingChanged,
  initiallyOpen = false,
  focusLocationOnOpen = false,
  triggerLabel,
  triggerClassName,
  triggerDisabled = false,
}: PlaceDialogProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(initiallyOpen);
  const addressRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(place.name);
  const [type, setType] = useState<PlaceType>(place.type);
  const [address, setAddress] = useState(place.address ?? "");
  const [latitude, setLatitude] = useState(place.latitude?.toString() ?? "");
  const [longitude, setLongitude] = useState(place.longitude?.toString() ?? "");
  const [timeZone, setTimeZone] = useState(place.timeZone ?? "");
  const [sourceUrl, setSourceUrl] = useState(place.sourceUrl ?? "");
  const [notes, setNotes] = useState(place.notes ?? "");
  const [expectedVersion, setExpectedVersion] = useState(place.version);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [base, setBase] = useState<EditSnapshot<PlaceValues> | null>({ input: placeValues(place), version: place.version });
  const resolution = useVersionConflict<PlaceValues>();

  function resetDraft() {
    resolution.clear();
    setBase({ input: placeValues(place), version: place.version });
    setName(place.name);
    setType(place.type);
    setAddress(place.address ?? "");
    setLatitude(place.latitude?.toString() ?? "");
    setLongitude(place.longitude?.toString() ?? "");
    setTimeZone(place.timeZone ?? "");
    setSourceUrl(place.sourceUrl ?? "");
    setNotes(place.notes ?? "");
    setExpectedVersion(place.version);
    setError("");
  }

  function changeOpen(nextOpen: boolean) {
    if (nextOpen && !open) resetDraft();
    setOpen(nextOpen);
    editingChanged?.(nextOpen);
  }

  async function persist(input: PlaceValues, version: number, conflictBase = resolution.conflictBaseVersion) {
    setSubmitting(true);
    setError("");
    try {
      await save({ ...input, expectedVersion: version }, conflictBase);
      resolution.clear();
      changeOpen(false);
    } catch (reason) {
      try {
        if (base && load && await resolution.capture(reason, base, input, async () => {
          const current = await load();
          return current ? { input: placeValues(current), version: current.version } : null;
        })) return;
        notify("error", reason instanceof Error ? reason.message : t.placeDialog.saveError);
      } catch (failure) { notify("error", failure instanceof Error ? failure.message : t.collaboration.loadError); }
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
      const input: PlaceValues = {
        name,
        type,
        address: address || null,
        latitude: latitudeNumber,
        longitude: longitudeNumber,
        timeZone: timeZone || null,
        sourceUrl: sourceUrl || null,
        notes: notes || null,
      };
      await persist(input, expectedVersion);
    } catch (reason) {
      notify("error", reason instanceof Error ? reason.message : t.placeDialog.saveError);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger
        render={
          <Button
            className={triggerClassName}
            variant="outline"
            size="sm"
            disabled={triggerDisabled}
          />
        }
      >
        {triggerLabel ?? (
          <>
            <Pencil />
            {t.placeDialog.editTrigger(place.name)}
          </>
        )}
      </DialogTrigger>
      <DialogContent
        className="form-sheet form-sheet--place"
        initialFocus={focusLocationOnOpen ? () => addressRef.current : undefined}
        placement="sheet"
      >
        <DialogHeader>
          <DialogTitle>{t.placeDialog.editPlace}</DialogTitle>
          <DialogDescription>{t.placeDialog.description}</DialogDescription>
        </DialogHeader>
        {resolution.conflict ? (
          <div className="form-sheet__body">
            <ConflictPanel
              conflict={resolution.conflict}
              busy={submitting}
              onAccept={() => { resolution.clear(); changeOpen(false); }}
              onReapply={() => void persist(resolution.conflict!.attempted, resolution.conflict!.current!.version, resolution.conflict!.base.version)}
              onEdit={() => { setBase(resolution.conflict!.current!); setExpectedVersion(resolution.conflict!.current!.version); resolution.resume(); setError(""); }}
            />
          </div>
        ) : null}
        <form
          hidden={Boolean(resolution.conflict)}
          className="form-sheet__form"
          onSubmit={(event) => { event.preventDefault(); void submit(); }}
        >
          <div className="form-sheet__body grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`place-name-${place.id}`}>{t.placeDialog.placeName}</FieldLabel>
              <Input
                id={`place-name-${place.id}`}
                required
                maxLength={200}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`place-type-${place.id}`}>{t.placeDialog.placeType}</FieldLabel>
              <NativeSelect
                id={`place-type-${place.id}`}
                className="w-full rounded-lg border border-input bg-transparent"
                value={type}
                onChange={(event) => setType(event.target.value as PlaceType)}
              >
                {placeTypes.map((placeType) => (
                  <option key={placeType} value={placeType}>{t.placeDialog.placeTypes[placeType]}</option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor={`place-address-${place.id}`}>{t.placeDialog.address}</FieldLabel>
            <Input
              id={`place-address-${place.id}`}
              ref={addressRef}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`place-latitude-${place.id}`}>{t.placeDialog.latitude}</FieldLabel>
              <Input
                id={`place-latitude-${place.id}`}
                inputMode="decimal"
                value={latitude}
                onChange={(event) => setLatitude(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`place-longitude-${place.id}`}>{t.placeDialog.longitude}</FieldLabel>
              <Input
                id={`place-longitude-${place.id}`}
                inputMode="decimal"
                value={longitude}
                onChange={(event) => setLongitude(event.target.value)}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor={`place-time-zone-${place.id}`}>{t.placeDialog.ianaTimeZone}</FieldLabel>
            <Input
              id={`place-time-zone-${place.id}`}
              placeholder={t.placeDialog.timeZonePlaceholder}
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
            />
            <FieldDescription>{t.placeDialog.timeZoneDescription}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`place-source-${place.id}`}>{t.placeDialog.sourceUrl}</FieldLabel>
            <Input
              id={`place-source-${place.id}`}
              type="url"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`place-notes-${place.id}`}>{t.placeDialog.notes}</FieldLabel>
            <Textarea
              id={`place-notes-${place.id}`}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
          {latitude === "" || longitude === "" ? (
            <p className="flex items-start gap-1 rounded-lg bg-surface-subtle px-3 py-2 text-sm text-muted-foreground">
              <MapPin className="mt-0.5 size-3.5 shrink-0" /> {t.placeDialog.locationIncomplete}
            </p>
          ) : null}
          {error ? <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{error}</p> : null}
          </div>
          <DialogFooter className="form-sheet__footer">
            <Button type="button" variant="outline" disabled={submitting} onClick={() => changeOpen(false)}>
              {t.travel.cancel}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? t.placeDialog.saving : t.placeDialog.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
