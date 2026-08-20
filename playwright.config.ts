import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import {
  EMPTY_PORT,
  FIXTURE_HOST,
  SEEDED_PORT_1024,
  SEEDED_PORT_1440,
} from "./tests/fixtures/dashboard-fixture-ids.js";

const fixtureEntry = resolve("dist/tests/fixtures/dashboard-http-server.js");
const staticRoot = resolve("dist/dashboard");
const noFixture = process.env.JARVIS_E2E_NO_FIXTURE === "1";

function fixtureCommand(port: number, emptyPort?: number): string {
  const metadata = resolve(`.tmp-e2e/seeded-${String(port)}.json`);
  const parts = [
    "node",
    fixtureEntry,
    "--host",
    FIXTURE_HOST,
    "--port",
    String(port),
    "--metadata",
    metadata,
    "--static-root",
    staticRoot,
  ];
  if (emptyPort !== undefined) {
    parts.push("--empty-port", String(emptyPort), "--empty-metadata", resolve(".tmp-e2e/empty.json"));
  }
  return parts.join(" ");
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI === "1" ? [["github"], ["list"]] : [["list"]],
  outputDir: "test-results",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: noFixture ? undefined : [
    {
      command: fixtureCommand(SEEDED_PORT_1440, EMPTY_PORT),
      url: `http://${FIXTURE_HOST}:${String(SEEDED_PORT_1440)}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: fixtureCommand(SEEDED_PORT_1024),
      url: `http://${FIXTURE_HOST}:${String(SEEDED_PORT_1024)}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "chromium-1440",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
        baseURL: `http://${FIXTURE_HOST}:${String(SEEDED_PORT_1440)}`,
      },
    },
    {
      name: "chromium-1024",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1024, height: 768 },
        baseURL: `http://${FIXTURE_HOST}:${String(SEEDED_PORT_1024)}`,
      },
    },
  ],
});
