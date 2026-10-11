import { useId } from "react";
import type { TripFlightInput } from "@along-the-way/contracts/private-trips";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useI18n } from "./i18n";

export function emptyFlight(departureZone = "", arrivalZone = ""): TripFlightInput {
  return {
    serviceNumber: "", carrier: null,
    departureAirport: { name: "", timeZone: departureZone },
    arrivalAirport: { name: "", timeZone: arrivalZone },
    departureLocalDateTime: "", arrivalLocalDateTime: "",
  };
}

export function flightComplete(flight: TripFlightInput) {
  return [flight.serviceNumber, flight.departureAirport.name, flight.departureAirport.timeZone,
    flight.arrivalAirport.name, flight.arrivalAirport.timeZone, flight.departureLocalDateTime,
    flight.arrivalLocalDateTime].every((value) => value.trim().length > 0);
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
  return <fieldset className="grid min-w-0 gap-4 rounded-xl border p-4">
    <legend className="px-1 font-semibold">{legend}</legend>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field><FieldLabel htmlFor={`${id}-number`}>{t.travel.flightNumber}</FieldLabel>
        <Input id={`${id}-number`} required maxLength={100} value={value.serviceNumber} onChange={(event) => onChange({ ...value, serviceNumber: event.target.value })} /></Field>
      <Field><FieldLabel htmlFor={`${id}-carrier`}>{t.travel.carrier}</FieldLabel>
        <Input id={`${id}-carrier`} maxLength={200} value={value.carrier ?? ""} onChange={(event) => onChange({ ...value, carrier: event.target.value || null })} /></Field>
    </div>
    {(["departure", "arrival"] as const).map((side) => {
      const airportKey = side === "departure" ? "departureAirport" : "arrivalAirport";
      const timeKey = side === "departure" ? "departureLocalDateTime" : "arrivalLocalDateTime";
      const offsetKey = side === "departure" ? "departureUtcOffset" : "arrivalUtcOffset";
      return <div key={side} className="grid gap-4 sm:grid-cols-2">
        <Field><FieldLabel htmlFor={`${id}-${side}-airport`}>{t.travel[side === "departure" ? "departureAirport" : "arrivalAirport"]}</FieldLabel>
          <Input id={`${id}-${side}-airport`} required maxLength={200} value={value[airportKey].name} onChange={(event) => onChange({ ...value, [airportKey]: { ...value[airportKey], name: event.target.value } })} /></Field>
        <Field><FieldLabel htmlFor={`${id}-${side}-zone`}>{t.travel[side === "departure" ? "departureTimeZone" : "arrivalTimeZone"]}</FieldLabel>
          <Input id={`${id}-${side}-zone`} required placeholder={t.placeDialog.timeZonePlaceholder} value={value[airportKey].timeZone} onChange={(event) => onChange({ ...value, [airportKey]: { ...value[airportKey], timeZone: event.target.value }, [offsetKey]: null })} /></Field>
        <Field><FieldLabel htmlFor={`${id}-${side}-time`}>{t.travel[side === "departure" ? "departureTime" : "arrivalTime"]}</FieldLabel>
          <Input id={`${id}-${side}-time`} type="datetime-local" required min={startDate ? `${startDate}T00:00` : undefined} max={endDate ? `${endDate}T23:59` : undefined} value={value[timeKey]} onChange={(event) => onChange({ ...value, [timeKey]: event.target.value, [offsetKey]: null })} /></Field>
        <Field><FieldLabel htmlFor={`${id}-${side}-offset`}>{t.travel[side === "departure" ? "departureUtcOffset" : "arrivalUtcOffset"]}</FieldLabel>
          <Input id={`${id}-${side}-offset`} pattern="[+-][0-9]{2}:[0-9]{2}" placeholder={t.itemDialog.utcOffsetPlaceholder}
            value={value[offsetKey] ?? ""} onChange={(event) => onChange({ ...value, [offsetKey]: event.target.value || null })} />
          <FieldDescription>{t.itemDialog.utcOffsetDescription}</FieldDescription></Field>
      </div>;
    })}
  </fieldset>;
}
