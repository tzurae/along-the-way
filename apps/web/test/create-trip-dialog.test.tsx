// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { CreateTripDialog } from "../src/CreateTripDialog";

function ControlledDialog() {
  const [open, setOpen] = useState(true);
  return <>
    <button type="button" onClick={() => setOpen(true)}>重新開啟</button>
    <CreateTripDialog open={open} onOpenChange={setOpen} createTrip={vi.fn(async () => {})} />
  </>;
}
function calendarButton(day: string) {
  const popover = document.querySelector<HTMLElement>('[data-slot="popover-content"]');
  if (!popover) throw new Error("Expected the date popover");
  const button = within(popover).getAllByRole("button").find((candidate) => candidate.textContent === day);
  if (!button) throw new Error(`Expected calendar day ${day}`);
  return button;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 12, 12));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("ignores pointer dismissal, keeps Escape and X, and preserves the in-memory draft", () => {
  render(<ControlledDialog />);
  fireEvent.change(screen.getByLabelText("旅程名稱"), { target: { value: "保留中的草稿" } });

  const close = screen.getByRole("button", { name: "關閉" });
  expect(close).toHaveClass("size-11");
  const backdrop = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')!;
  fireEvent.pointerDown(backdrop);
  fireEvent.pointerUp(backdrop);
  expect(screen.getByRole("dialog", { name: "建立旅程" })).toBeVisible();

  fireEvent.click(close);
  expect(screen.queryByRole("dialog", { name: "建立旅程" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "重新開啟" }));
  expect(screen.getByLabelText("旅程名稱")).toHaveValue("保留中的草稿");
  expect(screen.getByRole("heading", { name: "步驟 1 / 3・旅程" })).toBeVisible();

  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "建立旅程" })).not.toBeInTheDocument();
});

it("keeps a completed range open until 確定 and resets an existing range on selection", () => {
  render(<ControlledDialog />);
  fireEvent.click(screen.getByRole("button", { name: "選擇日期範圍" }));
  const confirm = screen.getByRole("button", { name: "確定" });
  expect(confirm).toBeDisabled();

  fireEvent.click(calendarButton("21"));
  fireEvent.click(calendarButton("27"));
  expect(screen.getByRole("button", { name: "確定" })).toBeEnabled();
  expect(document.querySelector('[data-slot="popover-content"]')).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "確定" }));
  expect(document.querySelector('[data-slot="popover-content"]')).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /2026\/10\/21 – 2026\/10\/27/ })).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: /2026\/10\/21 – 2026\/10\/27/ }));
  fireEvent.click(calendarButton("24"));
  expect(screen.queryByRole("button", { name: /2026\/10\/21 – 2026\/10\/27/ })).not.toBeInTheDocument();
  expect(document.querySelector('[data-slot="popover-content"]')).toBeInTheDocument();
});

it("supports confirming a single-day range by selecting the same day twice", () => {
  render(<ControlledDialog />);
  fireEvent.click(screen.getByRole("button", { name: "選擇日期範圍" }));
  fireEvent.click(calendarButton("21"));
  fireEvent.click(calendarButton("21"));
  const confirm = screen.getByRole("button", { name: "確定" });
  expect(confirm).toBeEnabled();
  fireEvent.click(confirm);
  expect(screen.getByRole("button", { name: /2026\/10\/21 – 2026\/10\/21/ })).toBeVisible();
});
