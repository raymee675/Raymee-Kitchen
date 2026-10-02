import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const base = process.env.PAGES_BASE_PATH || "/";

function offlineShell(): Plugin {
  return {
    name: "teppan-offline-shell",
    apply: "build",
    generateBundle(_options, bundle) {
      const names = new Set(["index.html", "favicon.svg", "manifest.webmanifest", ...Object.keys(bundle)]);
      const paths = [...names].sort();
      const digest = createHash("sha256");
      for (const path of paths) {
        digest.update(path);
        const output = bundle[path];
        if (output) digest.update(output.type === "chunk" ? output.code : output.source);
        else if (path === "index.html") digest.update(readFileSync(resolve(projectRoot, "pages-client/index.html")));
        else digest.update(readFileSync(resolve(projectRoot, "pages-client/public", path)));
      }

      const scope = base.endsWith("/") ? base : `${base}/`;
      const scopeKey = createHash("sha256").update(scope).digest("hex").slice(0, 8);
      const cachePrefix = `teppan-shell-${scopeKey}-`;
      const cacheName = `${cachePrefix}${digest.digest("hex").slice(0, 16)}`;
      const worker = [
        `const CACHE_PREFIX = ${JSON.stringify(cachePrefix)};`,
        `const CACHE_NAME = ${JSON.stringify(cacheName)};`,
        `const APP_URLS = ${JSON.stringify(paths)}.map(path => new URL(path, self.registration.scope).href);`,
        `const INDEX_URL = new URL("index.html", self.registration.scope).href;`,
        `self.addEventListener("install", event => { event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_URLS))); });`,
        `self.addEventListener("activate", event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim())); });`,
        `self.addEventListener("message", event => { if (event.data && event.data.type === "APPLY_UPDATE") void self.skipWaiting(); });`,
        `self.addEventListener("fetch", event => { const request = event.request; const url = new URL(request.url); if (request.method !== "GET" || url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return; event.respondWith((async () => { const cache = await caches.open(CACHE_NAME); const cached = await cache.match(request); if (cached) return cached; if (request.mode === "navigate") { const page = await cache.match(INDEX_URL); if (page) return page; } try { const response = await fetch(request); if (response.ok) await cache.put(request, response.clone()); return response; } catch { return Response.error(); } })()); });`,
      ].join("\n");

      this.emitFile({ type: "asset", fileName: "sw.js", source: worker });
    },
  };
}

export default defineConfig({
  root: resolve(projectRoot, "pages-client"),
  base: base.endsWith("/") ? base : `${base}/`,
  define: {
    __PAGES_BASE__: JSON.stringify(base.endsWith("/") ? base : `${base}/`),
    __PAGES_MODE__: JSON.stringify(true),
  },
  publicDir: resolve(projectRoot, "pages-client/public"),
  plugins: [react(), offlineShell()],
  resolve: { alias: { "@": projectRoot } },
  css: { postcss: resolve(projectRoot, "postcss.config.mjs") },
  build: {
    outDir: resolve(projectRoot, "dist-pages"),
    emptyOutDir: true,
  },
});
