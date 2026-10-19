import { useId, useRef, useState } from "react";
import {
  MAX_TRIP_DAY_NOTE_LENGTH,
  MAX_TRIP_DAY_TITLE_LENGTH,
  parseTripDayDetailsResponse,
  type TimelineDayDto,
  type TripDayDetailsResponse,
} from "@along-the-way/contracts/trip-skeleton";
import { NotebookPen } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ApiRequestError } from "./api-error";
import { useI18n } from "./i18n";

type JsonRequest = <T>(url: string, options?: RequestInit & { parse?: (value: unknown) => unknown }) => Promise<T>;

/** Cuts by characters (not UTF-16 units), matching the server's and Postgres' length rule. */
function limitCharacters(value: string, maximum: number) {
  const characters = [...value];
  return characters.length > maximum ? characters.slice(0, maximum).join("") : value;
}

/** The day's 玩法 note, shown under its heading. */
export function DayNote({ note }: { note: string }) {
  const { t } = useI18n();
  return (
    <aside className="plan-day-note" aria-label={t.tripSkeleton.dayNoteLabel}>
      <NotebookPen aria-hidden="true" />
      <p>{note}</p>
    </aside>
  );
}

/**
 * Inline editor for a day's title and 玩法 note. Saves with the details version captured when it
 * opened, so a teammate's edit in between is reported instead of silently overwritten.
 */
export function DayDetailsEditor({
  tripId,
  day,
  dayLabel,
  request,
  onSaved,
  onConflict,
  onCancel,
}: {
  tripId: string;
  day: TimelineDayDto;
  dayLabel: string;
  request: JsonRequest;
  onSaved(): Promise<void> | void;
  /** Re-reads the itinerary, so the teammate's version shows once this editor closes. */
  onConflict(): void;
  onCancel(): void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [expectedVersion, setExpectedVersion] = useState(day.detailsVersion);
  const [title, setTitle] = useState(day.title ?? "");
  const [note, setNote] = useState(day.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // The same content reuses its key, so resending after a dropped response replays instead of
  // tripping its own version check; changed content gets a fresh key.
  const attempt = useRef({ key: "", body: "" });

  async function save() {
    const body = JSON.stringify({
      expectedVersion,
      title: title.trim() ? title : null,
      note: note.trim() ? note : null,
    });
    if (attempt.current.body !== body) attempt.current = { key: crypto.randomUUID(), body };
    setSaving(true);
    setError("");
    try {
      await request<TripDayDetailsResponse>(`/api/trips/${tripId}/days/${day.id}/details`, {
        method: "PUT",
        headers: { "Idempotency-Key": attempt.current.key },
        body,
        parse: parseTripDayDetailsResponse,
      });
      await onSaved();
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.code === "conflict" && reason.currentVersion !== undefined) {
        // Keep what this person typed; saving again is now a deliberate overwrite of the newer version.
        setExpectedVersion(reason.currentVersion);
        setError(t.tripSkeleton.dayDetailsConflict);
        onConflict();
      } else {
        setError(reason instanceof ApiRequestError && (reason.code === "forbidden" || reason.status === 403)
          ? t.schedule.ownerOnlyAction
          : reason instanceof Error ? reason.message : t.tripSkeleton.dayDetailsSaveError);
      }
      setSaving(false);
    }
  }

  return (
    <form
      className="plan-day-details-form"
      aria-label={t.tripSkeleton.editDayDetailsFor(dayLabel)}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !saving) onCancel();
      }}
    >
      <label htmlFor={`${id}-title`}>
        <span>{t.tripSkeleton.dayTitleField}</span>
        <Input
          id={`${id}-title`}
          value={title}
          autoFocus
          placeholder={t.tripSkeleton.dayTitlePlaceholder}
          disabled={saving}
          onChange={(event) => setTitle(limitCharacters(event.target.value, MAX_TRIP_DAY_TITLE_LENGTH))}
        />
      </label>
      <label htmlFor={`${id}-note`}>
        <span>{t.tripSkeleton.dayNoteField}</span>
        <Textarea
          id={`${id}-note`}
          rows={4}
          value={note}
          placeholder={t.tripSkeleton.dayNotePlaceholder}
          disabled={saving}
          onChange={(event) => setNote(limitCharacters(event.target.value, MAX_TRIP_DAY_NOTE_LENGTH))}
        />
      </label>
      {error ? <p className="plan-day-details-error" role="alert">{error}</p> : null}
      <div className="plan-day-details-actions">
        <button type="button" className="plan-outline-button" disabled={saving} onClick={onCancel}>
          {t.tripSkeleton.cancelDayDetails}
        </button>
        <button type="submit" className="plan-schedule-button" disabled={saving}>
          {saving ? t.tripSkeleton.savingDayDetails : t.tripSkeleton.saveDayDetails}
        </button>
      </div>
    </form>
  );
}
