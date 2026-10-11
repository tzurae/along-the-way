import type { ConflictChange } from "@along-the-way/contracts/private-trips";

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly correlationId?: string,
    readonly currentVersion?: number,
    readonly latestChange?: ConflictChange | null,
    readonly status?: number,
  ) { super(message); }
}
