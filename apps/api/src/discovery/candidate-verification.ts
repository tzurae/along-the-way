import type { ProviderPlaceCandidateDto } from "@along-the-way/contracts/trip-places";

import {
  ProviderUnavailableError,
  type RatedPlaceCandidate,
  type RatedPlaceLookup,
} from "../trip-places/google-places-provider";
import type { DiscoveryRequest, ResearchedCandidate } from "./discovery-model";
import {
  fetchPublicPageText,
  isOfficialTourismSource,
  pageMentions,
} from "./official-pages";
import { placeNameMatch } from "./place-names";
import { gateRecommendations, type GateCandidate, type GateResult } from "./recommendation-gate";
import { WikivoyageVerifier, type WikivoyagePage } from "./wikivoyage";

/** External checks, injectable so tests never reach Wikivoyage or arbitrary web pages. */
export interface RecommendationSourceChecks {
  /** A fresh checker per research run, so guide pages shared by many places load once. */
  wikivoyage(): { verify: WikivoyageVerifier["verify"] };
  /** Visible text of a public HTTPS page, or null when it cannot be fetched safely. */
  pageText(url: string): Promise<string | null>;
}

export const defaultRecommendationSourceChecks: RecommendationSourceChecks = {
  wikivoyage: () => new WikivoyageVerifier(),
  pageText: (url) => fetchPublicPageText(url),
};

const OUTBOUND_CONCURRENCY = 6;
/** Official pages fetched per place; the first that mentions it is enough. */
const MAX_OFFICIAL_PAGES = 3;
/**
 * Google lookups per research run (Text Search Enterprise, US$35 per 1,000 after the free tier):
 * at most about US$0.70. Every researched place gets its first lookup; second-language
 * retries use only what is left.
 */
export const MAX_GOOGLE_LOOKUPS = 20;

export interface VerifiedCandidate {
  researched: ResearchedCandidate;
  place: ProviderPlaceCandidateDto | null;
  wikivoyagePage: WikivoyagePage | null;
  officialPage: string | null;
}

export interface VerificationResult {
  /** Google lookups made, in order, for the persisted search plan. */
  queries: string[];
  candidates: VerifiedCandidate[];
  gate: GateResult;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]!);
    }
  }));
  return results;
}

/**
 * Names that identify the researched place. The traveler's own wording (namedPlace) is left
 * out: it is often a town or area ("伊根") that would match anything located there.
 */
function names(candidate: ResearchedCandidate) {
  return [candidate.name, candidate.localName, candidate.englishName]
    .filter((name): name is string => Boolean(name));
}

function baseLanguage(tag: string) {
  return tag.split("-")[0]!.toLowerCase();
}

function languages(outputLanguage: string, localLanguage: string) {
  return [...new Set([outputLanguage, localLanguage, "en"].map(baseLanguage))];
}

/**
 * Looks every researched place up on Google by a short "area name" query, checks which
 * independent sources really vouch for it, and applies the deterministic quality gate.
 */
export async function verifyResearchedCandidates(input: {
  candidates: readonly ResearchedCandidate[];
  request: DiscoveryRequest;
  outputLanguage: string;
  placeLookup: RatedPlaceLookup;
  sourceChecks: RecommendationSourceChecks;
  rejectedProviderPlaceIds: ReadonlySet<string>;
}): Promise<VerificationResult> {
  const queries: string[] = [];
  let lookups = 0;
  let unavailable = 0;
  const lookup = async (query: string, languageCode: string) => {
    // Reserved before awaiting, so concurrent lookups can never exceed the budget.
    if (lookups >= MAX_GOOGLE_LOOKUPS) return null;
    lookups += 1;
    // The same text may be asked in two languages; the plan lists each text once.
    if (!queries.includes(query)) queries.push(query);
    try {
      return await input.placeLookup.lookup(query, { languageCode });
    } catch (error) {
      if (!(error instanceof ProviderUnavailableError)) throw error;
      unavailable += 1;
      return null;
    }
  };
  const sameLanguage = baseLanguage(input.request.localLanguage) === baseLanguage(input.outputLanguage);
  // Traveler-named places first, so a tight budget is spent on what they asked for.
  const order = input.candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => Number(right.candidate.namedPlace !== null) - Number(left.candidate.namedPlace !== null));
  // An exact name anywhere in Google's answer beats a close one earlier in it; the order
  // Google returns is not stable, and a close match is the weaker identification.
  const best = (candidate: ResearchedCandidate, results: readonly RatedPlaceCandidate[] | null) => {
    if (!results) return null;
    const graded = results.map((entry) => ({ entry, match: placeNameMatch(names(candidate), entry.candidate.name) }));
    return (graded.find((item) => item.match === "exact") ?? graded.find((item) => item.match === "close"))?.entry ?? null;
  };

  // 1. Every place: its name in the traveler's language, answered in that language.
  const firsts = new Map<number, RatedPlaceCandidate[] | null>();
  await mapLimit(order, OUTBOUND_CONCURRENCY, async ({ candidate, index }) => {
    firsts.set(index, await lookup(`${candidate.area} ${candidate.name}`.trim(), input.outputLanguage));
  });
  // 2. Places still unmatched, while the budget lasts.
  const matches = await mapLimit(order, OUTBOUND_CONCURRENCY, async ({ candidate, index }) => {
    const first = firsts.get(index) ?? null;
    let returned = Boolean(first?.length);
    let match = best(candidate, first);
    // The local name, answered in the local language: Google's "廣藏市場" cannot be compared
    // with the researched "광장시장", but its Korean answer can. This also covers a model that
    // wrote the local name as the name. When the first lookup returned the same place, keep
    // that answer so the card shows the traveler's language.
    const localName = candidate.localName ?? candidate.name;
    if (!match && (localName !== candidate.name || !sameLanguage)) {
      const local = await lookup(`${candidate.area} ${localName}`.trim(), input.request.localLanguage);
      returned ||= Boolean(local?.length);
      const localMatch = best(candidate, local);
      const translated = localMatch
        ? first?.find((entry) => entry.candidate.providerPlaceId === localMatch.candidate.providerPlaceId)
        : undefined;
      match = localMatch && translated ? { ...localMatch, candidate: translated.candidate } : localMatch;
    }
    // The English name, answered in the traveler's language.
    if (!match && candidate.englishName && candidate.englishName !== candidate.name) {
      const english = await lookup(`${candidate.area} ${candidate.englishName}`.trim(), input.outputLanguage);
      returned ||= Boolean(english?.length);
      match = best(candidate, english);
    }
    return { index, match, returned };
  });
  const matchByIndex = new Map(matches.map((entry) => [entry.index, entry]));

  // 3. Independent sources, only for places Google confirmed.
  const wikivoyage = input.sourceChecks.wikivoyage();
  const editions = languages(input.outputLanguage, input.request.localLanguage);
  const results = await mapLimit(input.candidates.map((candidate, index) => ({ candidate, index })), OUTBOUND_CONCURRENCY, async ({ candidate, index }) => {
    const candidateNames = names(candidate);
    const { match, returned } = matchByIndex.get(index)!;
    if (!match) {
      return {
        verified: { researched: candidate, place: null, wikivoyagePage: null, officialPage: null },
        gate: {
          displayName: candidate.name,
          category: candidate.category,
          namedPlace: candidate.namedPlace,
          resolution: { status: returned ? "name_mismatch" : "not_found" },
          wikivoyage: false,
          officialTourism: false,
        } satisfies GateCandidate,
      };
    }
    const place = match.candidate;
    const officialUrls = candidate.sources
      .filter((source) => isOfficialTourismSource(source.url, source.type, match.websiteUri))
      .slice(0, MAX_OFFICIAL_PAGES)
      .map((source) => source.url);
    const [wikivoyagePage, officialPage] = await Promise.all([
      wikivoyage.verify({
        names: [...candidateNames, place.name],
        latitude: place.latitude,
        longitude: place.longitude,
        languages: editions,
      }),
      (async () => {
        for (const url of officialUrls) {
          const text = await input.sourceChecks.pageText(url);
          if (text && pageMentions(text, [...candidateNames, place.name])) return url;
        }
        return null;
      })(),
    ]);
    return {
      verified: { researched: candidate, place, wikivoyagePage, officialPage },
      gate: {
        displayName: candidate.name,
        category: candidate.category,
        namedPlace: candidate.namedPlace,
        resolution: {
          status: "resolved",
          providerPlaceId: place.providerPlaceId,
          rating: match.rating,
          userRatingCount: match.userRatingCount,
        },
        wikivoyage: wikivoyagePage !== null,
        officialTourism: officialPage !== null,
      } satisfies GateCandidate,
    };
  });
  if (lookups > 0 && unavailable === lookups) throw new ProviderUnavailableError();
  return {
    queries,
    candidates: results.map((result) => result.verified),
    gate: gateRecommendations({
      candidates: results.map((result) => result.gate),
      namedPlaces: input.request.namedPlaces.map((place) => place.name),
      categories: input.request.categories,
      rejectedProviderPlaceIds: input.rejectedProviderPlaceIds,
    }),
  };
}
