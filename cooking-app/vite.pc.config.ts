import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export default defineConfig({
  root: fileURLToPath(new URL("./pc-client", import.meta.url)),
  plugins: [react()],
  define: { __PAGES_MODE__: JSON.stringify(false) },
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  css: { postcss: fileURLToPath(new URL("./postcss.config.mjs", import.meta.url)) },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL("./dist-pc", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: { input: {
      index: resolve(fileURLToPath(new URL("./pc-client/index.html", import.meta.url))),
      admin: resolve(fileURLToPath(new URL("./pc-client/admin.html", import.meta.url))),
    } },
  },
});
