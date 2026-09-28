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

interface PlaceDialogProps {
  place?: PlaceDto;
  save(input: CreatePlaceInput | UpdatePlaceInput): Promise<void>;
}

const placeTypes: Array<{ value: PlaceType; label: string }> = [
  { value: "airport", label: "Airport" },
  { value: "station", label: "Station" },
  { value: "lodging", label: "Lodging" },
  { value: "restaurant", label: "Restaurant" },
  { value: "activity", label: "Activity venue" },
  { value: "other", label: "Other" },
];

export function PlaceDialog({ place, save }: PlaceDialogProps) {
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

  function resetDraft() {
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
  }

  async function submit() {
    setError("");
    const latitudeMissing = latitude.trim() === "";
    const longitudeMissing = longitude.trim() === "";
    if (latitudeMissing !== longitudeMissing) {
      setError("Enter both latitude and longitude, or leave both blank.");
      return;
    }
    const latitudeNumber = latitudeMissing ? null : Number(latitude);
    const longitudeNumber = longitudeMissing ? null : Number(longitude);
    if (
      latitudeNumber !== null
      && (!Number.isFinite(latitudeNumber) || latitudeNumber < -90 || latitudeNumber > 90)
    ) {
      setError("Latitude must be a number from -90 to 90.");
      return;
    }
    if (
      longitudeNumber !== null
      && (!Number.isFinite(longitudeNumber) || longitudeNumber < -180 || longitudeNumber > 180)
    ) {
      setError("Longitude must be a number from -180 to 180.");
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
        throw new Error("The Place version is unavailable");
      }
      await save(
        place ? { ...input, expectedVersion: expectedVersion! } : input,
      );
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the place");
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
        {place ? `Edit ${place.name}` : "Add place"}
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{place ? "Edit place" : "Add a place"}</DialogTitle>
          <DialogDescription>
            Save the real location separately from its itinerary timing. Coordinates and time zone can be completed later.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => event.preventDefault()}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`place-name-${place?.id ?? "new"}`}>Place name</FieldLabel>
              <Input
                id={`place-name-${place?.id ?? "new"}`}
                required
                maxLength={200}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`place-type-${place?.id ?? "new"}`}>Place type</FieldLabel>
              <select
                id={`place-type-${place?.id ?? "new"}`}
                className="min-h-10 rounded-lg border border-input bg-transparent px-3"
                value={type}
                onChange={(event) => setType(event.target.value as PlaceType)}
              >
                {placeTypes.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor={`place-address-${place?.id ?? "new"}`}>Address</FieldLabel>
            <Input
              id={`place-address-${place?.id ?? "new"}`}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`place-latitude-${place?.id ?? "new"}`}>Latitude</FieldLabel>
              <Input
                id={`place-latitude-${place?.id ?? "new"}`}
                inputMode="decimal"
                value={latitude}
                onChange={(event) => setLatitude(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`place-longitude-${place?.id ?? "new"}`}>Longitude</FieldLabel>
              <Input
                id={`place-longitude-${place?.id ?? "new"}`}
                inputMode="decimal"
                value={longitude}
                onChange={(event) => setLongitude(event.target.value)}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor={`place-time-zone-${place?.id ?? "new"}`}>IANA time zone</FieldLabel>
            <Input
              id={`place-time-zone-${place?.id ?? "new"}`}
              placeholder="Asia/Tokyo"
              value={timeZone}
              onChange={(event) => setTimeZone(event.target.value)}
            />
            <FieldDescription>
              Optional while saving a Place, but required before this Place can anchor a timed item.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`place-source-${place?.id ?? "new"}`}>Official or source URL</FieldLabel>
            <Input
              id={`place-source-${place?.id ?? "new"}`}
              type="url"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`place-notes-${place?.id ?? "new"}`}>Notes</FieldLabel>
            <Textarea
              id={`place-notes-${place?.id ?? "new"}`}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>
          {latitude === "" || longitude === "" ? (
            <p className="flex items-center gap-2 rounded-lg bg-surface-subtle px-3 py-2 text-sm text-muted-foreground">
              <MapPin className="size-4" /> Location details incomplete
            </p>
          ) : null}
          {error ? <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" disabled={submitting} onClick={() => void submit()}>
              {submitting ? "Saving…" : "Save place"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
