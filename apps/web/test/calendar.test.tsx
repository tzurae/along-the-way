// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Calendar } from "../src/components/ui/calendar";

afterEach(cleanup);

it("uses the strong accent strip while retaining primary endpoint buttons", () => {
  const { container } = render(
    <Calendar
      mode="range"
      month={new Date(2026, 9, 1)}
      selected={{ from: new Date(2026, 9, 21), to: new Date(2026, 9, 27) }}
    />,
  );

  const middle = container.querySelector<HTMLButtonElement>('button[data-range-middle="true"]');
  const start = container.querySelector<HTMLButtonElement>('button[data-range-start="true"]');
  const end = container.querySelector<HTMLButtonElement>('button[data-range-end="true"]');
  expect(middle).toHaveClass("bg-accent-strong", "text-on-dark");
  expect(start).toHaveClass("bg-primary", "text-primary-foreground");
  expect(end).toHaveClass("bg-primary", "text-primary-foreground");
  expect(start?.closest("td")).toHaveClass("bg-accent-strong");
  expect(end?.closest("td")).toHaveClass("bg-accent-strong");
});
