// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { DayTimetableDto, DayTimetableRowDto, TravelMode } from "@along-the-way/contracts/day-plans";
import { DayPlanDialog } from "../src/DayPlanDialog";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const names: Record<string, string> = { a: "清水寺", b: "八坂神社", c: "錦市場" };

/** A day drafted from a list: each place an hour, ten minutes apart; `dropped` cannot be placed. */
function draft(order: DayTimetableDto["order"], ids: string[], legModes: Record<string, TravelMode>, dropped: string[] = []): DayTimetableDto {
  let minute = 540;
  const rows: DayTimetableRowDto[] = [];
  for (const id of ids.filter((entry) => !dropped.includes(entry))) {
    const travel = rows.length === 0 ? null : {
      fromName: "", toName: names[id]!, mode: legModes[id] === "taxi" ? "taxi" as const : "walking" as const, durationMinutes: 10,
      walkingMinutes: 10, transitMinutes: null, estimated: false, attribution: "Test", unavailableReason: null,
    };
    if (travel) minute += 10;
    rows.push({
      kind: "visit", tripPlaceId: id, name: names[id]!, travel, arriveMinute: minute, waitMinutes: 0,
      startMinute: minute, endMinute: minute + 60, stayMinutes: 60, stayEstimated: true, hours: "manual",
    });
    minute += 60;
  }
  return {
    dayId: "day21", date: "2026-10-21", order,
    window: { startMinute: 540, endMinute: 1140, version: 4, travelMode: "transit", walkLimitMinutes: 15 },
    legModes, taxiAlternative: null, orderedTripPlaceIds: ids, startsAt: null, endsAt: null, rows,
    unscheduled: dropped.map((id) => ({ tripPlaceId: id, name: names[id]!, reason: "travel_unknown" as const })),
    load: { busyMinutes: 120, windowMinutes: 600, level: "relaxed" },
    capacity: { arrival: null, departure: null, gaps: [{ startMinute: 540, endMinute: 1140 }] },
  };
}

function renderDialog(saved: string[], answer: (body: { order: DayTimetableDto["order"]; orderedTripPlaceIds?: string[]; legModes?: Record<string, TravelMode> }) => DayTimetableDto) {
  const arrangements: unknown[] = [];
  const request = async <T,>(url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (url.endsWith("/arrangement")) {
      arrangements.push(body);
      return { tripPlaces: [] } as T;
    }
    return { timetable: body.order === "current" || body.order === "suggested" ? draft(body.order, saved, {}) : answer(body) } as T;
  };
  render(
    <DayPlanDialog
      tripId="A"
      day={{ id: "day21", date: "2026-10-21", label: "第 1 天" }}
      canArrange
      request={request}
      openRapidApiKeys={() => {}}
      onClose={() => {}}
      onOrderSaved={async () => {}}
      addablePlaces={[]}
      coordinates={new Map()}
      stays={new Map()}
    />,
  );
  return arrangements;
}

describe("the day dialog's candidate", () => {
  it("can save a change to only how one place is reached", async () => {
    const arrangements = renderDialog(["a", "b"], (body) => draft("custom", body.orderedTripPlaceIds!, body.legModes ?? {}));
    const save = await screen.findByRole("button", { name: "儲存為第 1 天的安排" });
    // Same places, same order as saved: nothing to save yet.
    await waitFor(() => expect(save).toBeDisabled());

    fireEvent.change(await screen.findByRole("combobox", { name: "怎麼到「八坂神社」" }), { target: { value: "taxi" } });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(arrangements).toEqual([{ orderedTripPlaceIds: ["a", "b"], expectedVersion: 4, legModes: { b: "taxi" } }]));
  });

  it("refuses to take a place out when that would push another placed one out", async () => {
    // Without 八坂神社, the leg from 清水寺 to 錦市場 has no known travel time.
    renderDialog(["a", "b", "c"], (body) => draft("custom", body.orderedTripPlaceIds!, body.legModes ?? {},
      body.orderedTripPlaceIds!.includes("b") ? [] : ["c"]));
    await screen.findAllByRole("button", { name: "這天不去「八坂神社」" });
    fireEvent.click(screen.getAllByRole("button", { name: "這天不去「八坂神社」" }).at(-1)!);

    expect(await screen.findByRole("alert")).toHaveTextContent("拿掉「八坂神社」後，「錦市場」會排不進去");
    // The candidate keeps all three places.
    expect(screen.getAllByRole("button", { name: "這天不去「八坂神社」" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("排不進去：錦市場", { exact: false })).not.toBeInTheDocument();
  });
});
