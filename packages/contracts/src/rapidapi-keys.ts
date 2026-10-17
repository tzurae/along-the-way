import { isRecord } from "./type-guards";

export interface RapidApiKeysResponse {
  keys: Array<{ position: number; last4: string }>;
}

export function parseRapidApiKeysResponse(value: unknown): RapidApiKeysResponse {
  if (!isRecord(value) || !Array.isArray(value.keys) || value.keys.length > 10) {
    throw new Error("Invalid RapidAPI keys response");
  }
  return {
    keys: value.keys.map((key, index) => {
      if (!isRecord(key) || key.position !== index + 1 || typeof key.last4 !== "string"
        || !/^[A-Za-z0-9]{4}$/.test(key.last4)) {
        throw new Error("Invalid RapidAPI keys response");
      }
      return { position: index + 1, last4: key.last4 };
    }),
  };
}
