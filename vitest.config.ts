import { configDefaults, defineConfig } from "vitest/config";

const gui = ["tests/integration/task33-driver.test.ts", "tests/integration/package-electron-real.test.ts"];
const profile = process.env.JARVIS_TEST_PROFILE ?? "backend";
const pattern = "*.{test,spec}.{ts,mts,cts,tsx,js,mjs,cjs,jsx}";
if (!["backend", "unit", "integration", "gui"].includes(profile)) throw new Error("TEST_PROFILE_INVALID");

export default defineConfig({ test: {
  fileParallelism: false,
  include: profile === "gui" ? gui : [profile === "backend" ? `tests/**/${pattern}` : `tests/${profile}/**/${pattern}`],
  exclude: [...configDefaults.exclude, "dashboard/**", "e2e/**", ".omo/**", ".runtime-tmp/**", ".chatgpt2codex/**",
    ...(profile === "gui" ? [] : gui)],
} });
