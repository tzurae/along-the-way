import type { DayPlanModule } from "../src/planning/postgres-day-plan-module";

async function unexpectedDayPlanCall(): Promise<never> {
  throw new Error("This test does not exercise day planning");
}

export const unrelatedDayPlanModule = {
  timetable: unexpectedDayPlanCall,
  applyOrder: unexpectedDayPlanCall,
  updateWindow: unexpectedDayPlanCall,
} satisfies DayPlanModule;
