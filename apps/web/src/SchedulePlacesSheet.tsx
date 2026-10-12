import { useEffect, useMemo, useState } from "react";

import type { TripDto } from "@along-the-way/contracts/private-trips";

import { useI18n } from "./i18n";
import { PlaceDetailSheet } from "./PlaceDetailSheet";
import "./schedule-flow.css";

const shortDateFormatter = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "UTC",
  month: "numeric",
  day: "numeric",
});

const weekdayFormatter = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "UTC",
  weekday: "short",
});

function dayCopy(date: string) {
  const instant = new Date(`${date}T12:00:00Z`);
  const shortDate = shortDateFormatter.format(instant);
  const weekday = weekdayFormatter.format(instant);
  return { shortDate, weekday, label: `${shortDate}（${weekday}）` };
}

export function SchedulePlacesSheet(props: {
  open: boolean;
  trip: TripDto;
  places: Array<{ id: string; name: string }>;
  initialDayId?: string | null;
  allowUnscheduled?: boolean;
  busy: boolean;
  error?: string;
  onConfirm(dayId: string | null): void | Promise<void>;
  onClose(): void;
}) {
  const { t } = useI18n();
  const [selectedDayId, setSelectedDayId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (props.open) setSelectedDayId(props.initialDayId ?? undefined);
  }, [props.open, props.initialDayId]);

  const days = useMemo(() => props.trip.days.map((day) => ({
    ...day,
    copy: dayCopy(day.date),
  })), [props.trip.days]);
  const selectedDay = selectedDayId == null
    ? null
    : days.find((day) => day.id === selectedDayId) ?? null;
  const description = props.places.length === 1
    ? props.places[0]?.name ?? ""
    : t.schedule.selectedCount(props.places.length);
  const canConfirm = props.trip.role === "owner" && (selectedDayId === null
    ? Boolean(props.allowUnscheduled)
    : Boolean(selectedDay));


  let actionLabel = t.schedule.chooseDateFirst;
  if (selectedDayId === null) {
    actionLabel = t.schedule.confirmUnscheduled(props.places[0]?.name ?? "");
  } else if (selectedDay) {
    actionLabel = props.places.length === 1
      ? t.schedule.confirmSingle(props.places[0]?.name ?? "", selectedDay.copy.label)
      : t.schedule.confirmMany(props.places.length, selectedDay.copy.label);
  }

  if (props.trip.role !== "owner") return null;

  return (
    <PlaceDetailSheet
      open={props.open}
      title={t.schedule.title}
      description={description}
      onClose={props.onClose}
      appearance="workspace"
      footer={(
        <div className="schedule-sheet__footer">
          {props.error ? <p className="schedule-sheet__error" role="alert">{props.error}</p> : null}
          <button
            type="button"
            className="schedule-primary-button schedule-sheet__submit"
            disabled={!canConfirm || props.busy}
            onClick={() => {
              if (canConfirm && selectedDayId !== undefined) void props.onConfirm(selectedDayId);
            }}
          >
            {props.busy ? t.schedule.saving : actionLabel}
          </button>
        </div>
      )}
    >
      {props.places.length > 1 ? (
        <ul className="schedule-sheet__places" aria-label={description}>
          {props.places.map((place) => <li key={place.id}>{place.name}</li>)}
        </ul>
      ) : null}
      <section className="schedule-sheet__section">
        <h3>{t.schedule.chooseDate}</h3>
        <div className="schedule-day-picker" aria-label={t.schedule.pickerLabel}>
          {props.allowUnscheduled ? (
            <button
              type="button"
              className="schedule-day-picker__day schedule-day-picker__day--unscheduled"
              aria-pressed={selectedDayId === null}
              disabled={props.busy}
              onClick={() => setSelectedDayId(null)}
            >
              <span>{t.schedule.unscheduled}</span>
              <small>{t.schedule.unscheduledHint}</small>
            </button>
          ) : null}
          {days.map((day) => (
            <button
              key={day.id}
              type="button"
              className="schedule-day-picker__day"
              aria-pressed={selectedDayId === day.id}
              disabled={props.busy}
              onClick={() => setSelectedDayId(day.id)}
            >
              <span>{day.copy.shortDate}</span>
              <small>{day.copy.weekday}</small>
            </button>
          ))}
        </div>
      </section>
    </PlaceDetailSheet>
  );
}
