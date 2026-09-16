import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveClaudeTaskExecutable } from "../../src/claude-task-host.js";
import { resolveDeploymentRoots } from "../../src/personal-os-deployment-roots.js";
import { renderSystemdUnit } from "../../src/personal-os-systemd.js";
import { productionRoots } from "../../src/personal-os-systemd-roots.js";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * Gap G3 of the jarvis-svc cutover: the task executor was pinned at
 * `/home/jm/.local/share/claude/versions/<version>` inside a 0750 home, so the service account
 * could not execute it and the runbook omitted the variable rather than widening an ACL over the
 * user's `.local/share`. The executor is now a deployment root defaulting under the bin root; the
 * loader has to accept a copy installed there at 0755 owned by the service account.
 */
describe("task executor under the deployment bin root", () => {
  it("resolves the rendered bin-root executor and refuses a world-writable copy", async () => {
    // Given
    const root = mkdtempSync(join(tmpdir(), "jarvis-bin-root-"));
    scratch.push(root);
    const binRoot = join(root, "bin");
    mkdirSync(binRoot, { mode: 0o755 });
    const environment = {
      JARVIS_STATE_ROOT: join(root, "state"),
      JARVIS_BIN_ROOT: binRoot,
      JARVIS_NODE_BIN: join(binRoot, "node"),
      JARVIS_SERVICE_USER: "jarvis-svc",
    };
    const roots = resolveDeploymentRoots(environment);
    expect(roots.taskClaudePath).toBe(join(binRoot, "claude"));
    // What the operator step in the rendered README installs: a plain 0755 file in the bin root.
    writeFileSync(roots.taskClaudePath!, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(roots.taskClaudePath!, 0o755);

    // When
    const resolved = await resolveClaudeTaskExecutable(roots.taskClaudePath!);

    // Then
    expect(resolved).toBe(roots.taskClaudePath);
    // The drop-in the generator writes names exactly the path the loader just accepted.
    expect(renderSystemdUnit({
      id: "jm-jarvis.service.d/20-task-executor.conf",
      mode: "production",
      roots: productionRoots(environment),
    })).toContain(`Environment=JARVIS_TASK_CLAUDE_PATH=${roots.taskClaudePath}`);
    // 0755 is the loosest mode that resolves: the loader still refuses group or other write, so an
    // operator who copies the binary with a slack umask is told, not silently trusted.
    chmodSync(roots.taskClaudePath!, 0o757);
    await expect(resolveClaudeTaskExecutable(roots.taskClaudePath!))
      .rejects.toThrow("TASK_PROVIDER_UNAVAILABLE");
  });

  it("refuses a bin root that holds a directory where the executable belongs", async () => {
    // Given
    const root = mkdtempSync(join(tmpdir(), "jarvis-bin-root-"));
    scratch.push(root);
    const binRoot = join(root, "bin");
    mkdirSync(join(binRoot, "claude"), { recursive: true, mode: 0o755 });

    // When / Then
    // The executor ships as one file; a copied *directory* is the likely operator slip, and it must
    // fail closed rather than have the authority spawn a directory.
    await expect(resolveClaudeTaskExecutable(join(binRoot, "claude")))
      .rejects.toThrow("TASK_PROVIDER_UNAVAILABLE");
  });
});
