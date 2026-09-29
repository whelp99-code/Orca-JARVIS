import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["remote-approval.spec.ts", "remote-approval-page.spec.ts", "remote-approval-gateway-page.spec.ts", "phone-gateway-spa.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [["list"]],
  outputDir: process.env["JARVIS_REMOTE_OUTPUT_DIR"] ?? ".omo/evidence/task-35-remediation/playwright-output",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ignoreHTTPSErrors: true,
    launchOptions: {
      args: ["--host-resolver-rules=MAP jarvis-fixture.example.invalid 127.0.0.1"],
    },
  },
  projects: [
    {
      name: "remote-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
});
