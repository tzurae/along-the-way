import type { DayRouteModule } from "../src/planning/postgres-day-route-module";

async function unexpectedDayRouteCall(): Promise<never> {
  throw new Error("This test does not exercise day route planning");
}

export const unrelatedDayRouteModule = {
  plan: unexpectedDayRouteCall,
  applyOrder: unexpectedDayRouteCall,
} satisfies DayRouteModule;
