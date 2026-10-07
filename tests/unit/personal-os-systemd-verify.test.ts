import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNIT_INVENTORY } from "../../src/personal-os-systemd.js";
import {
  nativeSystemdAnalyzeVerify,
  runNativeSystemdVerify,
} from "../../src/personal-os-systemd-verify.js";
import { personalOsScratch, removeScratch } from "../fixtures/personal-os-scratch.js";

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) removeScratch(root);
});

describe("personal-OS native systemd-analyze verify", () => {
  it("returns nonzero exit when a unit file is syntactically invalid", () => {
    // Given
    const root = personalOsScratch("jarvis-task36-unit-bad-");
    scratchRoots.push(root);
    const broken = join(root, "broken.service");
    writeFileSync(broken, "[Service]\nExecStart=\n");

    // When
    const result = nativeSystemdAnalyzeVerify([broken]);

    // Then
    expect(result.command).toEqual(["systemd-analyze", "verify", "--man=no", broken]);
    expect(result.exit).not.toBe(0);
  });

  it("verifies every freeze production and fixture unit with runtime skipped", () => {
    // Given
    const isolatedRoot = personalOsScratch("jarvis-task36-units-");
    scratchRoots.push(isolatedRoot);
    mkdirSync(join(isolatedRoot, "units"), { recursive: true });

    // When
    const receipt = runNativeSystemdVerify({
      worktree: process.cwd(),
      isolatedRoot,
    });

    // Then
    const inventory = [...UNIT_INVENTORY.jarvis, ...UNIT_INVENTORY.provider];
    expect(inventory).toHaveLength(15);
    expect(receipt.production_units_missing).toBe(0);
    expect(receipt.fixture_units_missing).toBe(0);
    expect(receipt.config_artifacts_missing).toBe(0);
    // systemd-analyze fails closed when the production node or sb binary is absent. CI is not that host.
    // Syntax is still checked on copies whose missing commands are /bin/true.
    let substituted = 0;
    const copies = [
      ...inventory.map(id => join(process.cwd(), "deploy", id)),
      ...readdirSync(join(isolatedRoot, "units")).map(name => join(isolatedRoot, "units", name)),
    ].map(path => {
      const text = readFileSync(path, "utf8").replace(/^(ExecStart(?:Pre)?=)(\S+)/gm, (line, prefix: string, command: string) => {
        if (existsSync(command)) return line;
        substituted += 1;
        return `${prefix}/bin/true`;
      });
      const destDir = join(isolatedRoot, path.includes(`${isolatedRoot}/units`) ? "syntax-fixture" : "syntax-production");
      mkdirSync(destDir, { recursive: true });
      const dest = join(destDir, basename(path));
      writeFileSync(dest, text);
      return dest;
    });
    const syntax = nativeSystemdAnalyzeVerify(copies);
    // ubuntu-26.04 verify also reports removed options in unrelated /usr/lib units. Those are not our files.
    const ownErrors = syntax.stderr.split("\n").filter(line => line.trim() !== "" && !line.startsWith("/usr/lib/systemd/"));
    expect(ownErrors).toEqual([]);
    if (substituted === 0) expect(receipt.native_verify_exit).toBe(0);
    expect(receipt.production_attempt_paths).toBe(0);
    expect(receipt.fixture_production_paths).toBe(0);
    expect(receipt.node_version).toBe("24.19.0");
    expect(receipt.node_abi).toBe("137");
    expect(receipt.SYSTEMD_RUNTIME_EXECUTED).toBe(0);
    expect(receipt.SYSTEMD_RUNTIME_STATE).toBe("SKIPPED_NOT_AUTHORIZED");
    expect(receipt.production_command[0]).toBe("systemd-analyze");
    expect(receipt.production_command[1]).toBe("verify");
    expect(receipt.production_command[2]).toBe("--man=no");
    expect(receipt.fixture_command[0]).toBe("systemd-analyze");
    expect(receipt.fixture_command[1]).toBe("verify");
    expect(receipt.fixture_command[2]).toBe("--man=no");
  });
});
