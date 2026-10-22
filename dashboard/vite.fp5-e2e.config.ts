import { mergeConfig } from "vite";
import { resolveE2ePort } from "../scripts/lib/e2e-port.mjs";
import { FIXTURE_HOST, SEEDED_PORT_1440 } from "../tests/fixtures/dashboard-fixture-ids.js";
import base from "./vite.config.js";

const fixtureOrigin = `http://${FIXTURE_HOST}:${String(resolveE2ePort(process.env, SEEDED_PORT_1440))}`;

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
