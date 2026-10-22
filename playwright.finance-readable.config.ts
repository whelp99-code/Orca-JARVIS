import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import { resolveE2ePort } from "./scripts/lib/e2e-port.mjs";
import {
  FIXTURE_HOST,
  SEEDED_PORT_1440,
} from "./tests/fixtures/dashboard-fixture-ids.js";

const fixtureEntry = resolve("dist/tests/fixtures/dashboard-http-server.js");
const viteEntry = resolve("dashboard/vite.fp5-e2e.config.ts");
const fixturePort = resolveE2ePort(process.env, SEEDED_PORT_1440);
const vitePort = Number(process.env.JARVIS_E2E_VITE_PORT ?? 4179);
const fixtureOrigin = `http://${FIXTURE_HOST}:${String(fixturePort)}`;

function fixtureCommand(): string {
  const metadata = resolve(`.tmp-e2e/finance-readable-${String(fixturePort)}.json`);
  return [
    "node",
    fixtureEntry,
    "--host",
    FIXTURE_HOST,
    "--port",
    String(fixturePort),
    "--metadata",
    metadata,
    "--static-root",
    resolve("dist/dashboard"),
    "--empty-port",
    String(fixturePort + 1),
    "--empty-metadata",
    resolve(".tmp-e2e/finance-readable-empty.json"),
  ].join(" ");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "finance-readable-cards.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/finance-readable",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: fixtureCommand(),
      url: `${fixtureOrigin}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npx vite --config ${viteEntry} --mode finance-readable`,
      url: `http://${FIXTURE_HOST}:${String(vitePort)}/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "finance-readable",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
        baseURL: `http://${FIXTURE_HOST}:${String(vitePort)}`,
      },
    },
  ],
});
