import { defineConfig, devices } from "@playwright/test";

/**
 * Task 32 Memory surface specs. Each spec launches its own in-repo fixture
 * (`tests/fixtures/memory-surface-fixture.ts`) on ephemeral loopback ports, so this config has no
 * shared webServer and never touches the seeded/production ports. Build first: `npm run build`.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: /task32-memory.*\.spec\.ts/u,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [["list"]],
  outputDir: process.env["TASK32_OUTPUT_DIR"] ?? "test-results/task32",
  use: {
    trace: "on",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "memory-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
  ],
});
