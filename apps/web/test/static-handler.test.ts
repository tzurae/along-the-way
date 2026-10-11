import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createStaticHandler } from "../server/static-handler";

describe("production web static handler", () => {
  let publicRoot: string;
  let handle: ReturnType<typeof createStaticHandler>;

  beforeAll(async () => {
    publicRoot = await mkdtemp(path.join(tmpdir(), "along-the-way-web-"));
    await mkdir(path.join(publicRoot, "assets"));
    await writeFile(path.join(publicRoot, "index.html"), "<h1>app shell</h1>");
    await writeFile(path.join(publicRoot, "assets", "app-123.js"), "ok");
    handle = createStaticHandler(publicRoot);
  });

  afterAll(async () => {
    await rm(publicRoot, { recursive: true, force: true });
  });

  it("returns 404 without long-term caching for a missing asset", async () => {
    const response = await handle(
      new Request("http://localhost/assets/missing-123.js"),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("uses the app shell only for navigation routes", async () => {
    const response = await handle(new Request("http://localhost/trips/demo"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    await expect(response.text()).resolves.toContain("app shell");
  });

  it("caches an existing versioned asset immutably", async () => {
    const response = await handle(
      new Request("http://localhost/assets/app-123.js"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });
});
