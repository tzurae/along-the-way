import type { ProviderPlaceCandidateDto } from "@along-the-way/contracts/trip-places";

import {
  ProviderQuotaError,
  ProviderUnavailableError,
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
 * Place Details lookups per research run (Enterprise, for rating and status): one per picked
 * place in the traveler's language, plus, while it lasts, one in the local language for a name
 * that did not match. Twice the research cap, so every picked place gets its first lookup.
 */
export const MAX_GOOGLE_LOOKUPS = 40;

export interface VerifiedCandidate {
  researched: ResearchedCandidate;
  place: ProviderPlaceCandidateDto | null;
  wikivoyagePage: WikivoyagePage | null;
  officialPage: string | null;
}

export interface VerificationResult {
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
 * Looks every picked place up on Google by the Place ID discovery returned, checks which
 * independent sources really vouch for it, and applies the deterministic quality gate.
 */
export async function verifyResearchedCandidates(input: {
  candidates: readonly ResearchedCandidate[];
  request: DiscoveryRequest;
  outputLanguage: string;
  placeLookup: RatedPlaceLookup;
  sourceChecks: RecommendationSourceChecks;
  rejectedProviderPlaceIds: ReadonlySet<string>;
  wishlistProviderPlaceIds: ReadonlySet<string>;
  suggestedProviderPlaceIds: ReadonlySet<string>;
  tripCountryCodes: ReadonlySet<string>;
}): Promise<VerificationResult> {
  let lookups = 0;
  let unavailable = 0;
  const details = async (providerPlaceId: string, languageCode: string) => {
    // Reserved before awaiting, so concurrent lookups can never exceed the budget.
    if (lookups >= MAX_GOOGLE_LOOKUPS) return null;
    lookups += 1;
    try {
      return await input.placeLookup.details(providerPlaceId, { languageCode });
    } catch (error) {
      if (error instanceof ProviderQuotaError) throw error;
      if (!(error instanceof ProviderUnavailableError)) throw error;
      unavailable += 1;
      return null;
    }
  };
  const sameLanguage = baseLanguage(input.request.localLanguage) === baseLanguage(input.outputLanguage);
  // 1. Every picked place: its Google details, and a check that the Place ID is the place the
  // model wrote about. The summary cites places by position, so the model can pick the ID of a
  // neighbouring result; its sentences and sources would then describe another place.
  const matches = await mapLimit(input.candidates, OUTBOUND_CONCURRENCY, async (candidate) => {
    const first = await details(candidate.providerPlaceId, input.outputLanguage);
    if (!first) return { match: null, returned: false };
    if (placeNameMatch(names(candidate), first.candidate.name)) return { match: first, returned: true };
    // Google may answer in the local script ("千とせ") where the model wrote another; the card
    // keeps the traveler-language answer.
    if (!sameLanguage) {
      const local = await details(candidate.providerPlaceId, input.request.localLanguage);
      if (local && placeNameMatch(names(candidate), local.candidate.name)) return { match: first, returned: true };
    }
    return { match: null, returned: true };
  });
  const matchByIndex = new Map(matches.map((entry, index) => [index, entry]));
  // 2. Independent sources, only for places Google returned details for.
  const wikivoyage = input.sourceChecks.wikivoyage();
  const editions = languages(input.outputLanguage, input.request.localLanguage);
  const results = await mapLimit(input.candidates.map((candidate, index) => ({ candidate, index })), OUTBOUND_CONCURRENCY, async ({ candidate, index }) => {
    const candidateNames = names(candidate);
    const { match, returned } = matchByIndex.get(index) ?? { match: null, returned: false };
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
          businessStatus: match.businessStatus,
          countryCode: match.countryCode,
          located: place.latitude !== null && place.longitude !== null,
        },
        wikivoyage: wikivoyagePage !== null,
        officialTourism: officialPage !== null,
      } satisfies GateCandidate,
    };
  });
  if (lookups > 0 && unavailable === lookups) throw new ProviderUnavailableError();
  return {
    candidates: results.map((result) => result.verified),
    gate: gateRecommendations({
      candidates: results.map((result) => result.gate),
      namedPlaces: input.request.namedPlaces.map((place) => place.name),
      categories: input.request.categories,
      rejectedProviderPlaceIds: input.rejectedProviderPlaceIds,
      wishlistProviderPlaceIds: input.wishlistProviderPlaceIds,
      suggestedProviderPlaceIds: input.suggestedProviderPlaceIds,
      tripCountryCodes: input.tripCountryCodes,
    }),
  };
}
