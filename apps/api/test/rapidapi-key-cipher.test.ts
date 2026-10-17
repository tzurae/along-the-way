import { describe, expect, it } from "vitest";
import { RapidApiKeyCipher } from "../src/private-trips/rapidapi-key-cipher";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");
const alice = "00000000-0000-4000-8000-000000000001";
const bob = "00000000-0000-4000-8000-000000000002";
const keys = ["syntheticRapidApiKey000001", "syntheticRapidApiKey000002"];

describe("per-user RapidAPI credential encryption", () => {
  it("round-trips the ordered keys with a fresh nonce on each write", () => {
    const cipher = new RapidApiKeyCipher(encryptionKey);
    const first = cipher.encrypt(alice, keys);
    const second = cipher.encrypt(alice, keys);
    expect(first.nonce).toHaveLength(12);
    expect(first.encryption_key_version).toBe(1);
    expect(first.nonce).not.toEqual(second.nonce);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
    expect(first.ciphertext).toHaveLength(Buffer.byteLength(keys.join(",")) + 16);
    expect(cipher.decrypt(alice, first)).toEqual(keys);
    expect(cipher.decrypt(alice, second)).toEqual(keys);
  });

  it("refuses a ciphertext copied to another user's row", () => {
    const cipher = new RapidApiKeyCipher(encryptionKey);
    expect(() => cipher.decrypt(bob, cipher.encrypt(alice, keys))).toThrow("Credentials could not be decrypted");
  });

  it.each(["ciphertext", "tag"])("refuses a tampered %s without exposing keys", (part) => {
    const cipher = new RapidApiKeyCipher(encryptionKey);
    const encrypted = cipher.encrypt(alice, keys);
    const offset = part === "tag" ? encrypted.ciphertext.length - 1 : 0;
    encrypted.ciphertext[offset] = encrypted.ciphertext[offset]! ^ 1;
    expect(() => cipher.decrypt(alice, encrypted)).toThrow("Credentials could not be decrypted");
  });

  it("refuses an unknown encryption version", () => {
    const cipher = new RapidApiKeyCipher(encryptionKey);
    expect(() => cipher.decrypt(alice, { ...cipher.encrypt(alice, keys), encryption_key_version: 2 }))
      .toThrow("Credentials could not be decrypted");
  });

  it.each(["", "not-base64", Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64"), `${encryptionKey}!`])
    ("rejects an invalid startup key", (value) => {
      expect(() => new RapidApiKeyCipher(value)).toThrow("CREDENTIALS_ENCRYPTION_KEY must be base64 of exactly 32 bytes");
    });
});
