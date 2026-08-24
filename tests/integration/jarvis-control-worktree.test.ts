import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeControlFrame } from "../../src/control-protocol-codec.js";
import { JarvisControlServer, commandIntentFromWorktree, localTestApprover, worktreeIntentFromCommand, type WorktreeIntent } from "../../src/control-server.js";
import { JarvisControlClient } from "../../shells/cli-jaw/src/jarvis/client.js";
import { JarvisWorktreeAdapter } from "../../shells/cli-jaw/src/jarvis/worktree-adapter.js";
import { future, initialized, localKey } from "../helpers.js";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function fixtureRepo(): { repo: string; parent: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "jarvis-wt-skel-"));
  const repo = join(root, "repo");
  const parent = join(root, "trees");
  mkdirSync(repo);
  mkdirSync(parent);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "wt@example.com"]);
  git(repo, ["config", "user.name", "Worktree Fixture"]);
  git(repo, ["commit", "--allow-empty", "-m", "init"]);
  return { repo, parent, root };
}

function intent(repo: string, parent: string, name = "child", key = "ingress-1"): WorktreeIntent {
  return {
    ingressIdempotencyKey: key,
    repository: repo,
    parentPath: parent,
    branch: `feat/${name}`,
    name,
    requestedAt: new Date().toISOString(),
    expiresAt: future(10),
  };
}

describe("jarvis-control worktree walking skeleton", () => {
  it("creates exactly one worktree after local digest approval", async () => {
    const { repo, parent, root } = fixtureRepo();
    const db = await initialized();
    const server = new JarvisControlServer(db);
    const adapter = new JarvisWorktreeAdapter(new JarvisControlClient(frame => {
      const requested = worktreeIntentFromCommand(JSON.parse(frame).payload);
      const staged = server.requestWorktree(requested);
      return encodeControlFrame({
        protocol: "jarvis-control",
        version: "1.0",
        id: "res-1",
        traceId: "trace-1",
        generation: "gen-1",
        sentAt: "2026-08-23T12:00:00.100Z",
        type: "response",
        replyTo: JSON.parse(frame).id,
        ok: true,
        payload: staged,
      });
    }));
    const requested = intent(repo, parent);
    const frame = adapter.requestCreate(requested);
    expect(frame.type).toBe("response");
    if (frame.type !== "response" || !frame.ok) throw new Error("expected ok response");
    const staged = frame.payload as { request_id: string; command_digest: string; replayed: boolean };
    expect(staged.command_digest.startsWith("sha256:")).toBe(true);
    expect(existsSync(join(parent, "child"))).toBe(false);
    server.approve(staged.request_id, localTestApprover(localKey(db)));
    const done = server.execute(staged.request_id);
    expect(done.state).toBe("completed");
    expect(existsSync(join(parent, "child", ".git"))).toBe(true);
    expect(readdirSync(parent)).toEqual(["child"]);
    const replay = server.requestWorktree(requested);
    expect(replay).toMatchObject({ request_id: staged.request_id, replayed: true, state: "completed" });
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/05/happy"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/05/happy/transcript.json"), `${JSON.stringify({ staged, done, path: join(parent, "child"), worktrees: readdirSync(parent) }, null, 2)}\n`);
    db.close();
    void root;
  });

  it("refuses injection, ingress mutation, forged approval, and does not double-create after crash", async () => {
    const { repo, parent } = fixtureRepo();
    const db = await initialized();
    const server = new JarvisControlServer(db);
    const requested = intent(repo, parent, "safe", "ingress-safe");
    expect(() => worktreeIntentFromCommand({
      ...commandIntentFromWorktree(requested),
      args: { ...commandIntentFromWorktree(requested).args, trustTier: 4 },
    })).toThrow("CONTROL_AUTHORITY_FIELD_INJECTED");
    const first = server.requestWorktree(requested);
    expect(() => server.requestWorktree({ ...requested, name: "other" })).toThrow("CONTROL_INGRESS_CONFLICT");
    expect(() => server.approve(first.request_id, staged => localTestApprover(localKey(db))({ ...staged, command_digest: "sha256:dead" }))).toThrow();
    expect(existsSync(join(parent, "safe"))).toBe(false);
    server.approve(first.request_id, localTestApprover(localKey(db)));
    const claimed = server.claimApproved(first.request_id, "crashed-worker");
    expect(claimed.fence).toBe(1);
    expect(existsSync(join(parent, "safe"))).toBe(false);
    const recovered = server.recover(first.request_id);
    expect(recovered.state).toBe("uncertain");
    expect(existsSync(join(parent, "safe"))).toBe(false);
    const counts = {
      requests: Number((db.db.prepare("SELECT COUNT(*) AS count FROM control_command_requests").get() as { count: number }).count),
      ingress: Number((db.db.prepare("SELECT COUNT(*) AS count FROM control_ingress_requests").get() as { count: number }).count),
      worktrees: readdirSync(parent).length,
    };
    expect(counts).toEqual({ requests: 1, ingress: 1, worktrees: 0 });
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/05/failure"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/05/failure/counts.json"), `${JSON.stringify({ counts, recovered }, null, 2)}\n`);
    db.close();
  });
});
