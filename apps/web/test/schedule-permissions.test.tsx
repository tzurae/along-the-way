// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { DayTimetableDto, TripPlanDto } from "@along-the-way/contracts/day-plans";
import { ApiRequestError } from "../src/api-error";
import { DayPlanDialog } from "../src/DayPlanDialog";
import { SchedulePlacesSheet } from "../src/SchedulePlacesSheet";
import { TodayWorkspace } from "../src/TodayWorkspace";
import { TripOnboardingChecklist } from "../src/TripOnboardingChecklist";
import { TripPlanDialog } from "../src/TripPlanDialog";
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
    const { rerender } = render(<TripPlanDialog {...props} canArrange={false} />);

    expect(await screen.findByText(ownerOnly)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "套用這個規劃" })).not.toBeInTheDocument();

    rerender(<TripPlanDialog {...props} canArrange />);
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
        canArrange
        request={request}
        onClose={() => {}}
        onApplied={() => {}}
      />,
    );

    const applyPlan = await screen.findByRole("button", { name: "套用這個規劃" });
    await waitFor(() => expect(applyPlan).toBeEnabled());
    fireEvent.click(applyPlan);
    expect(await screen.findByRole("alert")).toHaveTextContent("你目前沒有安排行程的權限；請旅程擁有者在「成員」開放。");
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
      openRapidApiKeys: () => {},
      onClose: () => {},
      onOrderSaved: async () => {},
      addablePlaces: [],
      coordinates: new Map(),
      stays: new Map(),
    };
    const { rerender } = render(<DayPlanDialog {...props} canArrange={false} />);

    expect(await screen.findByText(ownerOnly)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "儲存為第 1 天的安排" })).not.toBeInTheDocument());
    expect(screen.getByRole("tab", { name: /依距離排/ })).toBeInTheDocument();

    fireEvent.click(screen.getByText("可安排時間・交通方式"));
    expect(screen.queryByLabelText("開始")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("結束")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "這天怎麼移動" })).not.toBeInTheDocument();

    rerender(<DayPlanDialog {...props} canArrange />);
    expect(await screen.findByRole("button", { name: "儲存為第 1 天的安排" })).toBeInTheDocument();
    expect(screen.queryByText(ownerOnly)).not.toBeInTheDocument();
  });


  it("maps a forbidden day-order apply to the shared owner action message", async () => {
    const request = async <T,>(url: string, options?: RequestInit) => {
      if (url.endsWith("/arrangement")) {
        throw new ApiRequestError("forbidden", "server copy", undefined, undefined, undefined, 403);
      }
      const input = options?.body ? JSON.parse(String(options.body)) as { order?: "current" | "suggested" } : {};
      return { timetable: timetable(input.order ?? "current") } as T;
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
    expect(screen.queryByRole("button", { name: "安排這一天" })).not.toBeInTheDocument();

    rerender(<TodayWorkspace {...common} canArrange onArrangeDay={() => {}} />);
    expect(screen.getByRole("button", { name: "安排這一天" })).toBeInTheDocument();
    expect(screen.queryByText(ownerOnly)).not.toBeInTheDocument();
  });

  it("shows Google author attribution beside a Today endpoint thumbnail", async () => {
    const trip = todayTrip();
    const model = createTodayModel(trip, todaySkeleton(trip, [todayActivity()]), [], todayUser.id);
    const request = async <T,>(url: string) => {
      if (!url.includes("/place-previews?")) throw new Error(`Unexpected request: ${url}`);
      return {
        previews: [{
          reference: { kind: "itinerary-place", id: "place" },
          photo: {
            source: "google",
            index: 0,
            id: "google:ChIJTodayEndpoint:0:0123456789abcdef",
            thumbnailUrl: "/api/trips/A/google-place-photos/ChIJTodayEndpoint?index=0&photo=0123456789abcdef&maxWidth=192",
            imageUrl: "/api/trips/A/google-place-photos/ChIJTodayEndpoint?index=0&photo=0123456789abcdef&maxWidth=1024",
            width: 1200,
            height: 800,
            authors: [{ displayName: "端點攝影者", uri: "https://maps.google.com/contrib/today-author" }],
            googleMapsUri: "https://maps.google.com/?cid=987",
          },
          photoCount: 3,
        }],
      } as T;
    };
    const { container } = render(
      <TodayWorkspace
        model={model}
        selectedDate="2026-10-21"
        onDayChanged={() => {}}
        fetchedAt="2026-10-21T01:30:00Z"
        retry={() => {}}
        request={request}
      />,
    );

    const item = container.querySelector<HTMLButtonElement>("[data-today-item-trigger]");
    expect(item).toBeInTheDocument();
    fireEvent.click(item!);
    await waitFor(() => expect(document.querySelector(".place-photo-credit")).toHaveTextContent("Google Maps・端點攝影者"));
    expect(screen.getByRole("link", { name: "端點攝影者" })).toHaveAttribute("href", "https://maps.google.com/contrib/today-author");
    expect(screen.getByRole("img", { name: "共 3 張照片" })).toBeInTheDocument();
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
      openRapidApiKeys: () => {},
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

function timetable(order: "current" | "suggested"): DayTimetableDto {
  return {
    dayId: "day21",
    date: "2026-10-21",
    window: { startMinute: 540, endMinute: 1140, version: 1, travelMode: "transit", walkLimitMinutes: 15 },
    legModes: {},
    taxiAlternative: null,
    order,
    // The straight-line order differs from the saved one, so there is something to save.
    orderedTripPlaceIds: order === "suggested" ? ["b", "a"] : ["a", "b"],
    startsAt: null,
    endsAt: null,
    rows: [],
    capacity: { arrival: null, departure: null, gaps: [{ startMinute: 540, endMinute: 1140 }] },
    unscheduled: [],
    load: { busyMinutes: 60, windowMinutes: 600, level: "relaxed" },
  };
}
