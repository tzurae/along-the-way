import {
  parseTripPlaceListResponse,
  type TripPlaceListResponse,
} from "@along-the-way/contracts/trip-places";

interface RequestOptions extends RequestInit {
  parse?: (value: unknown) => unknown;
}

type ScheduleRequest = <T>(url: string, options?: RequestOptions) => Promise<T>;
type RetryKeys = Map<string, { fingerprint: string; key: string }>;

const retryStores = new WeakMap<ScheduleRequest, RetryKeys>();

function retryStore(request: ScheduleRequest) {
  const existing = retryStores.get(request);
  if (existing) return existing;
  const created: RetryKeys = new Map();
  retryStores.set(request, created);
  return created;
}

function retryKey(store: RetryKeys, operation: string, payload: unknown) {
  const fingerprint = JSON.stringify(payload);
  const existing = store.get(operation);
  if (existing?.fingerprint === fingerprint) return existing.key;
  const key = crypto.randomUUID();
  store.set(operation, { fingerprint, key });
  return key;
}

function clearRetryKey(store: RetryKeys, operation: string) {
  store.delete(operation);
}
interface PartialAssignmentError extends Error {
  partial?: string[];
}

function assignmentError(reason: unknown, partial: string[]) {
  const error: PartialAssignmentError = reason instanceof Error
    ? reason
    : new Error("無法完成排入行程。");
  if (partial.length > 0) error.partial = [...partial];
  return error;
}


export async function assignPlacesToDay(args: {
  request: ScheduleRequest;
  tripId: string;
  dayId: string | null;
  items: Array<{ tripPlaceId: string; version: number; currentDayId: string | null }>;
}): Promise<TripPlaceListResponse> {
  const store = retryStore(args.request);
  const itemKey = args.items.map((item) => item.tripPlaceId).sort().join(",");

  async function put(
    operation: string,
    assignments: Array<{ tripPlaceId: string; tripDayId: string | null; expectedVersion: number }>,
  ) {
    const payload = { assignments };
    const response = await args.request<TripPlaceListResponse>(
      `/api/trips/${args.tripId}/trip-place-day-assignments`,
      {
        method: "PUT",
        headers: { "Idempotency-Key": retryKey(store, operation, payload) },
        body: JSON.stringify(payload),
        parse: parseTripPlaceListResponse,
      },
    );
    clearRetryKey(store, operation);
    return response;
  }

  const partial: string[] = [];
  try {
    if (args.dayId === null) {
      return await put(
        `schedule:${args.tripId}:${itemKey}:remove`,
        args.items.map((item) => ({
          tripPlaceId: item.tripPlaceId,
          tripDayId: null,
          expectedVersion: item.version,
        })),
      );
    }

    const versions = new Map(args.items.map((item) => [item.tripPlaceId, item.version]));
    const removals = args.items.filter(
      (item) => item.currentDayId !== null && item.currentDayId !== args.dayId,
    );

    if (removals.length > 0) {
      const response = await put(
        `schedule:${args.tripId}:${itemKey}:remove-before-assign`,
        removals.map((item) => ({
          tripPlaceId: item.tripPlaceId,
          tripDayId: null,
          expectedVersion: item.version,
        })),
      );
      partial.push(...removals.map((item) => item.tripPlaceId));
      const returnedById = new Map(response.tripPlaces.map((place) => [place.id, place]));
      for (const item of removals) {
        const updated = returnedById.get(item.tripPlaceId);
        if (!updated) throw new Error(`無法完成排入行程：回傳資料缺少地點 ${item.tripPlaceId}`);
        versions.set(item.tripPlaceId, updated.version);
      }
    }

    return await put(
      `schedule:${args.tripId}:${itemKey}:assign:${args.dayId}`,
      args.items.map((item) => ({
        tripPlaceId: item.tripPlaceId,
        tripDayId: args.dayId,
        expectedVersion: versions.get(item.tripPlaceId) ?? item.version,
      })),
    );
  } catch (reason) {
    throw assignmentError(reason, partial);
  }
}
