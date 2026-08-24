import { defineConfig } from "vitest/config";

// Root Vitest config: product test discovery is limited to tests/**.
// Research checkouts (.omo/**), the live runtime home (.jarvis-runtime/**),
// build output (dist/**), and separately-configured suites (dashboard/**,
// e2e/**) must never be collected by the root runner.
// Regression coverage: tests/integration/repository-hygiene.test.ts.
export default defineConfig({
  test: {
    testTimeout: 15_000,
    include: ["tests/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      ".omo/**",
      ".jarvis-runtime/**",
      "dist/**",
      "dashboard/**",
      "e2e/**",
    ],
  },
});
