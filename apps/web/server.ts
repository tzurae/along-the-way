import * as path from "node:path";

import { createStaticHandler } from "./server/static-handler";

const publicRoot = path.resolve(import.meta.dir, "dist");
const port = Number(process.env.PORT ?? 4173);
const handleStaticRequest = createStaticHandler(publicRoot);

const server = Bun.serve({
  port,
  fetch: handleStaticRequest,
});

console.info(
  JSON.stringify({ event: "web_started", port: server.port, status: "ok" }),
);
