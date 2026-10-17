import type { TodayModel } from "./today-model";

export const TODAY_SCHEMA_VERSION = 5;
const PREFIX = "along-the-way:today:";
const ACCOUNT_KEY = "along-the-way:today-account";
const PLACE_FILTER_PREFIX = "along-the-way:place-filters:";
const ONBOARDING_PREFIX = "along-the-way:trip-onboarding:";
export const TODAY_SIGNED_OUT_STORAGE_KEY = "along-the-way:locally-signed-out";
export const PENDING_SERVER_LOGOUT_STORAGE_KEY = "along-the-way:pending-server-logout";
const DAY_MS = 24 * 60 * 60 * 1_000;
export interface TodaySnapshot {
  schemaVersion: typeof TODAY_SCHEMA_VERSION;
  accountId: string;
  fetchedAt: string;
  model: TodayModel;
}

function record(value: unknown, keys: string): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const expected = keys.split(" ");
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
function text(value: unknown): value is string { return typeof value === "string"; }
function nullableText(value: unknown) { return value === null || text(value); }
function instant(value: unknown) { return text(value) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)); }
function list(value: unknown, valid: (entry: unknown) => boolean) { return Array.isArray(value) && value.every(valid); }
function zone(value: unknown) {
  if (value === null) return true;
  if (!text(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}
function coordinate(value: unknown, limit: number) { return value === null || (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit); }

/**
 * Upgrade compatible schema-2/3/4 snapshots, then validate the complete
 * account-scoped result. Missing references, participant status, and legacy
 * wishlist coordinates remain unknown; never infer them from another snapshot.
 */
function migrateLegacySnapshot(value: unknown): unknown {
  if (!record(value, "schemaVersion accountId fetchedAt model") || (value.schemaVersion !== 2 && value.schemaVersion !== 3 && value.schemaVersion !== 4)) return value;
  const legacyVersion = value.schemaVersion;
  const model = value.model;
  if (!record(model, "tripId tripName tripVersion memberId days items") || !Array.isArray(model.days) || !Array.isArray(model.items)) return value;
  const days = [];
  for (const day of model.days) {
    if (!record(day, "id date timeZone itemIds wishlist") || !Array.isArray(day.wishlist)) return value;
    const wishlist = [];
    for (const place of day.wishlist) {
      if (!record(place, "id name")) return value;
      wishlist.push({ ...place, latitude: null, longitude: null, providerPlaceId: null });
    }
    days.push({ ...day, wishlist });
  }
  if (legacyVersion === 4) {
    return { ...value, schemaVersion: TODAY_SCHEMA_VERSION, model: { ...model, days } };
  }
  const items = [];
  for (const item of model.items) {
    if (!record(item, "id title type start end endpoints participants locked constraints facts notes sourceUrl") || !Array.isArray(item.endpoints)) return value;
    const endpoints = [];
    for (const endpoint of item.endpoints) {
      if (!record(endpoint, "role instant timeZone place")) return value;
      const place = endpoint.place;
      const placeKeys = legacyVersion === 2 ? "name address latitude longitude" : "id name address latitude longitude";
      if (place !== null && !record(place, placeKeys)) return value;
      endpoints.push({
        ...endpoint,
        place: place === null ? null : legacyVersion === 2 ? { ...place, id: null } : place,
      });
    }
    if (item.participants !== null && !Array.isArray(item.participants)) return value;
    const participants = item.participants === null
      ? null
      : item.participants.map((person) => {
        if (!record(person, "id name")) return null;
        return { ...person, removed: null };
      });
    if (participants?.some((person) => person === null)) return value;
    items.push({ ...item, endpoints, participants });
  }
  return { ...value, schemaVersion: TODAY_SCHEMA_VERSION, model: { ...model, days, items } };
}

/** Validate the whole persisted boundary; reject extra fields as well as incompatible/corrupt data. */
function validSnapshot(value: unknown): value is TodaySnapshot {
  if (!record(value, "schemaVersion accountId fetchedAt model") || value.schemaVersion !== TODAY_SCHEMA_VERSION || !text(value.accountId) || !instant(value.fetchedAt)) return false;
  const model = value.model;
  if (!record(model, "tripId tripName tripVersion memberId days items") || !text(model.tripId) || !text(model.tripName) || !text(model.memberId) || !Number.isSafeInteger(model.tripVersion)) return false;
  if (!list(model.days, (day) => record(day, "id date timeZone itemIds wishlist") && text(day.id) && text(day.date) && /^\d{4}-\d{2}-\d{2}$/.test(day.date) && Number.isFinite(Date.parse(day.date)) && new Date(day.date).toISOString().slice(0, 10) === day.date && zone(day.timeZone) && list(day.itemIds, text)
    && list(day.wishlist, (place) => record(place, "id name latitude longitude providerPlaceId") && text(place.id) && text(place.name) && coordinate(place.latitude, 90) && coordinate(place.longitude, 180) && nullableText(place.providerPlaceId)))) return false;
  return list(model.items, (item) => record(item, "id title type start end endpoints participants locked constraints facts notes sourceUrl")
    && text(item.id) && text(item.title) && text(item.type) && ["flight", "lodging", "transport", "reservation", "meal", "activity", "free-time"].includes(item.type)
    && (item.start === null || instant(item.start)) && (item.end === null || instant(item.end)) && typeof item.locked === "boolean" && nullableText(item.notes) && nullableText(item.sourceUrl)
    && (item.participants === null || list(item.participants, (person) => record(person, "id name removed") && text(person.id) && text(person.name) && (person.removed === null || typeof person.removed === "boolean")))
    && list(item.endpoints, (endpoint) => record(endpoint, "role instant timeZone place") && ["start", "end"].includes(String(endpoint.role)) && instant(endpoint.instant) && text(endpoint.timeZone) && zone(endpoint.timeZone)
      && (endpoint.place === null || (record(endpoint.place, "id name address latitude longitude") && nullableText(endpoint.place.id) && text(endpoint.place.name) && nullableText(endpoint.place.address) && coordinate(endpoint.place.latitude, 90) && coordinate(endpoint.place.longitude, 180))))
    && list(item.constraints, (constraint) => record(constraint, "type status minutes") && ["fixed_time", "immovable", "minimum_buffer"].includes(String(constraint.type)) && ["confirmed", "unknown", "conflicted"].includes(String(constraint.status)) && (constraint.minutes === null || (typeof constraint.minutes === "number" && Number.isFinite(constraint.minutes) && constraint.minutes >= 0)))
    && list(item.facts, (fact) => record(fact, "kind value") && ["carrier", "serviceNumber", "confirmationNotes", "bookedBy", "confirmationCode", "mode", "ticketInfo", "durationMinutes", "confirmationStatus"].includes(String(fact.kind)) && text(fact.value)));
}

function expired(snapshot: TodaySnapshot, now: number) {
  const fetchedExpiry = Date.parse(snapshot.fetchedAt) + 14 * DAY_MS;
  const endDate = snapshot.model.days.reduce<string | null>(
    (latest, day) => latest === null || day.date > latest ? day.date : latest,
    null,
  );
  // The date-only trip contract has no trip-wide zone. Retain the complete seventh
  // UTC calendar day after the final trip date, then discard at the next midnight.
  const tripExpiry = endDate === null
    ? Number.POSITIVE_INFINITY
    : Date.parse(`${endDate}T00:00:00Z`) + 8 * DAY_MS;
  return now > fetchedExpiry || now >= tripExpiry;
}

export class TodaySnapshotStore {
  constructor(private readonly storage: Storage) {}

  save(accountId: string, model: TodayModel, now = Date.now()): TodaySnapshot | null {
    const snapshot: TodaySnapshot = { schemaVersion: TODAY_SCHEMA_VERSION, accountId, fetchedAt: new Date(now).toISOString(), model };
    if (!validSnapshot(snapshot)) return null;
    let previousAccount: string | null;
    try {
      previousAccount = this.storage.getItem(ACCOUNT_KEY);
      this.storage.setItem(ACCOUNT_KEY, accountId);
      try {
        this.storage.setItem(`${PREFIX}${accountId}:${model.tripId}`, JSON.stringify(snapshot));
      } catch (error) {
        try {
          if (previousAccount === null) this.storage.removeItem(ACCOUNT_KEY);
          else this.storage.setItem(ACCOUNT_KEY, previousAccount);
        } catch { /* Best effort: the snapshot write itself remained atomic. */ }
        throw error;
      }
      return snapshot;
    } catch { return null; }
  }

  read(accountId: string, tripId: string, now = Date.now()): TodaySnapshot | null {
    const key = `${PREFIX}${accountId}:${tripId}`;
    try {
      const raw = this.storage.getItem(key);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      const value = migrateLegacySnapshot(parsed);
      if (validSnapshot(value) && value.accountId === accountId && value.model.tripId === tripId) {
        if (expired(value, now)) {
          this.storage.removeItem(key);
          return null;
        }
        if (value !== parsed) {
          try { this.storage.setItem(key, JSON.stringify(value)); }
          catch { /* A failed upgrade write must not discard the readable legacy snapshot. */ }
        }
        return value;
      }
      this.storage.removeItem(key);
    } catch { try { this.storage.removeItem(key); } catch { /* Storage can be disabled. */ } }
    return null;
  }

  lastAccount(): string | null {
    try { return this.storage.getItem(ACCOUNT_KEY); } catch { return null; }
  }
  isLocallySignedOut() {
    try { return this.storage.getItem(TODAY_SIGNED_OUT_STORAGE_KEY) === "true"; } catch { return false; }
  }

  setLocallySignedOut(signedOut: boolean) {
    try {
      if (signedOut) this.storage.setItem(TODAY_SIGNED_OUT_STORAGE_KEY, "true");
      else this.storage.removeItem(TODAY_SIGNED_OUT_STORAGE_KEY);
    } catch { /* Storage can be disabled. */ }
  }

  pendingServerLogoutUserId() {
    try {
      const userId = this.storage.getItem(PENDING_SERVER_LOGOUT_STORAGE_KEY);
      return userId || null;
    } catch { return null; }
  }

  setServerLogoutPending(userId: string | null) {
    try {
      if (userId) this.storage.setItem(PENDING_SERVER_LOGOUT_STORAGE_KEY, userId);
      else this.storage.removeItem(PENDING_SERVER_LOGOUT_STORAGE_KEY);
    } catch { /* Storage can be disabled. */ }
  }


  forAccount(accountId: string): TodaySnapshot[] {
    const snapshots: TodaySnapshot[] = [];
    try {
      const keys = Array.from({ length: this.storage.length }, (_, index) => this.storage.key(index));
      for (const key of keys) {
        if (!key?.startsWith(`${PREFIX}${accountId}:`)) continue;
        const snapshot = this.read(accountId, key.slice(`${PREFIX}${accountId}:`.length));
        if (snapshot) snapshots.push(snapshot);
      }
    } catch { return []; }
    return snapshots.sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  }

  clearTrip(accountId: string, tripId: string) {
    try { this.storage.removeItem(`${PREFIX}${accountId}:${tripId}`); } catch { /* Storage can be disabled. */ }
  }

  clearAccount(accountId: string) {
    try {
      const keys = Array.from({ length: this.storage.length }, (_, index) => this.storage.key(index));
      for (const key of keys) {
        if (!key) continue;
        const legacyFilterParts = key.startsWith(PLACE_FILTER_PREFIX)
          ? key.slice(PLACE_FILTER_PREFIX.length).split(":")
          : [];
        if (
          key.startsWith(`${PREFIX}${accountId}:`)
          || key.startsWith(`${PLACE_FILTER_PREFIX}${accountId}:`)
          || key.startsWith(`${ONBOARDING_PREFIX}${accountId}:`)
          || legacyFilterParts.length === 2
        ) this.storage.removeItem(key);
      }
      if (this.storage.getItem(ACCOUNT_KEY) === accountId) this.storage.removeItem(ACCOUNT_KEY);
    } catch { /* Storage can be disabled. */ }
  }
}
