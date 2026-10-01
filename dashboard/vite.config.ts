import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist/dashboard", import.meta.url)),
    emptyOutDir: true,
    // The phone gateway serves only manifest-listed assets (src/phone-gateway-http.ts loadAssetNames).
    manifest: "manifest.json",
  },
  envPrefix: ["VITE_"],
  test: {
    environment: "jsdom",
    globals: true,
  },
});
