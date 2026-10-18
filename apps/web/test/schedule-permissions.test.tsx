// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { DayRouteDto } from "@along-the-way/contracts/day-plans";
import { ApiRequestError } from "../src/api-error";
import { AppToaster } from "../src/AppToaster";
import { DayPlanDialog } from "../src/DayPlanDialog";
import { SchedulePlacesSheet } from "../src/SchedulePlacesSheet";
import { TodayWorkspace } from "../src/TodayWorkspace";
import { TripOnboardingChecklist } from "../src/TripOnboardingChecklist";
import { createTodayModel } from "../src/today-model";
import { TripSkeletonWorkspace } from "../src/TripSkeletonWorkspace";
import { todayActivity, todaySkeleton, todayTrip, todayUser } from "./today-fixtures";
import tripSkeletonWorkspaceSource from "../src/TripSkeletonWorkspace.tsx?raw";

const ownerOnly = "只有旅程擁有者，或擁有者開放的編輯者，可以排入、改期或移出行程。你仍可加入地點、投票與編輯備註。";

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
  it("keeps primary day actions at least 44 pixels tall on touch screens", () => {
    expect(tripSkeletonWorkspaceSource).toContain('className="plan-route-link min-h-11"');
    expect(tripSkeletonWorkspaceSource).toContain('className="plan-outline-button min-h-11"');
  });

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


  it("keeps day-order previews viewable but hides the order apply action from editors", async () => {
    const request = async <T,>(url: string, options?: RequestInit) => {
      if (url === "/api/maps/config") return { browserKey: null, mapId: null } as T;
      const input = options?.body ? JSON.parse(String(options.body)) as { order?: "current" | "suggested" } : {};
      return { route: route(input.order ?? "current") } as T;
    };
    const props = {
      tripId: "A",
      day: { id: "day21", date: "2026-10-21", label: "第 1 天" },
      request,
      onClose: () => {},
      onOrderSaved: async () => {},
    };
    const { rerender } = render(<DayPlanDialog {...props} canArrange={false} />);

    expect(await screen.findByText(ownerOnly)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "儲存為第 1 天的安排" })).not.toBeInTheDocument());
    expect(screen.getByRole("tab", { name: /依直線距離排/ })).toBeInTheDocument();

    rerender(<DayPlanDialog {...props} canArrange />);
    expect(await screen.findByRole("button", { name: "儲存為第 1 天的安排" })).toBeInTheDocument();
    expect(screen.queryByText(ownerOnly)).not.toBeInTheDocument();
  });


  it("maps a forbidden day-order apply to the shared owner action message", async () => {
    const request = async <T,>(url: string, options?: RequestInit) => {
      if (url === "/api/maps/config") return { browserKey: null, mapId: null } as T;
      if (url.endsWith("/place-order")) {
        throw new ApiRequestError("forbidden", "server copy", undefined, undefined, undefined, 403);
      }
      const input = options?.body ? JSON.parse(String(options.body)) as { order?: "current" | "suggested" } : {};
      return { route: route(input.order ?? "current") } as T;
    };
    render(
      <>
        <DayPlanDialog
          tripId="A"
          day={{ id: "day21", date: "2026-10-21", label: "第 1 天" }}
          canArrange
          request={request}
          onClose={() => {}}
          onOrderSaved={async () => {}}
        />
        <AppToaster />
      </>,
    );

    const applyOrder = await screen.findByRole("button", { name: "儲存為第 1 天的安排" });
    await waitFor(() => expect(applyOrder).toBeEnabled());
    fireEvent.click(applyOrder);
    expect(await screen.findByRole("alert")).toHaveTextContent("你目前沒有安排行程的權限；請旅程擁有者在「成員」開放。");
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
    const { rerender } = render(<TodayWorkspace {...common} canArrange={false} />);

    expect(screen.getByText(ownerOnly)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "調整順序" })).not.toBeInTheDocument();

    rerender(<TodayWorkspace {...common} canArrange onArrangeDay={() => {}} />);
    expect(screen.getByRole("button", { name: "調整順序" })).toBeInTheDocument();
    expect(screen.queryByText(ownerOnly)).not.toBeInTheDocument();
  });

  it("hides locked-item unlock, edit, and delete controls from editors", async () => {
    const ownerTrip = todayTrip();
    const lockedItem = {
      ...todayActivity("locked-booking"),
      lockedAt: "2026-10-21T00:00:00.000Z",
      lockedBy: todayUser.id,
    };
    const skeleton = todaySkeleton(ownerTrip, [lockedItem]);
    const request = async <T,>(url: string) => {
      if (url.endsWith("/skeleton")) return { skeleton } as T;
      if (url.endsWith("/trip-places")) return { tripPlaces: [] } as T;
      throw new Error(`Unexpected request: ${url}`);
    };
    const props = {
      request,
      onTripChanged: async () => {},
      placesRevision: 0,
      onPlacesChanged: () => {},
      onTravelEdit: () => {},
    };
    const { rerender } = render(
      <TripSkeletonWorkspace {...props} trip={{ ...ownerTrip, role: "editor" }} />,
    );

    const row = await screen.findByRole("button", { name: /locked-booking/ });
    fireEvent.click(row);
    const detail = await waitFor(() => {
      const article = document.querySelector<HTMLElement>('[data-item-id="locked-booking"].itinerary-card');
      expect(article).toBeInTheDocument();
      return article!;
    });
    expect(within(detail).queryByRole("button", { name: "解鎖" })).not.toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "刪除" })).not.toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: /編輯/ })).not.toBeInTheDocument();

    rerender(<TripSkeletonWorkspace {...props} trip={ownerTrip} />);
    expect(await within(detail).findByRole("button", { name: "解鎖" })).toBeInTheDocument();
    expect(within(detail).queryByRole("button", { name: "刪除" })).not.toBeInTheDocument();
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

function route(order: "current" | "suggested"): DayRouteDto {
  const orderedTripPlaceIds = order === "suggested" ? ["b", "a"] : ["a", "b"];
  return {
    dayId: "day21",
    date: "2026-10-21",
    version: 1,
    order,
    orderedTripPlaceIds,
    startsAt: null,
    endsAt: null,
    stops: orderedTripPlaceIds.map((tripPlaceId, index) => ({
      tripPlaceId,
      name: tripPlaceId === "a" ? "清水寺" : "二年坂",
      latitude: 34.99 + index * 0.01,
      longitude: 135.78 + index * 0.01,
      providerPlaceId: null,
      metersFromPrevious: index === 0 ? null : 1_000,
    })),
    metersToEnd: null,
    totalMeters: 1_000,
  };
}
