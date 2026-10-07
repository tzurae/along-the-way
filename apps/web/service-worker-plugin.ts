import { createHash } from "node:crypto";
import type { Plugin } from "vite";

/** A build manifest, not a runtime catch-all cache: no authenticated response can enter it. */
export function appShellWorker(): Plugin {
  return {
    name: "along-the-way-app-shell",
    apply: "build",
    enforce: "post",
    generateBundle: { order: "post", handler(_options, bundle) {
      const assets = Object.keys(bundle).filter((name) => name.startsWith("assets/") && /\.(js|css|woff2?|png|svg|ico)$/.test(name)).map((name) => `/${name}`).sort();
      const html = bundle["index.html"];
      if (!html || html.type !== "asset") this.error("App shell HTML is missing from the finalized bundle");
      const version = createHash("sha256").update(assets.join("\n")).update(html.source).digest("hex").slice(0, 16);
      this.emitFile({ type: "asset", fileName: "sw.js", source: `
const CACHE = ${JSON.stringify(`along-the-way-shell-${version}`)};
const ASSETS = ${JSON.stringify(assets)};
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(["/", ...ASSETS])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("along-the-way-shell-") && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname === "/api" || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate" && (url.pathname === "/" || url.pathname === "/index.html")) {
    event.respondWith(fetch(request).then(async (response) => {
      if (!response.ok) return (await caches.match("/", { cacheName: CACHE })) || response;
      return response;
    }).catch(() => caches.match("/", { cacheName: CACHE })));
  } else if (ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(url.pathname, { cacheName: CACHE }).then((cached) => cached || fetch(request)));
  }
});
` });
    } },
  };
}
