import { countryOptions } from "@along-the-way/contracts/countries";

const countryNames = new Map(
  countryOptions("zh-Hant").map((country) => [
    country.code,
    `${country.flag} ${country.localizedName} (${country.code})`,
  ]),
);

export function countryStopLabel(countryCode: string) {
  return countryNames.get(countryCode) ?? countryCode;
}
