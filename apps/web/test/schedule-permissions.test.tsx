// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { DayTimetableDto, TripPlanDto } from "@along-the-way/contracts/day-plans";
import { ApiRequestError } from "../src/api-error";
import { DayPlanDialog } from "../src/DayPlanDialog";
import { SchedulePlacesSheet } from "../src/SchedulePlacesSheet";
import { TodayWorkspace } from "../src/TodayWorkspace";
import { TripOnboardingChecklist } from "../src/TripOnboardingChecklist";
import { TripPlanDialog } from "../src/TripPlanDialog";
import { createTodayModel } from "../src/today-model";
import { todaySkeleton, todayTrip, todayUser } from "./today-fixtures";

const ownerOnly = "只有旅程擁有者可以排入、改期或移出行程。你仍可加入地點、投票與編輯備註。";

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

describe("owner-only schedule surfaces", () => {
  it("renders the schedule sheet only for owners and summarizes bulk selections without hiding names", async () => {
    const trip = todayTrip();
    const places = [
      { id: "one", name: "第一個很長的地點名稱" },
      { id: "two", name: "第二個地點" },
      { id: "three", name: "第三個地點" },
    ];
    const { rerender } = render(
      <SchedulePlacesSheet open trip={trip} places={places} busy={false} onConfirm={() => {}} onClose={() => {}} />,
    );

    expect(await screen.findByText("已選 3 個地點")).toBeInTheDocument();
    for (const place of places) expect(screen.getByText(place.name)).toBeInTheDocument();
    rerender(
      <SchedulePlacesSheet open trip={trip} places={[places[0]!]} busy={false} onConfirm={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByText(places[0]!.name)).toBeInTheDocument();
    expect(screen.queryByText("已選 1 個地點")).not.toBeInTheDocument();


    rerender(
      <SchedulePlacesSheet open trip={{ ...trip, role: "editor" }} places={places} busy={false} onConfirm={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => expect(screen.queryByText("排入行程")).not.toBeInTheDocument());
  });

  it("keeps the whole-trip draft viewable but hides its apply action from editors", async () => {
    const plan: TripPlanDto = {
      basis: "basis",
      days: [{
        timetable: timetable("suggested"),
        addedTripPlaceIds: ["place"],
        orderedTripPlaceIds: ["place"],
      }],
      unplaced: [],
    };
    const request = async <T,>() => ({ plan } as T);
    const props = {
      tripId: "A",
      open: true,
      dayLabels: new Map([["day21", "第 1 天"]]),
      request,
      onClose: () => {},
      onApplied: () => {},
    };
    const { rerender } = render(<TripPlanDialog {...props} isOwner={false} />);

    expect(await screen.findByText(ownerOnly)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "套用這個規劃" })).not.toBeInTheDocument();

    rerender(<TripPlanDialog {...props} isOwner />);
    expect(await screen.findByRole("button", { name: "套用這個規劃" })).toBeInTheDocument();
    expect(screen.queryByText(ownerOnly)).not.toBeInTheDocument();
  });

  it("maps a forbidden whole-trip apply to the shared owner action message", async () => {
    const plan: TripPlanDto = {
      basis: "basis",
      days: [{
        timetable: timetable("suggested"),
        addedTripPlaceIds: ["place"],
        orderedTripPlaceIds: ["place"],
      }],
      unplaced: [],
    };
    const request = async <T,>(url: string) => {
      if (url.endsWith("/apply")) {
        throw new ApiRequestError("forbidden", "server copy", undefined, undefined, undefined, 403);
      }
      return { plan } as T;
    };
    render(
      <TripPlanDialog
        tripId="A"
        open
        dayLabels={new Map([["day21", "第 1 天"]])}
        isOwner
        request={request}
        onClose={() => {}}
        onApplied={() => {}}
      />,
    );

    const applyPlan = await screen.findByRole("button", { name: "套用這個規劃" });
    await waitFor(() => expect(applyPlan).toBeEnabled());
    fireEvent.click(applyPlan);
    expect(await screen.findByRole("alert")).toHaveTextContent("只有旅程擁有者可以更改行程安排。");
  });

  it("keeps day-order previews viewable but hides the order apply action from editors", async () => {
    const request = async <T,>(_url: string, options?: RequestInit) => {
      const input = options?.body ? JSON.parse(String(options.body)) as { order?: "current" | "suggested" } : {};
      return { timetable: timetable(input.order ?? "current") } as T;
    };
    const props = {
      tripId: "A",
      day: { id: "day21", date: "2026-10-21", label: "第 1 天" },
      request,
      onClose: () => {},
      onOrderSaved: async () => {},
    };
    const { rerender } = render(<DayPlanDialog {...props} isOwner={false} />);

    expect(await screen.findByText(ownerOnly)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "使用這個順序" })).not.toBeInTheDocument());
    expect(screen.getByRole("tab", { name: /建議/ })).toBeInTheDocument();

    rerender(<DayPlanDialog {...props} isOwner />);
    expect(await screen.findByRole("button", { name: "使用這個順序" })).toBeInTheDocument();
    expect(screen.queryByText(ownerOnly)).not.toBeInTheDocument();
  });

  it("maps a forbidden day-order apply to the shared owner action message", async () => {
    const request = async <T,>(url: string, options?: RequestInit) => {
      if (url.endsWith("/place-order")) {
        throw new ApiRequestError("forbidden", "server copy", undefined, undefined, undefined, 403);
      }
      const input = options?.body ? JSON.parse(String(options.body)) as { order?: "current" | "suggested" } : {};
      return { timetable: timetable(input.order ?? "current") } as T;
    };
    render(
      <DayPlanDialog
        tripId="A"
        day={{ id: "day21", date: "2026-10-21", label: "第 1 天" }}
        isOwner
        request={request}
        onClose={() => {}}
        onOrderSaved={async () => {}}
      />,
    );

    const applyOrder = await screen.findByRole("button", { name: "使用這個順序" });
    await waitFor(() => expect(applyOrder).toBeEnabled());
    fireEvent.click(applyOrder);
    expect(await screen.findByRole("alert")).toHaveTextContent("只有旅程擁有者可以更改行程安排。");
  });

  it("shows an editor why an empty Today cannot be arranged while preserving the owner action", () => {
    const trip = todayTrip();
    const model = createTodayModel(trip, todaySkeleton(trip), [], todayUser.id);
    const common = {
      model,
      selectedDate: "2026-10-21",
      onDayChanged: () => {},
      fetchedAt: "2026-10-21T01:30:00Z",
      retry: () => {},
    };
    const { rerender } = render(<TodayWorkspace {...common} isOwner={false} />);

    expect(screen.getByText(ownerOnly)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "安排這一天" })).not.toBeInTheDocument();

    rerender(<TodayWorkspace {...common} isOwner onArrangeDay={() => {}} />);
    expect(screen.getByRole("button", { name: "安排這一天" })).toBeInTheDocument();
    expect(screen.queryByText(ownerOnly)).not.toBeInTheDocument();
  });

  it("offers the assign-place onboarding item only to owners", () => {
    const common = {
      tripId: "A",
      userId: todayUser.id,
      facts: { hasLodging: true, placeCount: 1, hasAssignedPlace: false, hasCompanionOrPendingInvite: true },
      navigate: () => {},
    };
    const { rerender } = render(<TripOnboardingChecklist {...common} isOwner />);

    expect(screen.getByRole("button", { name: "把地點排進某一天" })).toBeInTheDocument();

    rerender(<TripOnboardingChecklist {...common} isOwner={false} />);
    expect(screen.queryByRole("button", { name: "把地點排進某一天" })).not.toBeInTheDocument();
  });
});

function timetable(order: "current" | "suggested"): DayTimetableDto {
  return {
    dayId: "day21",
    date: "2026-10-21",
    window: { startMinute: 540, endMinute: 1140, version: 1 },
    order,
    orderedTripPlaceIds: ["place"],
    startsAt: null,
    endsAt: null,
    rows: [],
    unscheduled: [],
    load: { busyMinutes: 60, windowMinutes: 600, level: "relaxed" },
  };
}
