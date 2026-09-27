// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TripSummaryPage } from "../src/TripSummaryPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TripSummaryPage", () => {
  it("renders the trip summary returned by the API", async () => {
    const fetchStub = vi.fn(async () =>
      new Response(
        JSON.stringify({
          trip: {
            slug: "hong-kong-together",
            title: "一起走的香港四日",
            destination: "香港",
            startDate: "2026-08-28",
            endDate: "2026-08-31",
            travelerCount: 2,
            dayCount: 4,
            nextDecision: "一起選定第二天晚餐",
            updatedAt: "2026-08-17T12:00:00.000Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchStub);

    render(<TripSummaryPage slug="hong-kong-together" />);

    expect(screen.getByRole("status")).toHaveTextContent("正在整理旅程");
    expect(
      await screen.findByRole("heading", { name: "一起走的香港四日" }),
    ).toBeInTheDocument();
    expect(screen.getByText("2026/8/28－2026/8/31")).toBeInTheDocument();
    expect(screen.getByText("2 位旅伴・4 天")).toBeInTheDocument();
    expect(screen.getByText("一起選定第二天晚餐")).toBeInTheDocument();
    expect(fetchStub).toHaveBeenCalledWith(
      "/api/trips/hong-kong-together/summary",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("offers a retry path when the API cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    render(<TripSummaryPage slug="hong-kong-together" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "暫時拿不到旅程資料",
    );
    expect(screen.getByRole("button", { name: "再試一次" })).toBeEnabled();
  });
});
