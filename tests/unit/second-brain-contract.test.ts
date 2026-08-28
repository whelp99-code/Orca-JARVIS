import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const fixture = "contracts/second-brain-mcp-v1.json";
const mismatch = "SECOND_BRAIN_CONTRACT_MISMATCH";

function run(path = fixture, source?: string) {
  const args = ["--experimental-strip-types", "src/second-brain-contract.ts", "--fixture", path];
  if (source !== undefined) args.push("--source", source);
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

function mutated(find: string, replacement: string): string {
  const root = mkdtempSync(join(tmpdir(), "second-brain-contract-"));
  const target = join(root, "contract.json");
  const text = readFileSync(fixture, "utf8");
  expect(text.includes(find)).toBe(true);
  const changed = text.replace(find, replacement);
  writeFileSync(target, changed);
  writeFileSync(`${target}.sha256`, `${createHash("sha256").update(changed).digest("hex")}\n`);
  return target;
}

function expectMismatch(path: string, source?: string): void {
  const result = run(path, source);
  expect(result.status).not.toBe(0);
  expect(result.stderr.trim()).toBe(mismatch);
}

describe("Second Brain contract consumer", () => {
  it("accepts the checked canonical generated fixture", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects schema version drift", () => {
    expectMismatch(mutated('"schema_version":1', '"schema_version":2'));
  });

  it("rejects exact tool-set drift", () => {
    expectMismatch(mutated('"sb_search":', '"sb_search_drift":'));
  });

  it("rejects missing required fields", () => {
    expectMismatch(mutated('"required":["query"]', '"required":[]'));
  });

  it("rejects extra fields", () => {
    expectMismatch(mutated('"schema_version":1', '"extra":true,"schema_version":1'));
  });

  it("rejects digest drift", () => {
    const root = mkdtempSync(join(tmpdir(), "second-brain-digest-"));
    const target = join(root, "contract.json");
    cpSync(fixture, target);
    writeFileSync(`${target}.sha256`, `${"0".repeat(64)}\n`);
    expectMismatch(target);
  });

  it("rejects source-copy divergence", () => {
    const source = mutated('"schema_version":1', '"schema_version":2');
    expectMismatch(fixture, source);
  });

  it("rejects collision-contract drift", () => {
    expectMismatch(mutated("non_idempotent_collision_safe_no_overwrite", "idempotent"));
  });

  it("syncs only through the checked script", () => {
    const root = mkdtempSync(join(tmpdir(), "second-brain-sync-"));
    const source = join(root, "second-brain-mcp-v1.json");
    cpSync(fixture, source);
    cpSync(`${fixture}.sha256`, `${source}.sha256`);
    const result = spawnSync(process.execPath, ["scripts/sync-second-brain-contract.mjs", "--check", "--source", source], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
  });
});
