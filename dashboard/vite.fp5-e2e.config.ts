import { mergeConfig } from "vite";
import { FIXTURE_HOST, SEEDED_PORT_1440 } from "../tests/fixtures/dashboard-fixture-ids.js";
import base from "./vite.config.js";

const fixtureOrigin = `http://${FIXTURE_HOST}:${String(SEEDED_PORT_1440)}`;

export default mergeConfig(base, {
  server: {
    host: FIXTURE_HOST,
    port: 4179,
    strictPort: true,
    proxy: {
      "/api": { target: fixtureOrigin, changeOrigin: true },
      "/events": { target: fixtureOrigin, changeOrigin: true },
    },
  },
});
