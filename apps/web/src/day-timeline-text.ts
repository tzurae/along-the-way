import type { DayTimelineRow, DayTimelineStopLabel } from "@along-the-way/contracts/day-timeline";

/** f5 §4: the only place the day dialog says the times are estimates. */
export const TIMELINE_INTRO = "早餐 10:30 前、午餐 11:30–13:00、晚餐 17:30–19:00 入座。時間都是估計。";
export const NO_WINDOW_TEXT = "這天固定行程之外，沒有可安排的時間。";

const MEAL_NAMES = { breakfast: "早餐", lunch: "午餐", dinner: "晚餐" } as const;
const MEAL_MINIMUM = { lunch: 60, dinner: 75 } as const;

/** 「09:30」; 「隔天 00:30」 past midnight, 「前一天 23:00」 before it. */
export function timelineClock(minute: number) {
  const days = Math.floor(minute / 1440);
  const inDay = minute - days * 1440;
  const clock = `${String(Math.floor(inDay / 60)).padStart(2, "0")}:${String(inDay % 60).padStart(2, "0")}`;
  return days === 0 ? clock : days === 1 ? `隔天 ${clock}` : days === -1 ? `前一天 ${clock}` : `${days} 天後 ${clock}`;
}

/** f5 §1.3: 「N 分」 under an hour, 「H 小時」, 「H 小時 M 分」; rounded to 5 minutes, at least 5. */
export function approxDuration(minutes: number) {
  const rounded = Math.max(5, Math.round(minutes / 5) * 5);
  if (rounded < 60) return `${rounded} 分`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${hours} 小時` : `${hours} 小時 ${rest} 分`;
}

const late = (minutes: number) => minutes > 0 ? `，晚了約 ${approxDuration(minutes)}` : "";

/** f5 §4 row labels. 1b: an editable dialog row shows 「也是餐廳」 with ［當晚餐］［移到備案］ instead of the full sentence. */
export function stopLabelText(label: DayTimelineStopLabel) {
  switch (label.kind) {
    case "breakfast_candidate": return "可當早餐";
    case "meal": return label.tooEarly ? `${MEAL_NAMES[label.meal]}・太早`
      : `${MEAL_NAMES[label.meal]}${label.marked ? "" : "・系統判斷"}${late(label.lateMinutes)}`;
    case "lunch_exists": return "午餐已經有了，這家也是餐廳";
    case "off_meal_time": return "不在午餐、晚餐時間";
  }
}

export const MEAL_ROLE_NAMES = { ...MEAL_NAMES, none: "不算一餐" } as const;

/** A wait under 30 minutes folds into the row it precedes; under 5 is not worth a note. */
export function earlyText(minutes: number, seat: boolean) {
  if (minutes < 5) return null;
  return `提早約 ${approxDuration(minutes)}到${seat ? "，等入座" : ""}`;
}

export function mealFloorText(meal: "lunch" | "dinner") {
  return `吃飯至少抓 ${MEAL_MINIMUM[meal]} 分`;
}

export function anchorLabelText(row: Extract<DayTimelineRow, { kind: "anchor" }>) {
  if (row.lateMinutes > 0) return `（固定）趕不上，約晚 ${approxDuration(row.lateMinutes)}`;
  return row.meal ? `（固定）${MEAL_NAMES[row.meal]}` : "（固定）";
}

export function mealGapText(row: Extract<DayTimelineRow, { kind: "meal_gap" }>, nearName: string) {
  return `${MEAL_NAMES[row.meal]}・還沒選地方（${nearName}附近）${late(row.lateMinutes)}`;
}

export function freeTimeText(minutes: number) {
  return `自由時間約 ${approxDuration(minutes)}`;
}

export function longLegText(fromName: string, toName: string) {
  return `${fromName} → ${toName} 這段很遠，系統只能用直線距離粗估，時間不準，所以這天先不排三餐。`;
}

function departureText(departureMinute: number | null, arriveByMinute: number | null) {
  if (departureMinute === null) return "";
  return arriveByMinute === null
    ? `${timelineClock(departureMinute)} 起飛。`
    : `${timelineClock(departureMinute)} 起飛，${timelineClock(arriveByMinute)} 前要到機場。`;
}

export function tailText(row: Extract<DayTimelineRow, { kind: "tail_unknown" }>, fromName: string, toName: string) {
  return `${fromName} → ${toName}：要多久系統算不準，請自己抓時間。${departureText(row.departureMinute, row.arriveByMinute)}`;
}

export function endText(row: Extract<DayTimelineRow, { kind: "end" }>, toName: string | null) {
  const at = row.minute === null ? "" : `約 ${timelineClock(row.minute)} `;
  if (row.terminal === "lodging") return row.minute === null ? "回到住宿（時間無法估計）" : `${at}回到住宿`;
  if (row.terminal === "anchor") {
    const arrival = row.minute === null ? `到${toName ?? "下一段行程"}（時間無法估計）` : `${at}到${toName ?? "下一段行程"}`;
    const departure = departureText(row.departureMinute, row.arriveByMinute);
    return departure ? `${arrival}。${departure}` : arrival;
  }
  return row.minute === null ? "結束最後一站" : `${at}結束最後一站`;
}

/**
 * One plain line per row, for read-only lists (whole-trip drafts); null: the row has no line. A leg
 * with a distance but no minutes (the long leg and everything after it, f5 §1.4) shows no minutes,
 * the same rule as the day dialog: the long leg is only its sentence, later legs are omitted.
 */
export function timelineRowText(row: DayTimelineRow, nameOf: (id: string) => string): string | null {
  const at = (minute: number | null) => minute === null ? "" : `${timelineClock(minute)} `;
  switch (row.kind) {
    case "breakfast_before": return "早餐・出門前";
    case "start": return row.pointId === null ? "出發地點不明" : `${at(row.minute)}從${nameOf(row.pointId)}出發`;
    case "anchor": return `${at(row.minute)}${nameOf(row.anchorId)}　${anchorLabelText(row)}${row.earlyMinutes > 0 ? `　${earlyText(row.earlyMinutes, false) ?? ""}` : ""}`;
    case "leg": return row.long ? longLegText(nameOf(row.fromId), nameOf(row.toId))
      : row.minutes !== null ? `↓ 約 ${row.minutes} 分` : row.metres === null ? "↓ 無法估計" : null;
    case "free": return `${at(row.minute)}${freeTimeText(row.minutes)}`;
    case "stop": {
      const notes = [row.label ? stopLabelText(row.label) : null, earlyText(row.earlyMinutes, true)].filter(Boolean);
      return `${at(row.minute)}${nameOf(row.stopId)}${notes.length > 0 ? `　${notes.join("・")}` : ""}`;
    }
    case "meal_gap": return `${at(row.minute)}${mealGapText(row, nameOf(row.nearId))}`;
    case "end": return endText(row, row.toId === null ? null : nameOf(row.toId));
    case "tail_unknown": return tailText(row, nameOf(row.fromId), nameOf(row.toId));
  }
}
