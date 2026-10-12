import type { TripAirportInput } from "@along-the-way/contracts/private-trips";

export type AirportRecord = readonly [
  iata: string,
  name: string,
  city: string,
  country: string,
  latitude: number,
  longitude: number,
  timeZone: string,
];

interface SearchableAirport {
  airport: AirportRecord;
  name: string;
  city: string;
  all: string;
}

let airportPromise: Promise<readonly AirportRecord[]> | undefined;
let searchIndex: readonly SearchableAirport[] | undefined;

function normalized(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en").trim();
}

export async function loadAirportData() {
  airportPromise ??= import("./airport-data.generated").then((module) => module.default);
  const airports = await airportPromise;
  searchIndex ??= airports.map((airport) => {
    const name = normalized(airport[1]);
    const city = normalized(airport[2]);
    return { airport, name, city, all: `${normalized(airport[0])} ${name} ${city}` };
  });
  return airports;
}

export function searchAirports(
  airports: readonly AirportRecord[],
  query: string,
  maximum = 20,
) {
  const input = normalized(query);
  if (!input || maximum <= 0) return [];
  const terms = input.split(/\s+/).filter(Boolean);
  const indexed = searchIndex?.length === airports.length
    ? searchIndex
    : airports.map((airport) => {
        const name = normalized(airport[1]);
        const city = normalized(airport[2]);
        return { airport, name, city, all: `${normalized(airport[0])} ${name} ${city}` };
      });
  const matches: Array<{ airport: AirportRecord; score: number }> = [];
  for (const candidate of indexed) {
    if (!terms.every((term) => candidate.all.includes(term))) continue;
    const code = normalized(candidate.airport[0]);
    const score = code === input ? 0
      : code.startsWith(input) ? 1
        : candidate.city.startsWith(input) ? 2
          : candidate.name.startsWith(input) ? 3
            : 4;
    const insertion = matches.findIndex((match) => score < match.score
      || (score === match.score && candidate.airport[0] < match.airport[0]));
    matches.splice(insertion < 0 ? matches.length : insertion, 0, { airport: candidate.airport, score });
    if (matches.length > maximum) matches.pop();
  }
  return matches.map((match) => match.airport);
}

export function airportLabel(airport: AirportRecord) {
  const location = [airport[2], airport[3]].filter(Boolean).join(" · ");
  return `${airport[0]} · ${airport[1]}${location ? ` — ${location}` : ""}`;
}

export function airportInput(airport: AirportRecord): TripAirportInput {
  const name = `${airport[0]} · ${airport[1]}`;
  return {
    name: name.length <= 200 ? name : name.slice(0, 200).trimEnd(),
    timeZone: airport[6],
    latitude: airport[4],
    longitude: airport[5],
  };
}

export function sameAirport(left: TripAirportInput, right: TripAirportInput) {
  return left.name === right.name
    && left.timeZone === right.timeZone
    && left.latitude === right.latitude
    && left.longitude === right.longitude;
}
