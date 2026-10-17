// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AppToaster, notify } from "../src/AppToaster";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("removes an expired toast and its Close button from the page", () => {
  render(<AppToaster />);
  act(() => notify("success", "已儲存"));
  act(() => vi.advanceTimersByTime(20));
  expect(screen.getByRole("status")).toHaveTextContent("已儲存");

  act(() => vi.advanceTimersByTime(4000 + 500));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "關閉" })).not.toBeInTheDocument();
});

it("removes a dismissed error toast instead of leaving a focusable invisible Close button", () => {
  render(<AppToaster />);
  act(() => notify("error", "儲存失敗"));
  act(() => vi.advanceTimersByTime(20));
  fireEvent.click(screen.getByRole("button", { name: "關閉" }));
  act(() => vi.advanceTimersByTime(500));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "關閉" })).not.toBeInTheDocument();
});

it("keeps a newer toast when an older one's removal timer would have fired", () => {
  render(<AppToaster />);
  act(() => notify("success", "第一則"));
  act(() => vi.advanceTimersByTime(4000 + 400));
  act(() => notify("error", "第二則"));
  act(() => vi.advanceTimersByTime(200));
  expect(screen.getByRole("alert")).toHaveTextContent("第二則");
});
