import { useEffect, useId, useMemo, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import type { TripAirportInput, TripFlightInput } from "@along-the-way/contracts/private-trips";
import { ChevronDown } from "lucide-react";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  airportInput,
  airportLabel,
  loadAirportData,
  searchAirports,
} from "./airport-data";
import type { AirportRecord } from "./airport-data";
import { useI18n } from "./i18n";

export function emptyFlight(departureZone = "", arrivalZone = ""): TripFlightInput {
  return {
    serviceNumber: "",
    carrier: null,
    departureAirport: { name: "", timeZone: departureZone },
    arrivalAirport: { name: "", timeZone: arrivalZone },
    departureLocalDateTime: "",
    arrivalLocalDateTime: "",
  };
}

export function ambiguousUtcOffsets(localDateTime: string, timeZone: string) {
  if (!localDateTime || !timeZone) return [];
  try {
    const local = Temporal.PlainDateTime.from(localDateTime);
    const earlier = local.toZonedDateTime(timeZone, { disambiguation: "earlier" });
    const later = local.toZonedDateTime(timeZone, { disambiguation: "later" });
    if (!earlier.toPlainDateTime().equals(local)
      || !later.toPlainDateTime().equals(local)
      || earlier.epochNanoseconds === later.epochNanoseconds) return [];
    return earlier.offset === later.offset ? [earlier.offset] : [earlier.offset, later.offset];
  } catch {
    return [];
  }
}

export function flightComplete(flight: TripFlightInput) {
  const required = [
    flight.departureAirport.name,
    flight.departureAirport.timeZone,
    flight.arrivalAirport.name,
    flight.arrivalAirport.timeZone,
    flight.departureLocalDateTime,
    flight.arrivalLocalDateTime,
  ];
  if (!required.every((value) => value.trim().length > 0)) return false;
  const departureOffsets = ambiguousUtcOffsets(
    flight.departureLocalDateTime,
    flight.departureAirport.timeZone,
  );
  const arrivalOffsets = ambiguousUtcOffsets(
    flight.arrivalLocalDateTime,
    flight.arrivalAirport.timeZone,
  );
  return (!departureOffsets.length || departureOffsets.includes(flight.departureUtcOffset ?? ""))
    && (!arrivalOffsets.length || arrivalOffsets.includes(flight.arrivalUtcOffset ?? ""));
}

function AirportPicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: TripAirportInput;
  onChange(value: TripAirportInput): void;
}) {
  const { t } = useI18n();
  const [airports, setAirports] = useState<readonly AirportRecord[]>([]);
  const [inputValue, setInputValue] = useState(value.name);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void loadAirportData().then((loaded) => {
      if (active) {
        setAirports(loaded);
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => setInputValue(value.name), [value.name]);
  const matches = useMemo(
    () => searchAirports(airports, inputValue),
    [airports, inputValue],
  );
  const selected = airports.find((airport) =>
    value.name === `${airport[0]} · ${airport[1]}`
    && value.timeZone === airport[6]
    && value.latitude === airport[4]
    && value.longitude === airport[5]) ?? null;

  return (
    <Combobox
      items={matches}
      value={selected}
      inputValue={inputValue}
      onInputValueChange={(nextValue) => {
        setInputValue(nextValue);
        if (nextValue !== value.name) onChange({ name: nextValue, timeZone: "" });
      }}
      onValueChange={(airport) => {
        if (airport) onChange(airportInput(airport));
      }}
      itemToStringLabel={airportLabel}
      itemToStringValue={(airport) => airport[0]}
      isItemEqualToValue={(airport, current) => airport[0] === current[0]}
      autoHighlight
    >
      <ComboboxInput
        id={id}
        required
        maxLength={200}
        autoComplete="off"
        placeholder={t.travel.airportSearchPlaceholder}
        className="w-full"
      />
      <ComboboxContent>
        <ComboboxEmpty>
          {loading ? t.travel.loadingAirports : t.travel.noAirportsFound}
        </ComboboxEmpty>
        <ComboboxList>
          {(airport: AirportRecord) => (
            <ComboboxItem key={airport[0]} value={airport}>
              <span className="min-w-0">
                <strong>{airport[0]}</strong>
                <span className="ml-2">{airport[1]}</span>
                <small className="block truncate text-muted-foreground">
                  {[airport[2], airport[3]].filter(Boolean).join(" · ")}
                </small>
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

type FlightSide = "departure" | "arrival";

function EndpointFields({
  id,
  side,
  value,
  onChange,
  startDate,
  endDate,
}: {
  id: string;
  side: FlightSide;
  value: TripFlightInput;
  onChange(value: TripFlightInput): void;
  startDate?: string;
  endDate?: string;
}) {
  const { t } = useI18n();
  const airportKey = side === "departure" ? "departureAirport" : "arrivalAirport";
  const timeKey = side === "departure" ? "departureLocalDateTime" : "arrivalLocalDateTime";
  const offsetKey = side === "departure" ? "departureUtcOffset" : "arrivalUtcOffset";
  const airport = value[airportKey];
  const offsets = ambiguousUtcOffsets(value[timeKey], airport.timeZone);

  return (
    <section className="grid gap-3" aria-labelledby={`${id}-${side}-heading`}>
      <h3 id={`${id}-${side}-heading`} className="text-sm font-semibold">
        {side === "departure" ? t.travel.departure : t.travel.arrival}
      </h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-${side}-airport`}>{t.travel.airport}</FieldLabel>
          <AirportPicker
            id={`${id}-${side}-airport`}
            value={airport}
            onChange={(nextAirport) => onChange({
              ...value,
              [airportKey]: nextAirport,
              [offsetKey]: null,
            })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-${side}-time`}>
            {side === "departure" ? t.travel.departureTime : t.travel.arrivalTime}
          </FieldLabel>
          <Input
            id={`${id}-${side}-time`}
            type="datetime-local"
            required
            min={startDate ? `${startDate}T00:00` : undefined}
            max={endDate ? `${endDate}T23:59` : undefined}
            value={value[timeKey]}
            onChange={(event) => onChange({
              ...value,
              [timeKey]: event.target.value,
              [offsetKey]: null,
            })}
          />
        </Field>
      </div>
      <p className="text-sm text-muted-foreground">
        {airport.timeZone
          ? airport.latitude !== undefined
            ? t.travel.derivedTimeZone(airport.timeZone)
            : t.travel.manualTimeZone(airport.timeZone)
          : t.travel.timeZoneNeeded}
      </p>
      {offsets.length > 1 ? (
        <Field>
          <FieldLabel htmlFor={`${id}-${side}-offset`}>
            {side === "departure" ? t.travel.departureOccurrence : t.travel.arrivalOccurrence}
          </FieldLabel>
          <NativeSelect
            id={`${id}-${side}-offset`}
            required
            value={value[offsetKey] ?? ""}
            onChange={(event) => onChange({
              ...value,
              [offsetKey]: event.target.value || null,
            })}
          >
            <option value="">{t.travel.chooseUtcOffset}</option>
            {offsets.map((offset) => (
              <option key={offset} value={offset}>{t.travel.utcOffsetOption(offset)}</option>
            ))}
          </NativeSelect>
          <FieldDescription>{t.travel.repeatedHourDescription}</FieldDescription>
        </Field>
      ) : null}
    </section>
  );
}

export function FlightFields({ value, onChange, legend, startDate, endDate }: {
  value: TripFlightInput;
  onChange(value: TripFlightInput): void;
  legend: string;
  startDate?: string;
  endDate?: string;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <fieldset className="grid min-w-0 gap-5 rounded-xl border p-4">
      <legend className="px-1 font-semibold">{legend}</legend>
      <EndpointFields id={id} side="departure" value={value} onChange={onChange}
        startDate={startDate} endDate={endDate} />
      <EndpointFields id={id} side="arrival" value={value} onChange={onChange}
        startDate={startDate} endDate={endDate} />
      <details className="rounded-lg border">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 font-medium">
          {t.travel.optionalFlightInformation}
          <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground" />
        </summary>
        <div className="grid gap-4 border-t p-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-number`}>{t.travel.flightNumber}</FieldLabel>
            <Input id={`${id}-number`} maxLength={100} value={value.serviceNumber}
              onChange={(event) => onChange({ ...value, serviceNumber: event.target.value })} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-carrier`}>{t.travel.carrier}</FieldLabel>
            <Input id={`${id}-carrier`} maxLength={200} value={value.carrier ?? ""}
              onChange={(event) => onChange({ ...value, carrier: event.target.value || null })} />
          </Field>
        </div>
      </details>
      <details className="rounded-lg border">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 font-medium">
          {t.travel.advancedSettings}
          <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground" />
        </summary>
        <div className="grid gap-4 border-t p-3 sm:grid-cols-2">
          {(["departure", "arrival"] as const).map((side) => {
            const airportKey = side === "departure" ? "departureAirport" : "arrivalAirport";
            const offsetKey = side === "departure" ? "departureUtcOffset" : "arrivalUtcOffset";
            return (
              <Field key={side}>
                <FieldLabel htmlFor={`${id}-${side}-zone`}>
                  {side === "departure" ? t.travel.departureTimeZone : t.travel.arrivalTimeZone}
                </FieldLabel>
                <Input
                  id={`${id}-${side}-zone`}
                  required
                  placeholder={t.placeDialog.timeZonePlaceholder}
                  value={value[airportKey].timeZone}
                  onChange={(event) => onChange({
                    ...value,
                    [airportKey]: {
                      ...value[airportKey],
                      timeZone: event.target.value,
                    },
                    [offsetKey]: null,
                  })}
                />
                <FieldDescription>
                  {value[airportKey].latitude === undefined
                    ? t.travel.manualAirportDescription
                    : t.travel.derivedAirportDescription}
                </FieldDescription>
              </Field>
            );
          })}
        </div>
      </details>
    </fieldset>
  );
}
