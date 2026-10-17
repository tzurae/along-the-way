// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { DayTimetableRowDto } from "@along-the-way/contracts/day-plans";

import { TimetableRow } from "../src/TimetableView";

afterEach(cleanup);

it("explains when Google opening hours are unavailable because today's quota is exhausted", () => {
  const row: DayTimetableRowDto = {
    kind: "visit",
    tripPlaceId: "blue-bottle",
    name: "藍瓶咖啡",
    travel: null,
    arriveMinute: 600,
    waitMinutes: 0,
    startMinute: 600,
    endMinute: 660,
    stayMinutes: 60,
    stayEstimated: true,
    hours: "quota",
  };

  render(<ol><TimetableRow row={row} /></ol>);

  expect(screen.getByText("Google 今日額度已用完，營業時間暫時查不到")).toBeInTheDocument();
  expect(screen.queryByText("營業時間查詢失敗，重新排一次可能就查得到")).not.toBeInTheDocument();
});
