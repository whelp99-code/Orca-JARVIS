import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LifecycleManager } from "../../src/lifecycle-manager.js";
import { hashBytes } from "../../src/product-manifest.js";
import * as jawLife from "../../shells/cli-jaw/src/manager/lifecycle.js";
import { disableLegacy } from "../../shells/cli-jaw/src/manager/launchd-service.js";

describe("product lifecycle", () => {
  it("installs, updates, rolls back, and uninstalls with one owner and surviving user data", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-product-"));
    const life = new LifecycleManager({ root });
    const hashes = { jarvis: hashBytes("j"), protocol: hashBytes("1.0") };
    life.install("1.0.0", hashes);
    expect(life.doctor()).toMatchObject({ owner: "jarvis", version: "1.0.0", healthy: true });
    life.update("1.1.0", { ...hashes, jarvis: hashBytes("j2") });
    expect(life.current()).toBe("1.1.0");
    life.rollback("1.0.0");
    expect(life.current()).toBe("1.0.0");
    life.uninstall();
    expect(life.userData()).toBe("keep-me");
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/16/happy"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/16/happy/lifecycle.json"), `${JSON.stringify({
      owner: "jarvis", versions: ["1.0.0", "1.1.0", "1.0.0"], userData: "keep-me", node: process.versions.node,
    }, null, 2)}\n`);
  });

  it("refuses incompatible post-activation rollback, legacy owners, and CLI-JAW self-lifecycle", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-product-fail-"));
    const life = new LifecycleManager({ root });
    const hashes = { jarvis: hashBytes("j") };
    life.install("1.0.0", hashes, true);
    life.update("2.0.0", hashes, false);
    life.acceptWork();
    const codes: string[] = [];
    const capture = (fn: () => void) => {
      try { fn(); codes.push("UNEXPECTED"); } catch (error) { codes.push(error instanceof Error ? error.message : "unknown"); }
    };
    capture(() => life.rollback("1.0.0"));
    expect(life.current()).toBe("2.0.0");
    expect(life.userData()).toBe("keep-me");
    life.setLegacyOwner(true);
    capture(() => life.install("2.1.0", hashes));
    expect(jawLife.start()).toEqual({ status: "managed_by_jarvis" });
    expect(jawLife.restart()).toEqual({ status: "managed_by_jarvis" });
    expect(jawLife.permanent()).toEqual({ status: "managed_by_jarvis" });
    expect(disableLegacy("com.cli-jaw.legacy")).toEqual({ status: "managed_by_jarvis" });
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/16/failure"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/16/failure/refusals.json"), `${JSON.stringify({
      codes, current: life.current(), userData: life.userData(), managed: "managed_by_jarvis",
    }, null, 2)}\n`);
  });
});
