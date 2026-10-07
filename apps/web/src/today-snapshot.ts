import type { TodayModel } from "./today-model";

export const TODAY_SCHEMA_VERSION = 2;
const PREFIX = "along-the-way:today:";
const ACCOUNT_KEY = "along-the-way:today-account";
const SIGNED_OUT_KEY = "along-the-way:locally-signed-out";
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

/** Validate the whole persisted boundary; reject extra fields as well as incompatible/corrupt data. */
function validSnapshot(value: unknown): value is TodaySnapshot {
  if (!record(value, "schemaVersion accountId fetchedAt model") || value.schemaVersion !== TODAY_SCHEMA_VERSION || !text(value.accountId) || !instant(value.fetchedAt)) return false;
  const model = value.model;
  if (!record(model, "tripId tripName tripVersion memberId days items") || !text(model.tripId) || !text(model.tripName) || !text(model.memberId) || !Number.isSafeInteger(model.tripVersion)) return false;
  if (!list(model.days, (day) => record(day, "id date timeZone itemIds wishlist") && text(day.id) && text(day.date) && /^\d{4}-\d{2}-\d{2}$/.test(day.date) && Number.isFinite(Date.parse(day.date)) && new Date(day.date).toISOString().slice(0, 10) === day.date && zone(day.timeZone) && list(day.itemIds, text)
    && list(day.wishlist, (place) => record(place, "id name") && text(place.id) && text(place.name)))) return false;
  return list(model.items, (item) => record(item, "id title type start end endpoints participants locked constraints facts notes sourceUrl")
    && text(item.id) && text(item.title) && text(item.type) && ["flight", "lodging", "transport", "reservation", "meal", "activity", "free-time"].includes(item.type)
    && (item.start === null || instant(item.start)) && (item.end === null || instant(item.end)) && typeof item.locked === "boolean" && nullableText(item.notes) && nullableText(item.sourceUrl)
    && (item.participants === null || list(item.participants, (person) => record(person, "id name") && text(person.id) && text(person.name)))
    && list(item.endpoints, (endpoint) => record(endpoint, "role instant timeZone place") && ["start", "end"].includes(String(endpoint.role)) && instant(endpoint.instant) && text(endpoint.timeZone) && zone(endpoint.timeZone)
      && (endpoint.place === null || (record(endpoint.place, "name address latitude longitude") && text(endpoint.place.name) && nullableText(endpoint.place.address) && coordinate(endpoint.place.latitude, 90) && coordinate(endpoint.place.longitude, 180))))
    && list(item.constraints, (constraint) => record(constraint, "type status minutes") && ["fixed_time", "immovable", "minimum_buffer"].includes(String(constraint.type)) && ["confirmed", "unknown", "conflicted"].includes(String(constraint.status)) && (constraint.minutes === null || (typeof constraint.minutes === "number" && Number.isFinite(constraint.minutes) && constraint.minutes >= 0)))
    && list(item.facts, (fact) => record(fact, "kind value") && ["carrier", "serviceNumber", "confirmationNotes", "bookedBy", "confirmationCode", "mode", "ticketInfo", "durationMinutes", "confirmationStatus"].includes(String(fact.kind)) && text(fact.value)));
}

export class TodaySnapshotStore {
  constructor(private readonly storage: Storage) {}

  save(accountId: string, model: TodayModel, now = Date.now()): TodaySnapshot | null {
    const snapshot: TodaySnapshot = { schemaVersion: TODAY_SCHEMA_VERSION, accountId, fetchedAt: new Date(now).toISOString(), model };
    if (!validSnapshot(snapshot)) return null;
    try {
      this.storage.setItem(`${PREFIX}${accountId}:${model.tripId}`, JSON.stringify(snapshot));
      this.storage.setItem(ACCOUNT_KEY, accountId);
      return snapshot;
    } catch { return null; }
  }

  read(accountId: string, tripId: string): TodaySnapshot | null {
    const key = `${PREFIX}${accountId}:${tripId}`;
    try {
      const raw = this.storage.getItem(key);
      if (!raw) return null;
      const value: unknown = JSON.parse(raw);
      if (validSnapshot(value) && value.accountId === accountId && value.model.tripId === tripId) return value;
      this.storage.removeItem(key);
    } catch { try { this.storage.removeItem(key); } catch { /* Storage can be disabled. */ } }
    return null;
  }

  lastAccount(): string | null {
    try { return this.storage.getItem(ACCOUNT_KEY); } catch { return null; }
  }
  isLocallySignedOut() {
    try { return this.storage.getItem(SIGNED_OUT_KEY) === "true"; } catch { return false; }
  }

  setLocallySignedOut(signedOut: boolean) {
    try {
      if (signedOut) this.storage.setItem(SIGNED_OUT_KEY, "true");
      else this.storage.removeItem(SIGNED_OUT_KEY);
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
      for (const key of keys) if (key?.startsWith(`${PREFIX}${accountId}:`)) this.storage.removeItem(key);
      if (this.storage.getItem(ACCOUNT_KEY) === accountId) this.storage.removeItem(ACCOUNT_KEY);
    } catch { /* Storage can be disabled. */ }
  }
}
