import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it.each([
  { name: "runtime cycle", a: 'import "./b.js";', b: 'export * from "./a.js";', exit: 1 },
  { name: "self cycle", a: 'import "./a.js";', b: 'export {};', exit: 1 },
  { name: "type-only reverse edge", a: 'import "./b.js"; export type A = string;',
    b: 'import type { A } from "./a.js"; export type B = A;', exit: 0 },
  { name: "shared dependency", a: 'import "./b.js"; export * from "./b.js";', b: 'export {};', exit: 0 },
])("checks $name through the real architecture CLI", fixture => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-import-graph-"));
  try {
    writeFileSync(join(root, "a.ts"), fixture.a);
    writeFileSync(join(root, "b.ts"), fixture.b);
    const child = spawnSync(process.execPath, [resolve("scripts/check-runtime-imports.mjs"), root],
      { encoding: "utf8", timeout: 10_000 });
    expect(child.status, child.stderr).toBe(fixture.exit);
    const result = JSON.parse(child.stdout);
    expect(result.ok).toBe(fixture.exit === 0);
    expect(result.modules).toBe(2);
    expect(result.cycles.length > 0).toBe(fixture.exit === 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
