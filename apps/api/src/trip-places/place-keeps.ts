import { PLACE_KEEP_NOTE_MAX, type PlaceKeepDto } from "@along-the-way/contracts/place-keeps";

import { AppError } from "../private-trips/private-trip-module";
import { dateOnly, isoTimestamp, type DatabaseExecutor } from "../private-trips/postgres-private-trip-store";

/** Trims the optional 下次還要來 reason; a blank reason is stored as null. */
export function placeKeepNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new AppError("validation_error", "note must be a string or null");
  const note = value.trim();
  // Code points, matching PostgreSQL char_length in the table check.
  if ([...note].length > PLACE_KEEP_NOTE_MAX) {
    throw new AppError("validation_error", `note must be at most ${PLACE_KEEP_NOTE_MAX} characters`);
  }
  return note || null;
}

/**
 * Keeps the viewer may see, as seen from `tripId`: their own, plus those of every user who currently
 * shares at least one active trip membership with them. Never anyone else's.
 */
export async function readPlaceKeeps(
  executor: DatabaseExecutor,
  viewerId: string,
  tripId: string,
  keepId?: string,
): Promise<PlaceKeepDto[]> {
  let query = executor.selectFrom("place_keeps as keep")
    .innerJoin("place_identities as place", "place.id", "keep.place_identity_id")
    .innerJoin("users as keeper", "keeper.id", "keep.user_id")
    .leftJoin("trips as fromTrip", "fromTrip.id", "keep.from_trip_id")
    .select((eb) => [
      "keep.id", "keep.user_id", "keep.place_identity_id", "keep.note", "keep.created_at",
      "place.provider", "place.provider_place_id", "place.canonical_name", "place.canonical_type",
      "place.canonical_address", "place.latitude", "place.longitude", "place.time_zone",
      "keeper.display_name",
      "fromTrip.name as from_trip_name", "fromTrip.start_date as from_trip_start_date",
      // The source trip is named only while the viewer is still one of its members.
      eb.exists(eb.selectFrom("trip_members as viewerMembership").select("viewerMembership.id")
        .whereRef("viewerMembership.trip_id", "=", "keep.from_trip_id")
        .where("viewerMembership.user_id", "=", viewerId)
        .where("viewerMembership.removed_at", "is", null)).as("from_trip_visible"),
      eb.exists(eb.selectFrom("trip_places as current").select("current.id")
        .where("current.trip_id", "=", tripId)
        .whereRef("current.place_id", "=", "keep.place_identity_id")
        .where("current.archived_at", "is", null)).as("already_in_trip"),
    ])
    .where((eb) => eb.or([
      eb("keep.user_id", "=", viewerId),
      eb.exists(eb.selectFrom("trip_members as mine")
        .innerJoin("trip_members as theirs", "theirs.trip_id", "mine.trip_id")
        .select("mine.id")
        .where("mine.user_id", "=", viewerId)
        .where("mine.removed_at", "is", null)
        .whereRef("theirs.user_id", "=", "keep.user_id")
        .where("theirs.removed_at", "is", null)),
    ]))
    .orderBy("keep.created_at", "desc")
    .orderBy("keep.id");
  if (keepId) query = query.where("keep.id", "=", keepId);
  const rows = await query.execute();
  return rows.map((row) => ({
    id: row.id,
    placeIdentityId: row.place_identity_id,
    provider: row.provider,
    providerPlaceId: row.provider_place_id,
    name: row.canonical_name,
    type: row.canonical_type,
    address: row.canonical_address,
    latitude: row.latitude,
    longitude: row.longitude,
    timeZone: row.time_zone,
    note: row.note,
    keeperDisplayName: row.display_name,
    own: row.user_id === viewerId,
    fromTrip: row.from_trip_visible && row.from_trip_name !== null && row.from_trip_start_date !== null
      ? { name: row.from_trip_name, startDate: dateOnly(row.from_trip_start_date) }
      : null,
    createdAt: isoTimestamp(row.created_at),
    alreadyInTrip: Boolean(row.already_in_trip),
  }));
}
