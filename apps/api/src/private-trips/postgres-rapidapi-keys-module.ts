import { AsyncLocalStorage } from "node:async_hooks";
import type { Kysely } from "kysely";
import type { RapidApiKeysResponse } from "@along-the-way/contracts/rapidapi-keys";
import type { AlongTheWayDatabase } from "../database/database";
import { AppError } from "./private-trip-module";
import { RapidApiKeyCipher } from "./rapidapi-key-cipher";

function response(keys: readonly string[]): RapidApiKeysResponse {
  return { keys: keys.map((key, index) => ({ position: index + 1, last4: key.slice(-4) })) };
}

export class PostgresRapidApiKeysModule {
  private readonly request = new AsyncLocalStorage<{ userId: string; keys?: Promise<string[]> }>();

  constructor(
    private readonly database: Kysely<AlongTheWayDatabase>,
    private readonly cipher: RapidApiKeyCipher,
  ) {}

  private async keysFor(userId: string, database = this.database) {
    const row = await database.selectFrom("user_rapidapi_keys").selectAll()
      .where("user_id", "=", userId).executeTakeFirst();
    if (!row) return [];
    try {
      return this.cipher.decrypt(userId, row);
    } catch {
      console.info(JSON.stringify({ event: "rapidapi_keys_unreadable", userId }));
      return [];
    }
  }

  async list(userId: string) {
    return response(await this.keysFor(userId));
  }

  async add(userId: string, key: string) {
    if (!/^[A-Za-z0-9]{20,100}$/.test(key)) {
      throw new AppError("validation_error", "Key must contain 20 to 100 letters or digits");
    }
    return this.database.transaction().execute(async (transaction) => {
      // Lock the parent so first inserts and edits serialize even when no key row exists.
      await transaction.selectFrom("users").select("id").where("id", "=", userId).forUpdate().executeTakeFirstOrThrow();
      const keys = await this.keysFor(userId, transaction);
      if (keys.includes(key)) throw new AppError("validation_error", "Key is already saved");
      if (keys.length >= 10) throw new AppError("validation_error", "At most 10 keys may be saved");
      keys.push(key);
      const encrypted = this.cipher.encrypt(userId, keys);
      await transaction.insertInto("user_rapidapi_keys").values({ user_id: userId, ...encrypted })
        .onConflict((conflict) => conflict.column("user_id").doUpdateSet({ ...encrypted, updated_at: new Date() })).execute();
      return response(keys);
    });
  }

  async remove(userId: string, position: number) {
    return this.database.transaction().execute(async (transaction) => {
      await transaction.selectFrom("users").select("id").where("id", "=", userId).forUpdate().executeTakeFirstOrThrow();
      const keys = await this.keysFor(userId, transaction);
      if (!Number.isSafeInteger(position) || position < 1 || position > keys.length) {
        throw new AppError("rapidapi_key_not_found", "Key not found", 404);
      }
      keys.splice(position - 1, 1);
      if (keys.length === 0) {
        await transaction.deleteFrom("user_rapidapi_keys").where("user_id", "=", userId).execute();
      } else {
        await transaction.updateTable("user_rapidapi_keys")
          .set({ ...this.cipher.encrypt(userId, keys), updated_at: new Date() }).where("user_id", "=", userId).execute();
      }
      return response(keys);
    });
  }

  withUser<T>(userId: string, work: () => Promise<T>) {
    return this.request.run({ userId }, work);
  }

  keysForRequest(): Promise<string[]> {
    const request = this.request.getStore();
    if (!request) return Promise.resolve([]);
    // Share only within this request, including concurrent route fan-out.
    return request.keys ??= this.keysFor(request.userId);
  }
}
