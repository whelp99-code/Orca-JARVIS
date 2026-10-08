import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertRuntimePackageNoTestState, withRuntimePackageSmoke } from "../../scripts/lib/runtime-package-smoke.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-runtime-package-smoke-"));
  roots.push(root);
  const output = join(root, "package");
  mkdirSync(output);
  return { root, output };
}

describe("runtime package smoke isolation", () => {
  it.each([false, true])("keeps smoke files outside output and removes only scratch (failure=%s)", failure => {
    const { root, output } = fixture();
    const unrelated = join(root, "unrelated");
    mkdirSync(unrelated);
    let scratch;
    const smoke = () => withRuntimePackageSmoke(output, env => {
      scratch = env.TMPDIR;
      expect(dirname(scratch)).toBe(root);
      expect(scratch).not.toBe(output);
      expect(env.TMP).toBe(scratch);
      expect(env.TEMP).toBe(scratch);
      mkdirSync(join(scratch, "fixture"));
      for (const name of ["authority.sqlite", "authority.sqlite.policy-key.pem", "gjc.json"]) {
        writeFileSync(join(scratch, "fixture", name), "");
      }
      if (failure) throw new Error("SMOKE_FAILURE");
    }, { PATH: "fixture-path" });
    if (failure) expect(smoke).toThrow("SMOKE_FAILURE");
    else smoke();
    expect(existsSync(scratch)).toBe(false);
    expect(readdirSync(root).sort()).toEqual(["package", "unrelated"]);
    expect(() => assertRuntimePackageNoTestState(output)).not.toThrow();
  });
});

describe("runtime package test-state boundary", () => {
  it("accepts shipped code and metadata without test state", () => {
    const { output } = fixture();
    mkdirSync(join(output, "dist/src"), { recursive: true });
    writeFileSync(join(output, "dist/src/cli.js"), "");
    writeFileSync(join(output, "runtime-package-receipt.json"), "{}");
    expect(() => assertRuntimePackageNoTestState(output)).not.toThrow();
  });

  it.each(["smoke-state", "nested/authority.sqlite", "nested/authority.sqlite-wal",
    "nested/authority.sqlite-shm", "nested/authority.sqlite-journal", "nested/policy-key.pem",
    "nested/decision.pub.pem", "nested/gjc.json", "dist/.backend-build-lock.sqlite"])(
    "rejects %s anywhere in output without a build-lock exemption", name => {
      const { output } = fixture();
      const path = join(output, name);
      mkdirSync(dirname(path), { recursive: true });
      if (name === "smoke-state") mkdirSync(path);
      else writeFileSync(path, "");
      expect(() => assertRuntimePackageNoTestState(output)).toThrow("RUNTIME_PACKAGE_TEST_STATE_PRESENT");
    });

  it("rejects a state filename even when it is a symbolic link", () => {
    const { root, output } = fixture();
    const outside = join(root, "outside");
    writeFileSync(outside, "");
    symlinkSync(outside, join(output, "authority.sqlite"));
    expect(() => assertRuntimePackageNoTestState(output)).toThrow("RUNTIME_PACKAGE_TEST_STATE_PRESENT");
  });
});
