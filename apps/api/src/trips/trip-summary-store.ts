import type { TripSummaryDto } from "@along-the-way/contracts/trip-summary";

export type TripSummary = TripSummaryDto;

export interface TripSummaryStore {
  isReady(): Promise<boolean>;
  findBySlug(slug: string): Promise<TripSummary | undefined>;
}
