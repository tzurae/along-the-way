import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import {
  PLACE_KEEP_NOTE_MAX,
  parsePlaceKeepListResponse,
  parsePlaceKeepResponse,
  type PlaceKeepDto,
  type PlaceKeepListResponse,
  type PlaceKeepResponse,
} from "@along-the-way/contracts/place-keeps";
import {
  parseTripPlaceResponse,
  type CreateTripPlaceInput,
  type TripPlaceDto,
  type TripPlaceResponse,
} from "@along-the-way/contracts/trip-places";

import { ApiRequestError } from "./api-error";
import { notify } from "./AppToaster";
import { useI18n } from "./i18n";
import type { PlaceDetailRequest } from "./PlaceThumbnail";
import "./pocket-discovery.css";
import "./place-keeps.css";

/** Rows shown before 「看全部」 on the 地點 page. */
const COLLAPSED_ROWS = 3;

/**
 * 下次還要來 for one trip place: pressed while the current user keeps its canonical place.
 * Once kept, an optional one-line reason can be saved; a second press removes the keep.
 */
export function PlaceKeepToggle({ tripId, tripPlaceId, placeIdentityId, request, onChanged }: {
  tripId: string;
  tripPlaceId: string;
  /** `trip_places.place_id`; keeps belong to the canonical place, not to this trip's row. */
  placeIdentityId: string;
  request: PlaceDetailRequest;
  onChanged?(): void;
}) {
  const { t: { placeKeeps: t } } = useI18n();
  // null until the current state has been read.
  const [saved, setSaved] = useState<{ kept: boolean; note: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const noteId = useId();
  const keepPath = `/api/trips/${encodeURIComponent(tripId)}/trip-places/${encodeURIComponent(tripPlaceId)}/keep`;

  useEffect(() => {
    const controller = new AbortController();
    setSaved(null);
    setError("");
    void request<PlaceKeepListResponse>(`/api/trips/${encodeURIComponent(tripId)}/place-keeps`, {
      signal: controller.signal,
      parse: parsePlaceKeepListResponse,
    }).then(({ keeps }) => {
      if (controller.signal.aborted) return;
      const own = keeps.find((keep) => keep.own && keep.placeIdentityId === placeIdentityId);
      setSaved({ kept: Boolean(own), note: own?.note ?? "" });
      setDraft(own?.note ?? "");
    }).catch(() => {
      if (!controller.signal.aborted) setError(t.loadFailed);
    });
    return () => controller.abort();
  }, [placeIdentityId, request, t.loadFailed, tripId]);

  // Mark and re-note are an upsert and unmark is a delete, so a fresh key per attempt cannot duplicate.
  async function writeKeep(note: string | null) {
    const { keep } = await request<PlaceKeepResponse>(keepPath, {
      method: "PUT",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ note }),
      parse: parsePlaceKeepResponse,
    });
    setSaved({ kept: true, note: keep.note ?? "" });
    setDraft(keep.note ?? "");
  }

  async function toggle() {
    if (!saved || busy) return;
    setBusy(true);
    setError("");
    try {
      if (saved.kept) {
        await request<null>(keepPath, { method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() } });
        setSaved({ kept: false, note: "" });
        setDraft("");
      } else {
        await writeKeep(null);
      }
      onChanged?.();
    } catch {
      setError(t.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  async function saveNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!saved?.kept || busy || draft.trim() === saved.note) return;
    setBusy(true);
    setError("");
    try {
      await writeKeep(draft.trim() || null);
      notify("success", t.noteSaved);
      onChanged?.();
    } catch {
      setError(t.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pd-detail-section place-keep">
      <button
        type="button"
        className="pd-secondary place-keep__toggle"
        aria-pressed={saved?.kept ?? false}
        aria-busy={busy || saved === null || undefined}
        disabled={saved === null || busy}
        onClick={() => void toggle()}
      >
        {t.toggle}
      </button>
      {saved && !saved.kept ? <p className="place-keep__help">{t.toggleHelp}</p> : null}
      {saved?.kept ? (
        <form className="place-keep__note" onSubmit={(event) => void saveNote(event)}>
          <label htmlFor={noteId}>{t.noteLabel}</label>
          <div className="place-keep__note-row">
            <input
              id={noteId}
              type="text"
              value={draft}
              maxLength={PLACE_KEEP_NOTE_MAX}
              placeholder={t.notePlaceholder}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
            {draft.trim() !== saved.note ? (
              <button type="submit" className="pd-secondary" disabled={busy}>{busy ? t.savingNote : t.saveNote}</button>
            ) : null}
          </div>
        </form>
      ) : null}
      {error ? <p role="alert" className="place-keep__error">{error}</p> : null}
    </section>
  );
}

/**
 * 家人說下次還要來 on the 地點 page: keeps by the viewer and everyone who currently shares a trip
 * with them. Hidden when there are none (or they cannot be read); each row can add its place to
 * this trip's 口袋名單 through the ordinary add-place API.
 */
export function FellowPlaceKeeps({ tripId, request, reloadKey, onAdded }: {
  tripId: string;
  request: PlaceDetailRequest;
  /** Changes whenever keeps or this trip's places may have changed. */
  reloadKey: string;
  onAdded(tripPlace: TripPlaceDto): Promise<void>;
}) {
  const { t: { placeKeeps: t, tripPlaces: placesText } } = useI18n();
  const headingId = useId();
  const [keeps, setKeeps] = useState<PlaceKeepDto[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  // One Idempotency-Key per keep until its add succeeds, so a retry after a lost response replays it.
  const addKeys = useRef(new Map<string, string>());

  useEffect(() => {
    const controller = new AbortController();
    void request<PlaceKeepListResponse>(`/api/trips/${encodeURIComponent(tripId)}/place-keeps`, {
      signal: controller.signal,
      parse: parsePlaceKeepListResponse,
    }).then(({ keeps: next }) => {
      if (!controller.signal.aborted) setKeeps(next);
    }).catch(() => {
      // A secondary list: on a failed read it stays hidden rather than pushing an error above 口袋名單.
      if (!controller.signal.aborted) setKeeps([]);
    });
    return () => controller.abort();
  }, [reloadKey, request, tripId]);

  async function add(keep: PlaceKeepDto) {
    if (addingId !== null) return;
    setAddingId(keep.id);
    const payload: CreateTripPlaceInput = keep.provider === "google" && keep.providerPlaceId
      ? { method: "search", providerPlaceId: keep.providerPlaceId, sourceUrl: null, originalNote: null }
      : {
          method: "manual",
          name: keep.name,
          type: keep.type,
          address: keep.address,
          latitude: keep.latitude,
          longitude: keep.longitude,
          timeZone: keep.timeZone,
          sourceUrl: null,
          originalNote: null,
        };
    const key = addKeys.current.get(keep.id) ?? crypto.randomUUID();
    addKeys.current.set(keep.id, key);
    let added: TripPlaceDto | null = null;
    try {
      added = (await request<TripPlaceResponse>(`/api/trips/${encodeURIComponent(tripId)}/trip-places`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: JSON.stringify(payload),
        parse: parseTripPlaceResponse,
      })).tripPlace;
    } catch (error) {
      setAddingId(null);
      if (!(error instanceof ApiRequestError && error.code === "already_in_wishlist")) {
        notify("error", error instanceof ApiRequestError ? error.message : placesText.errors.requestFailed);
        return;
      }
      notify("error", placesText.errors.alreadyInWishlist);
    }
    // Added now or already active in this trip: either way this key is spent and the place is here.
    addKeys.current.delete(keep.id);
    setKeeps((current) => current.map((entry) => entry.placeIdentityId === keep.placeIdentityId ? { ...entry, alreadyInTrip: true } : entry));
    if (!added) return;
    setAddingId(null);
    notify("success", t.added(keep.name));
    await onAdded(added);
  }

  if (keeps.length === 0) return null;
  // Places not yet in this trip first; each group keeps the API's newest-first order.
  const ordered = [...keeps.filter((keep) => !keep.alreadyInTrip), ...keeps.filter((keep) => keep.alreadyInTrip)];
  const visible = expanded ? ordered : ordered.slice(0, COLLAPSED_ROWS);
  return (
    <section className="place-keeps" aria-labelledby={headingId}>
      <h3 id={headingId} className="place-keeps__title">{t.sectionTitle}</h3>
      <ul className="place-keeps__list" aria-label={t.listLabel}>
        {visible.map((keep) => {
          const who = keep.own ? t.me : keep.keeperDisplayName ?? t.someone;
          const trip = keep.fromTrip ? t.tripLabel(keep.fromTrip.name, keep.fromTrip.startDate) : null;
          return (
            <li key={keep.id} className="place-keeps__row">
              <div className="place-keeps__copy">
                <strong>{keep.name}</strong>
                <span className="place-keeps__byline">{t.byline(who, trip)}</span>
                {keep.note ? <span className="place-keeps__note">{keep.note}</span> : null}
              </div>
              {keep.alreadyInTrip ? (
                <span className="pd-state">{t.alreadyHere}</span>
              ) : (
                <button
                  type="button"
                  className="pd-secondary"
                  disabled={addingId !== null}
                  aria-busy={addingId === keep.id || undefined}
                  aria-label={`${t.addToPocket}：${keep.name}`}
                  onClick={() => void add(keep)}
                >
                  {addingId === keep.id ? t.adding : t.addToPocket}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {ordered.length > COLLAPSED_ROWS ? (
        <button type="button" className="place-keeps__more" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
          {expanded ? t.showLess : t.showAll(ordered.length)}
        </button>
      ) : null}
    </section>
  );
}
