import type { ConflictChange } from "@along-the-way/contracts/private-trips";

import type { Messages } from "./i18n";

export function localizedApiErrorMessage(
  messages: Messages["errors"],
  code: string,
  _serverDetail: string,
  correlationId?: string,
  currentVersion?: number,
) {
  const knownCode = code as keyof typeof messages.byCode;
  const message = Object.prototype.hasOwnProperty.call(messages.byCode, knownCode)
    ? messages.byCode[knownCode]
    : messages.unknown;
  return [
    message,
    currentVersion === undefined ? "" : messages.currentVersion(currentVersion),
    correlationId ? messages.reference(correlationId) : "",
  ].filter(Boolean).join(" ");
}

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
