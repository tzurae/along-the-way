import { describe, expect, it } from "vitest";
import { parseRapidApiKeysResponse } from "../src/rapidapi-keys";

describe("RapidAPI key response contract", () => {
  it("reads an empty or ordered masked list without retaining extra fields", () => {
    expect(parseRapidApiKeysResponse({ keys: [] })).toEqual({ keys: [] });
    expect(parseRapidApiKeysResponse({ keys: [{ position: 1, last4: "ab12", key: "syntheticRapidApiKey000001" }] }))
      .toEqual({ keys: [{ position: 1, last4: "ab12" }] });
  });

  it.each([null, {}, { keys: null }, { keys: [null] }, { keys: [{ position: 0, last4: "abcd" }] },
    { keys: [{ position: 2, last4: "abcd" }] }, { keys: [{ position: 1, last4: "syntheticRapidApiKey000001" }] },
    { keys: [{ position: 1, last4: "ab!d" }] },
    { keys: Array.from({ length: 11 }, (_, index) => ({ position: index + 1, last4: "abcd" })) },
  ])("rejects malformed masked lists", (value) => {
    expect(() => parseRapidApiKeysResponse(value)).toThrow("Invalid RapidAPI keys response");
  });
});
