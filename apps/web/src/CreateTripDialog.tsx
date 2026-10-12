import { useEffect, useMemo, useRef, useState } from "react";
import type { DateRange } from "react-day-picker";
import { format } from "date-fns";
import { CalendarIcon, ChevronDown, ChevronUp, ArrowLeft, ArrowRight, Trash2 } from "lucide-react";
import {
  countryOptions,
  filterCountryOptions,
  MAX_TRIP_COUNTRY_STOPS,
  type CountryOption,
} from "@along-the-way/contracts/countries";
import type { CreateTripInput } from "@along-the-way/contracts/private-trips";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "./i18n";
import { emptyFlight, FlightFields, flightComplete } from "./FlightFields";
import { sameAirport } from "./airport-data";

interface CreateTripDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  createTrip(input: CreateTripInput): Promise<void>;
}

interface DraftCountryStop {
  id: string;
  countryCode: string;
}

const availableCountries = countryOptions("zh-Hant");
const countriesByCode = new Map(
  availableCountries.map((country) => [country.code, country]),
);

function countryLabel(country: CountryOption) {
  return `${country.flag} ${country.localizedName} · ${country.englishName} (${country.code})`;
}

function hasAdjacentDuplicate(countryCodes: readonly string[]) {
  return countryCodes.some(
    (countryCode, index) => index > 0 && countryCodes[index - 1] === countryCode,
  );
}

export function CreateTripDialog({ open, onOpenChange, createTrip }: CreateTripDialogProps) {
  const { t } = useI18n();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const [name, setName] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>();
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const returnAirportTouched = useRef({ departure: false, arrival: false });
  const [countryStops, setCountryStops] = useState<DraftCountryStop[]>([]);
  const [countryQuery, setCountryQuery] = useState("");
  const [selectedCountry, setSelectedCountry] = useState<CountryOption | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outbound, setOutbound] = useState(() => emptyFlight());
  const [returnFlight, setReturnFlight] = useState(() => emptyFlight());
  useEffect(() => {
    if (!open) setDatePickerOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let focusFrame = 0;
    const renderFrame = window.requestAnimationFrame(() => {
      focusFrame = window.requestAnimationFrame(() => stepHeading.current?.focus());
    });
    return () => {
      window.cancelAnimationFrame(renderFrame);
      window.cancelAnimationFrame(focusFrame);
    };
  }, [open, step]);

  function updateOutbound(next: typeof outbound) {
    const previous = outbound;
    setOutbound(next);
    setReturnFlight((current) => {
      let mirrored = current;
      if (!returnAirportTouched.current.departure
        && !sameAirport(previous.arrivalAirport, next.arrivalAirport)) {
        mirrored = { ...mirrored, departureAirport: { ...next.arrivalAirport } };
      }
      if (!returnAirportTouched.current.arrival
        && !sameAirport(previous.departureAirport, next.departureAirport)) {
        mirrored = { ...mirrored, arrivalAirport: { ...next.departureAirport } };
      }
      return mirrored;
    });
  }

  function updateReturnFlight(next: typeof returnFlight) {
    if (!sameAirport(returnFlight.departureAirport, next.departureAirport)) {
      returnAirportTouched.current.departure = true;
    }
    if (!sameAirport(returnFlight.arrivalAirport, next.arrivalAirport)) {
      returnAirportTouched.current.arrival = true;
    }
    setReturnFlight(next);
  }

  const filteredCountries = useMemo(
    () => filterCountryOptions(availableCountries, countryQuery),
    [countryQuery],
  );

  function addCountry(country: CountryOption | null) {
    if (!country) return;
    setSelectedCountry(null);
    setCountryQuery("");
    if (countryStops.length >= MAX_TRIP_COUNTRY_STOPS) {
      setError(t.createTrip.maximumCountryStops(MAX_TRIP_COUNTRY_STOPS));
      return;
    }

    if (countryStops.at(-1)?.countryCode === country.code) {
      setError(t.createTrip.consecutiveCountry);
      return;
    }

    setCountryStops((current) => [
      ...current,
      { id: crypto.randomUUID(), countryCode: country.code },
    ]);
    setError("");
  }

  function moveCountry(index: number, offset: -1 | 1) {
    const destination = index + offset;
    if (destination < 0 || destination >= countryStops.length) return;

    const candidate = [...countryStops];
    const currentCountry = candidate[index];
    const destinationCountry = candidate[destination];
    if (!currentCountry || !destinationCountry) return;
    candidate[index] = destinationCountry;
    candidate[destination] = currentCountry;
    if (hasAdjacentDuplicate(candidate.map((stop) => stop.countryCode))) {
      setError(t.createTrip.moveCreatesConsecutiveCountry);
      return;
    }

    setCountryStops(candidate);
    setError("");
  }

  function removeCountry(index: number) {
    const candidate = countryStops.filter((_, itemIndex) => itemIndex !== index);
    if (hasAdjacentDuplicate(candidate.map((stop) => stop.countryCode))) {
      setError(t.createTrip.removalCreatesConsecutiveCountry);
      return;
    }
    setCountryStops(candidate);
    setError("");
  }

  function reset() {
    setStep(1);
    setName("");
    setDateRange(undefined);
    setCountryStops([]);
    setCountryQuery("");
    setSelectedCountry(null);
    setOutbound(emptyFlight());
    setReturnFlight(emptyFlight());
    returnAirportTouched.current = { departure: false, arrival: false };
    setError("");
  }

  async function submit() {
    if (!selectedStartDate || !selectedEndDate) {
      setError(t.createTrip.chooseStartAndEndDates);
      return;
    }
    if (countryStops.length === 0) {
      setError(t.createTrip.addAtLeastOneCountry);
      return;
    }
    if (!flightComplete(outbound, selectedStartDate, selectedEndDate)
      || !flightComplete(returnFlight, selectedStartDate, selectedEndDate)) {
      setError(t.travel.completeFlights);
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      await createTrip({
        name,
        startDate: selectedStartDate,
        endDate: selectedEndDate,
        countryCodes: countryStops.map((stop) => stop.countryCode),
        flights: { outbound, return: returnFlight },
      });
      reset();
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t.createTrip.couldNotCreate);
    } finally {
      setSubmitting(false);
    }
  }

  const selectedStartDate = dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : undefined;
  const selectedEndDate = dateRange?.to ? format(dateRange.to, "yyyy-MM-dd") : undefined;
  const tripStepValid = Boolean(name.trim() && dateRange?.from && dateRange.to);
  const routeStepValid = countryStops.length > 0;
  const routeSummary = countryStops
    .map((stop) => countriesByCode.get(stop.countryCode)?.localizedName ?? stop.countryCode)
    .join(" → ");

  return (
    <Dialog
      open={open}
      disablePointerDismissal
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setStep(1);
          setDatePickerOpen(false);
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-3xl"
        closeButtonClassName="size-11"
      >
        <DialogHeader className="pr-12">
          <DialogTitle>{t.createTrip.title}</DialogTitle>
          <DialogDescription>{t.createTrip.description}</DialogDescription>
        </DialogHeader>

        <form className="grid gap-5" onSubmit={(event) => event.preventDefault()}>
          <div className="create-trip-step" data-step={step}>
            <h2 ref={stepHeading} tabIndex={-1}>
              {step === 1
                ? t.createTrip.stepTrip
                : step === 2
                  ? t.createTrip.stepRoute
                  : t.createTrip.stepFlights}
            </h2>

            {step === 1 ? (
              <div className="grid gap-5">
                <Field>
                  <FieldLabel htmlFor="trip-name">{t.createTrip.tripName}</FieldLabel>
                  <Input
                    id="trip-name"
                    autoComplete="off"
                    maxLength={120}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                  />
                </Field>

                <Field>
                  <FieldLabel>{t.createTrip.tripDates}</FieldLabel>
                  <Popover
                    open={datePickerOpen}
                    onOpenChange={setDatePickerOpen}
                  >
                    <PopoverTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-10 w-full justify-start text-left font-normal"
                        />
                      }
                    >
                      <CalendarIcon />
                      {dateRange?.from
                        ? dateRange.to
                          ? `${format(dateRange.from, "yyyy/MM/dd")} – ${format(dateRange.to, "yyyy/MM/dd")}`
                          : `${format(dateRange.from, "yyyy/MM/dd")} – ${t.createTrip.chooseEndDate}`
                        : t.createTrip.chooseDateRange}
                    </PopoverTrigger>
                    <PopoverContent className="w-auto max-w-[calc(100vw-2rem)] p-0" align="start">
                      <Calendar
                        mode="range"
                        selected={dateRange}
                        onSelect={setDateRange}
                        resetOnSelect
                        defaultMonth={dateRange?.from}
                        numberOfMonths={1}
                      />
                      <div className="border-t p-3">
                        <Button
                          type="button"
                          className="h-11 w-full"
                          disabled={!dateRange?.from || !dateRange.to}
                          onClick={() => setDatePickerOpen(false)}
                        >
                          {t.createTrip.confirmDates}
                        </Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                  <FieldDescription>{t.createTrip.dateDescription}</FieldDescription>
                </Field>
              </div>
            ) : null}

            {step === 2 ? (
              <div className="grid gap-5">
                <Field>
                  <FieldLabel htmlFor="country-route-search">{t.createTrip.addCountry}</FieldLabel>
                  <Combobox
                    items={filteredCountries}
                    value={selectedCountry}
                    inputValue={countryQuery}
                    onInputValueChange={setCountryQuery}
                    autoHighlight
                    onValueChange={addCountry}
                    itemToStringLabel={countryLabel}
                    itemToStringValue={(country) => country.code}
                    isItemEqualToValue={(country, value) => country.code === value.code}
                  >
                    <ComboboxInput
                      id="country-route-search"
                      placeholder={t.createTrip.searchCountryPlaceholder}
                      autoComplete="off"
                      className="w-full"
                    />
                    <ComboboxContent>
                      <ComboboxEmpty>{t.createTrip.noCountriesFound}</ComboboxEmpty>
                      <ComboboxList>
                        {(country: CountryOption) => (
                          <ComboboxItem
                            key={country.code}
                            value={country}
                            disabled={countryStops.at(-1)?.countryCode === country.code}
                          >
                            <span className="truncate">{countryLabel(country)}</span>
                            {countryStops.at(-1)?.countryCode === country.code ? (
                              <span className="ml-auto text-xs text-muted-foreground">{t.createTrip.alreadyLast}</span>
                            ) : null}
                          </ComboboxItem>
                        )}
                      </ComboboxList>
                    </ComboboxContent>
                  </Combobox>
                  <FieldDescription>{t.createTrip.countryStopLimit(MAX_TRIP_COUNTRY_STOPS)}</FieldDescription>
                </Field>

                <section aria-labelledby="country-route-heading" className="grid gap-3">
                  <div className="flex items-center justify-between gap-3">
                    <h3 id="country-route-heading" className="font-semibold">{t.createTrip.countryRoute}</h3>
                    <span className="text-sm text-muted-foreground">{t.createTrip.stopCount(countryStops.length)}</span>
                  </div>
                  {countryStops.length === 0 ? (
                    <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                      {t.createTrip.emptyCountryRoute}
                    </p>
                  ) : (
                    <ol className="grid gap-2">
                      {countryStops.map((stop, index) => {
                        const country = countriesByCode.get(stop.countryCode);
                        return (
                          <li key={stop.id} className="flex min-w-0 items-center gap-3 rounded-lg border bg-secondary px-3 py-2">
                            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                              {index + 1}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">
                              {country ? countryLabel(country) : stop.countryCode}
                            </span>
                            <div className="flex shrink-0 gap-1">
                              <Button type="button" variant="ghost" size="icon-sm" aria-label={t.createTrip.moveStopUp(index + 1)}
                                disabled={index === 0} onClick={() => moveCountry(index, -1)}>
                                <ChevronUp />
                              </Button>
                              <Button type="button" variant="ghost" size="icon-sm" aria-label={t.createTrip.moveStopDown(index + 1)}
                                disabled={index === countryStops.length - 1} onClick={() => moveCountry(index, 1)}>
                                <ChevronDown />
                              </Button>
                              <Button type="button" variant="ghost" size="icon-sm" aria-label={t.createTrip.removeStop(index + 1)}
                                onClick={() => removeCountry(index)}>
                                <Trash2 />
                              </Button>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </section>
              </div>
            ) : null}

            {step === 3 ? (
              <div className="grid gap-5">
                <section className="create-trip-summary" aria-labelledby="create-trip-summary-heading">
                  <h3 id="create-trip-summary-heading">{t.createTrip.summary}</h3>
                  <dl>
                    <div>
                      <dt>{t.createTrip.tripName}</dt>
                      <dd>{name}</dd>
                    </div>
                    <div>
                      <dt>{t.createTrip.summaryDates}</dt>
                      <dd>{dateRange?.from && dateRange.to ? `${format(dateRange.from, "yyyy/MM/dd")} – ${format(dateRange.to, "yyyy/MM/dd")}` : ""}</dd>
                    </div>
                    <div>
                      <dt>{t.createTrip.summaryRoute}</dt>
                      <dd>{routeSummary}</dd>
                    </div>
                  </dl>
                </section>
                <FlightFields legend={t.travel.outbound} value={outbound} onChange={updateOutbound}
                  startDate={dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : undefined}
                  endDate={dateRange?.to ? format(dateRange.to, "yyyy-MM-dd") : undefined} />
                <FlightFields legend={t.travel.return} value={returnFlight} onChange={updateReturnFlight}
                  startDate={dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : undefined}
                  endDate={dateRange?.to ? format(dateRange.to, "yyyy-MM-dd") : undefined} />
              </div>
            ) : null}
          </div>

          {error ? (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter className="create-trip-footer">
            {step > 1 ? (
              <Button type="button" variant="outline" disabled={submitting} onClick={() => {
                setError("");
                setStep((current) => current === 3 ? 2 : 1);
              }}>
                <ArrowLeft />
                {t.createTrip.previous}
              </Button>
            ) : null}
            {step < 3 ? (
              <Button type="button" disabled={step === 1 ? !tripStepValid : !routeStepValid} onClick={() => {
                setError("");
                setStep((current) => current === 1 ? 2 : 3);
              }}>
                {t.createTrip.next}
                <ArrowRight />
              </Button>
            ) : (
              <Button
                type="button"
                disabled={submitting
                  || !flightComplete(outbound, selectedStartDate, selectedEndDate)
                  || !flightComplete(returnFlight, selectedStartDate, selectedEndDate)}
                onClick={() => void submit()}
              >
                {submitting ? t.createTrip.creating : t.createTrip.createTrip}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
