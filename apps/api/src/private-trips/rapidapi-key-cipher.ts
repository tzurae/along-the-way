import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

interface EncryptedKeys {
  ciphertext: Buffer;
  nonce: Buffer;
  encryption_key_version: number;
}

export class RapidApiKeyCipher {
  private readonly key: Buffer;

  constructor(encodedKey: string) {
    this.key = Buffer.from(encodedKey, "base64");
    if (this.key.byteLength !== 32 || this.key.toString("base64") !== encodedKey) {
      throw new Error("CREDENTIALS_ENCRYPTION_KEY must be base64 of exactly 32 bytes");
    }
  }

  encrypt(userId: string, keys: readonly string[]): EncryptedKeys {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`user_rapidapi_keys:v1:${userId}`));
    // ciphertext = encrypted UTF-8 comma-joined keys, followed by the 16-byte GCM tag.
    const ciphertext = Buffer.concat([cipher.update(keys.join(","), "utf8"), cipher.final(), cipher.getAuthTag()]);
    return { ciphertext, nonce, encryption_key_version: 1 };
  }

  decrypt(userId: string, encrypted: EncryptedKeys): string[] {
    try {
      if (encrypted.encryption_key_version !== 1 || encrypted.nonce.length !== 12 || encrypted.ciphertext.length < 16) {
        throw new Error();
      }
      const decipher = createDecipheriv("aes-256-gcm", this.key, encrypted.nonce);
      decipher.setAAD(Buffer.from(`user_rapidapi_keys:v1:${userId}`));
      decipher.setAuthTag(encrypted.ciphertext.subarray(-16));
      const plaintext = Buffer.concat([decipher.update(encrypted.ciphertext.subarray(0, -16)), decipher.final()]);
      try {
        return plaintext.toString("utf8").split(",");
      } finally {
        plaintext.fill(0);
      }
    } catch {
      throw new Error("Credentials could not be decrypted");
    }
  }
}
