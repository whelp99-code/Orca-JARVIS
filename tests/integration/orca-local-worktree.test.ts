import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JarvisControlServer, localTestApprover } from "../../src/control-server.js";
import { createOrcaManagedWorktree, removeOrcaManagedWorktree } from "../../src/control-methods/worktree.js";
import { future, initialized, localKey } from "../helpers.js";

const REPO = "Orca-JARVIS";

describe("local Orca walking skeleton", () => {
  it("creates and removes a child worktree through JARVIS without SSH or agent spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-orca-walk-"));
    const db = await initialized();
    const name = `jarvis-walk-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const server = new JarvisControlServer(db, "test-operator", args => createOrcaManagedWorktree(args));
    const staged = server.requestWorktree({
      ingressIdempotencyKey: `orca-walk-${name}`,
      repository: REPO,
      parentPath: dir,
      branch: name,
      name,
      requestedAt: new Date().toISOString(),
      expiresAt: future(10),
    });
    server.approve(staged.request_id, localTestApprover(localKey(db)));
    let path = "";
    try {
      const done = server.execute(staged.request_id);
      expect(done, JSON.stringify(done)).toMatchObject({ state: "completed" });
      const result = done.result as { path: string; created: boolean };
      path = result.path;
      expect(result.created).toBe(true);
      expect(path.length).toBeGreaterThan(1);
      mkdirSync(join(process.cwd(), ".omo/evidence/integration/05"), { recursive: true });
      writeFileSync(join(process.cwd(), ".omo/evidence/integration/05/live-local-orca.json"), `${JSON.stringify({
        ssh: false,
        agentSpawn: false,
        requestId: staged.request_id,
        path,
        created: result.created,
      }, null, 2)}\n`);
    } finally {
      if (path) {
        try { removeOrcaManagedWorktree(`path:${path}`); } catch { /* git fallback */ }
        spawnSync("git", ["-C", "/Volumes/DevSpace/Orca-JARVIS", "worktree", "remove", "--force", path], { encoding: "utf8" });
      }
    }
  }, 120_000);
});
