import { countries, timezones } from "country-data-list";

import { isRecord } from "./type-guards";

export const MAX_TRIP_COUNTRY_STOPS = 32;

export interface CountryMetadata {
  code: string;
  currencies: readonly string[];
  englishName: string;
  flag: string;
  timeZones: readonly string[];
}

export interface CountryOption extends CountryMetadata {
  localizedName: string;
}

function metadataFrom(value: unknown): CountryMetadata | null {
  if (
    !isRecord(value) ||
    value.status !== "assigned" ||
    typeof value.alpha2 !== "string" ||
    !/^[A-Z]{2}$/.test(value.alpha2) ||
    typeof value.name !== "string" ||
    typeof value.emoji !== "string" ||
    !Array.isArray(value.currencies) ||
    value.currencies.some((currency) => typeof currency !== "string")
  ) {
    return null;
  }

  return {
    code: value.alpha2,
    currencies: value.currencies,
    englishName: value.name,
    flag: value.emoji,
    timeZones: timezones.getTimezonesByCountry(value.alpha2) ?? [],
  };
}

const metadata = Array.isArray(countries.all)
  ? countries.all.flatMap((country) => {
      const parsed = metadataFrom(country);
      return parsed ? [parsed] : [];
    })
  : [];

const byCode = new Map(metadata.map((country) => [country.code, country]));

export function countryMetadata(code: string) {
  return byCode.get(code.toUpperCase()) ?? null;
}

export function countryOptions(locale = "zh-Hant"): CountryOption[] {
  const displayNames = new Intl.DisplayNames([locale], { type: "region" });
  return metadata
    .map((country) => ({
      ...country,
      localizedName: displayNames.of(country.code) ?? country.englishName,
    }))
    .sort((left, right) =>
      left.localizedName.localeCompare(right.localizedName, locale),
    );
}

export function normalizeCountrySearch(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, "");
}

export function filterCountryOptions(
  options: readonly CountryOption[],
  query: string,
) {
  const normalized = normalizeCountrySearch(query);
  if (!normalized) return [...options];

  return options.filter((country) =>
    [country.code, country.englishName, country.localizedName].some((candidate) =>
      normalizeCountrySearch(candidate).includes(normalized),
    ),
  );
}

export function inferCountryRoute(countryCodes: readonly string[]) {
  const route = countryCodes.map((code) => countryMetadata(code));
  if (route.some((country) => country === null)) return null;

  const resolved = route as CountryMetadata[];
  const currencies = new Set(resolved.flatMap((country) => country.currencies));
  return {
    countries: resolved,
    defaultCurrency:
      currencies.size === 1 ? (currencies.values().next().value ?? null) : null,
  };
}
