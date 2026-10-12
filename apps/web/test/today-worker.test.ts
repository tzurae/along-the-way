import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { build } from "vite";
import { appShellWorker } from "../service-worker-plugin";

it("reopens the newly deployed shell offline even when only finalized HTML changed, without caching API responses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "today-worker-"));
  const cacheData = new Map<string, Map<string, Response>>();
  let documentVersion = "SHELL_V1";
  let online = true;
  let handlers = new Map<string, (event: unknown) => void>();
  const fetchDocument = async () => { if (!online) throw new TypeError("offline"); return new Response(documentVersion); };
  async function worker() {
    await writeFile(join(directory, "index.html"), `<main>${documentVersion}</main><script type="module" src="/main.js"></script>`);
    const result = await build({ configFile: false, root: directory, logLevel: "silent", plugins: [appShellWorker()], build: { write: false, minify: false } });
    if (Array.isArray(result) || !("output" in result)) throw new Error("Expected one output bundle");
    const asset = result.output.find((entry) => entry.fileName === "sw.js");
    if (!asset || asset.type !== "asset") throw new Error("Missing app-shell worker");
    return String(asset.source);
  }
  async function install(source: string) {
    handlers = new Map();
    runInNewContext(source, { URL, fetch: fetchDocument,
      self: { location: { origin: "https://trip.test" }, addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler), skipWaiting: async () => {}, clients: { claim: async () => {} } },
      caches: {
        open: async (name: string) => ({ addAll: async (urls: string[]) => { const entries = new Map<string, Response>(); for (const url of urls) entries.set(url, await fetchDocument()); cacheData.set(name, entries); } }),
        keys: async () => [...cacheData.keys()], delete: async (name: string) => cacheData.delete(name),
        match: async (url: string, options: { cacheName: string }) => cacheData.get(options.cacheName)?.get(url)?.clone(),
      },
    });
    for (const name of ["install", "activate"]) {
      let pending: Promise<void> | undefined;
      handlers.get(name)!({ waitUntil: (promise: Promise<void>) => { pending = promise; } });
      await pending;
    }
  }
  async function navigate(url = "https://trip.test/", mode = "navigate") {
    let response: Promise<Response> | undefined;
    handlers.get("fetch")!({ request: { url, mode, method: "GET" }, respondWith: (promise: Promise<Response>) => { response = promise; } });
    return response;
  }
  try {
    await writeFile(join(directory, "main.js"), 'console.log("unchanged asset");');
    const initial = await worker();
    cacheData.set("hk-trip-images-v12", new Map([
      ["/api/trips/private/photo", new Response("private image")],
    ]));
    await install(initial);
    expect(cacheData.has("hk-trip-images-v12")).toBe(false);
    documentVersion = "SHELL_V2";
    const updated = await worker();
    // Browsers install a new service worker only when its bytes change.
    if (updated !== initial) await install(updated);
    expect(await (await navigate())!.text()).toBe("SHELL_V2");
    online = false;
    expect(await (await navigate())!.text()).toBe("SHELL_V2");
    expect(await navigate("https://trip.test/api/trips", "cors")).toBeUndefined();
    expect(await navigate("https://trip.test/api", "cors")).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("keeps API JSON and authenticated API images out of the legacy worker caches", async () => {
  const source = await readFile(new URL("../../../sw.js", import.meta.url), "utf8");
  let fetchHandler: ((event: {
    request: { method: string; url: string; destination: string; mode: string };
    respondWith(response: Promise<Response>): void;
  }) => void) | undefined;
  let cacheOpens = 0;
  runInNewContext(source, {
    URL,
    fetch: async () => new Response("private response"),
    self: {
      location: { origin: "https://trip.test" },
      addEventListener: (name: string, handler: typeof fetchHandler) => {
        if (name === "fetch") fetchHandler = handler;
      },
      skipWaiting: () => {},
      clients: { claim: () => {} },
    },
    caches: {
      open: async () => {
        cacheOpens += 1;
        return { match: async () => null, put: async () => {} };
      },
      keys: async () => [],
      delete: async () => true,
      match: async () => null,
    },
  });

  for (const [url, destination] of [
    ["https://trip.test/api/trips", ""],
    ["https://trip.test/api/trips/private/photo", "image"],
  ] as const) {
    let response: Promise<Response> | undefined;
    fetchHandler!({
      request: { method: "GET", url, destination, mode: "cors" },
      respondWith: (value) => { response = value; },
    });
    if (response) await response;
    expect(response).toBeUndefined();
  }
  expect(cacheOpens).toBe(0);
});
