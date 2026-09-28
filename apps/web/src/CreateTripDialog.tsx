import { useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";
import { format } from "date-fns";
import { CalendarIcon, ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface CreateTripDialogProps {
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

export function CreateTripDialog({ createTrip }: CreateTripDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>();
  const [countryStops, setCountryStops] = useState<DraftCountryStop[]>([]);
  const [countryQuery, setCountryQuery] = useState("");
  const [selectedCountry, setSelectedCountry] = useState<CountryOption | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const filteredCountries = useMemo(
    () => filterCountryOptions(availableCountries, countryQuery),
    [countryQuery],
  );

  function addCountry(country: CountryOption | null) {
    if (!country) return;
    setSelectedCountry(null);
    setCountryQuery("");
    if (countryStops.length >= MAX_TRIP_COUNTRY_STOPS) {
      setError(`A trip can have at most ${MAX_TRIP_COUNTRY_STOPS} country stops.`);
      return;
    }

    if (countryStops.at(-1)?.countryCode === country.code) {
      setError("The same country cannot appear in consecutive stops.");
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
      setError("That move would place identical countries next to each other.");
      return;
    }

    setCountryStops(candidate);
    setError("");
  }

  function removeCountry(index: number) {
    const candidate = countryStops.filter((_, itemIndex) => itemIndex !== index);
    if (hasAdjacentDuplicate(candidate.map((stop) => stop.countryCode))) {
      setError("Removing that stop would place identical countries next to each other.");
      return;
    }
    setCountryStops(candidate);
    setError("");
  }

  function reset() {
    setName("");
    setDateRange(undefined);
    setCountryStops([]);
    setCountryQuery("");
    setSelectedCountry(null);
    setError("");
  }

  async function submit() {
    if (!dateRange?.from || !dateRange.to) {
      setError("Choose both the start and end dates.");
      return;
    }
    if (countryStops.length === 0) {
      setError("Add at least one country stop.");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      await createTrip({
        name,
        startDate: format(dateRange.from, "yyyy-MM-dd"),
        endDate: format(dateRange.to, "yyyy-MM-dd"),
        countryCodes: countryStops.map((stop) => stop.countryCode),
      });
      reset();
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the trip.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button className="min-h-10" />}>Create trip</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Create a trip</DialogTitle>
          <DialogDescription>
            Set the overall dates and an ordered country route. Time zones and a default currency are inferred only when the route is unambiguous.
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-5" onSubmit={(event) => event.preventDefault()}>
          <Field>
            <FieldLabel htmlFor="trip-name">Trip name</FieldLabel>
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
            <FieldLabel>Trip dates</FieldLabel>
            <Popover>
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
                    : `${format(dateRange.from, "yyyy/MM/dd")} – choose end date`
                  : "Choose a date range"}
              </PopoverTrigger>
              <PopoverContent className="w-auto max-w-[calc(100vw-2rem)] p-0" align="start">
                <Calendar
                  mode="range"
                  selected={dateRange}
                  onSelect={setDateRange}
                  defaultMonth={dateRange?.from}
                  numberOfMonths={1}
                />
              </PopoverContent>
            </Popover>
            <FieldDescription>Dates are stored as calendar dates, without a time zone conversion.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="country-route-search">Add a country</FieldLabel>
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
                placeholder="Search 中文, English, or ISO code"
                autoComplete="off"
                className="w-full"
              />
              <ComboboxContent>
                <ComboboxEmpty>No countries found.</ComboboxEmpty>
                <ComboboxList>
                  {(country: CountryOption) => (
                    <ComboboxItem
                      key={country.code}
                      value={country}
                      disabled={countryStops.at(-1)?.countryCode === country.code}
                    >
                      <span className="truncate">{countryLabel(country)}</span>
                      {countryStops.at(-1)?.countryCode === country.code ? (
                        <span className="ml-auto text-xs text-muted-foreground">Already last</span>
                      ) : null}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
            <FieldDescription>
              Up to {MAX_TRIP_COUNTRY_STOPS} stops. Repeated countries are allowed when another stop appears between them.
            </FieldDescription>
          </Field>

          <section aria-labelledby="country-route-heading" className="grid gap-3">
            <div className="flex items-center justify-between gap-3">
              <h3 id="country-route-heading" className="font-semibold">Country route</h3>
              <span className="text-sm text-muted-foreground">{countryStops.length} stops</span>
            </div>
            {countryStops.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                Add the first country to start the route.
              </p>
            ) : (
              <ol className="grid gap-2">
                {countryStops.map((stop, index) => {
                  const country = countriesByCode.get(stop.countryCode);
                  return (
                    <li
                      key={stop.id}
                      className="flex min-w-0 items-center gap-3 rounded-lg border bg-secondary px-3 py-2"
                    >
                      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {country ? countryLabel(country) : stop.countryCode}
                      </span>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Move stop ${index + 1} up`}
                          disabled={index === 0}
                          onClick={() => moveCountry(index, -1)}
                        >
                          <ChevronUp />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Move stop ${index + 1} down`}
                          disabled={index === countryStops.length - 1}
                          onClick={() => moveCountry(index, 1)}
                        >
                          <ChevronDown />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove stop ${index + 1}`}
                          onClick={() => removeCountry(index)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          {error ? (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" disabled={submitting} onClick={() => void submit()}>
              <Plus />
              {submitting ? "Creating…" : "Create trip"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
