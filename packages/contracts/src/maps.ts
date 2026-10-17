import { isRecord } from "./type-guards";

export interface MapsConfigResponse {
  browserKey: string | null;
  mapId: string | null;
}

export function parseMapsConfigResponse(value: unknown): MapsConfigResponse {
  if (!isRecord(value)) throw new Error("Invalid maps config response");
  const { browserKey, mapId } = value;
  if (
    (browserKey !== null && typeof browserKey !== "string")
    || (mapId !== null && typeof mapId !== "string")
  ) {
    throw new Error("Invalid maps config response");
  }
  return { browserKey, mapId };
}
