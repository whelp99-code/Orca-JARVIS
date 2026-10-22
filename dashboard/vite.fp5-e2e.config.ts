import { mergeConfig } from "vite";
import { FIXTURE_HOST, SEEDED_PORT_1440 } from "../tests/fixtures/dashboard-fixture-ids.js";
import base from "./vite.config.js";

const fixtureOrigin = `http://${FIXTURE_HOST}:${process.env.JARVIS_E2E_PORT ?? String(SEEDED_PORT_1440)}`;

export default mergeConfig(base, {
  server: {
    host: FIXTURE_HOST,
    port: Number(process.env.JARVIS_E2E_VITE_PORT ?? 4179),
    strictPort: true,
    proxy: {
      "/api": { target: fixtureOrigin, changeOrigin: true },
      "/events": { target: fixtureOrigin, changeOrigin: true },
    },
  },
});
