import { createApp } from "./app";
import { createDatabase, requireDatabaseUrl } from "./database/database";
import { PostgresTripSummaryStore } from "./trips/postgres-trip-summary-store";

const database = createDatabase(requireDatabaseUrl());
const app = createApp({
  tripSummaries: new PostgresTripSummaryStore(database),
});
const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  fetch: app.fetch,
});

console.info(
  JSON.stringify({ event: "api_started", port: server.port, status: "ok" }),
);

function shutDown(signal: string) {
  console.info(JSON.stringify({ event: "api_stopping", signal }));
  server.stop();
  void database.destroy().finally(() => process.exit(0));
}

process.once("SIGINT", () => shutDown("SIGINT"));
process.once("SIGTERM", () => shutDown("SIGTERM"));
