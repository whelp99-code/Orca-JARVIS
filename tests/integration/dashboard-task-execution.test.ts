import { access, chmod, link, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { request } from "undici";
import { describe, expect, it, vi } from "vitest";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { prepareDashboardTaskExecution, stageDashboardTaskExecution } from "../../src/dashboard/task-execution-service.js";
import { readDashboardTaskExecution } from "../../src/dashboard/task-execution-read.js";
import { TaskPublicationGit } from "../../src/task-publication-git.js";
import { PinnedDirectory } from "../../src/task-workspace-directory.js";
import { JarvisError } from "../../src/db.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { approvedTaskFixture } from "../fixtures/approved-task-fixture.js";
import { spawnSync } from "node:child_process";

type Fixture = Awaited<ReturnType<typeof approvedTaskFixture>>;
const preparation = (f: Fixture) => ({ schema_version: 1, run_id: f.plan.run_id, provider: "claude",
  repository_root: f.root, publication_ref: f.plan.publication.ref, limits: f.plan.limits,
  verification: f.plan.verification, files: f.plan.files.map(file => ({ path: file.path, access: file.access, exists: true })) });
const changes = (f: Fixture) => f.db.db.prepare("SELECT total_changes() AS n").get();

describe("dashboard task plan preparation", () => {
  it("blocks a quarantined task identity before reading or preparing its execution", async () => {
    const f = await approvedTaskFixture(true, { stage: false });
    try {
      new MemoryProjectionAuthority(f.db).quarantineUnresolved({ kind: "task_timeline", id: "task", component_id: "task" }, f.clock());
      const before = changes(f);
      expect(() => readDashboardTaskExecution(f.db, "task", f.clock())).toThrow("TASK_NOT_FOUND");
      await expect(prepareDashboardTaskExecution(f.db, "task", preparation(f), f.clock)).rejects.toThrow("TASK_EXECUTION_SOURCE_SUPPRESSED");
      expect(changes(f)).toEqual(before);
      expect(f.generate).not.toHaveBeenCalled(); expect(f.runtime.checkReady).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it("derives the reviewed plan without DB, index, ref or provider changes; stages once", async () => {
    const f = await approvedTaskFixture(true, { stage: false });
    try {
      const before = changes(f); const status = f.git(["status", "--porcelain=v1"]);
      const preview = await prepareDashboardTaskExecution(f.db, "task", preparation(f), f.clock);
      expect(preview.plan).toEqual(f.plan);
      expect(preview.repository.total_bytes).toBe(Buffer.byteLength(f.source + f.check));
      expect(JSON.stringify(preview)).not.toContain(f.source);
      expect(changes(f)).toEqual(before);
      expect(f.git(["status", "--porcelain=v1"])).toEqual(status);
      expect(f.git(["for-each-ref", "--format=%(refname)"])).not.toContain(f.plan.publication.ref);
      const body = { schema_version: 1, request_id: "ui-execute", nonce: "ui-nonce", plan: preview.plan };
      const staged = await stageDashboardTaskExecution(f.db, "task", body, f.clock);
      expect(staged).toMatchObject({ action: "task.execute", action_level: 3, state: "pending", args: { plan: f.plan } });
      const after = changes(f);
      expect(await stageDashboardTaskExecution(f.db, "task", body, f.clock)).toEqual(staged);
      expect(changes(f)).toEqual(after);
      expect(f.generate).not.toHaveBeenCalled(); expect(f.runtime.checkReady).not.toHaveBeenCalled();
      expect(readDashboardTaskExecution(f.db, "task").requests).toMatchObject([{ request: { state: "pending" }, completion: null }]);
    } finally { await f.cleanup(); }
  });

  it.each(["dirty", "mode", "symlink", "hardlink", "missing", "directory"])("rejects %s selected inputs", async kind => {
    const f = await approvedTaskFixture(true, { stage: false });
    try {
      const file = join(f.root, "answer.mjs");
      if (kind === "dirty") await writeFile(file, "uncommitted private content");
      if (kind === "mode") await chmod(file, 0o755);
      if (["symlink", "hardlink", "missing", "directory"].includes(kind)) await unlink(file);
      if (kind === "symlink") await symlink(join(f.root, "unrelated.txt"), file);
      if (kind === "hardlink") await link(join(f.root, "unrelated.txt"), file);
      if (kind === "directory") await mkdir(file);
      const before = changes(f);
      await expect(prepareDashboardTaskExecution(f.db, "task", preparation(f), f.clock)).rejects.toThrow();
      expect(changes(f)).toEqual(before); expect(f.generate).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it("supports explicitly absent new files and rejects an untracked existing replacement", async () => {
    const f = await approvedTaskFixture(true, { stage: false });
    try {
      const body = preparation(f); body.files.push({ path: "new/fix.mjs", access: "write", exists: false });
      const preview = await prepareDashboardTaskExecution(f.db, "task", body, f.clock);
      expect(preview.plan.files.at(-1)).toEqual({ path: "new/fix.mjs", access: "write", before_digest: null });
      await mkdir(join(f.root, "new")); await writeFile(join(f.root, "new/fix.mjs"), "keep");
      await expect(prepareDashboardTaskExecution(f.db, "task", body, f.clock)).rejects.toThrow("TASK_REPOSITORY_FILE_CHANGED");
    } finally { await f.cleanup(); }
  });

  it.each(["task", "run", "provider", "path", "extra", "new-read", "cancelled", "unapproved"])("rejects %s before Git access", async kind => {
    const f = await approvedTaskFixture(true, { stage: false, approvedStart: kind !== "unapproved" });
    const open = vi.spyOn(TaskPublicationGit, "open");
    try {
      const body: any = preparation(f);
      if (kind === "run") body.run_id = "absent";
      if (kind === "provider") body.provider = "codex";
      if (kind === "path") body.files[0].path = "../private";
      if (kind === "extra") body.files[0].before_digest = "forged";
      if (kind === "new-read") { body.files[1].exists = false; }
      if (kind === "cancelled") f.db.db.prepare("UPDATE workflow_runs SET state='cancelled' WHERE run_id='run'").run();
      const before = changes(f);
      await expect(prepareDashboardTaskExecution(f.db, kind === "task" ? "wrong" : "task", body, f.clock)).rejects.toThrow();
      expect(open).not.toHaveBeenCalled(); expect(changes(f)).toEqual(before);
    } finally { open.mockRestore(); await f.cleanup(); }
  });

  it("rejects preview substitution after HEAD changes and a cancelled workflow during preparation", async () => {
    const f = await approvedTaskFixture(true, { stage: false });
    try {
      const preview = await prepareDashboardTaskExecution(f.db, "task", preparation(f), f.clock);
      await writeFile(join(f.root, "unrelated.txt"), "next baseline");
      f.git(["add", "unrelated.txt"]); f.git(["-c", "commit.gpgsign=false", "commit", "-qm", "new baseline"]);
      await expect(stageDashboardTaskExecution(f.db, "task", { schema_version: 1, request_id: "new", nonce: "nonce",
        plan: preview.plan }, f.clock)).rejects.toThrow("TASK_EXECUTION_PREVIEW_STALE");
      const original = TaskPublicationGit.open;
      const open = vi.spyOn(TaskPublicationGit, "open").mockImplementation(async (...args) => {
        const git = await original(...args);
        f.db.db.prepare("UPDATE workflow_runs SET state='cancelled' WHERE run_id='run'").run();
        return git;
      });
      try { await expect(prepareDashboardTaskExecution(f.db, "task", preparation(f), f.clock)).rejects.toThrow("TASK_EXECUTION_WORKFLOW_NOT_READY"); }
      finally { open.mockRestore(); }
      expect(f.generate).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });

  it("keeps the read-only Git allowlist closed to mutations and command substitution", async () => {
    const f = await approvedTaskFixture(true, { stage: false });
    const git = await TaskPublicationGit.open(f.root, () => 10000, f.now.toISOString(), true);
    try {
      for (const args of [["update-ref", f.plan.publication.ref, f.plan.repository.baseline_commit],
        ["cat-file", "--batch"], ["cat-file", "blob", "HEAD:answer.mjs"], ["rev-parse", "--verify", "HEAD", "--git-dir"]]) {
        await expect(git.run(args)).rejects.toThrow("TASK_PUBLICATION_READ_ONLY");
      }
      await expect(git.run(["rev-parse", "--verify", "HEAD"], Buffer.from("input"))).rejects.toThrow("TASK_PUBLICATION_READ_ONLY");
    } finally { await git.close(); await f.cleanup(); }
  });

  it("does not execute a Git wrapper from the host PATH while preparing or staging", async () => {
    const f = await approvedTaskFixture(true, { stage: false });
    const prior = process.env.PATH;
    try {
      const bin = join(f.root, "bin"); await mkdir(bin);
      const marker = join(f.root, "wrapper-called");
      await writeFile(join(bin, "git"), `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\n`
        + `writeFileSync(${JSON.stringify(marker)}, 'unexpected');process.exit(71);\n`, { mode: 0o700 });
      process.env.PATH = `${bin}:/usr/bin:/bin`;
      const preview = await prepareDashboardTaskExecution(f.db, "task", preparation(f), f.clock);
      await stageDashboardTaskExecution(f.db, "task", { schema_version: 1, request_id: "safe-path", nonce: "safe-nonce", plan: preview.plan }, f.clock);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { if (prior === undefined) delete process.env.PATH; else process.env.PATH = prior; await f.cleanup(); }
  });

  it("rechecks the workflow budget between file reads and rejects repository subdirectories", async () => {
    const f = await approvedTaskFixture(true, { stage: false });
    try {
      await mkdir(join(f.root, "subdir"));
      await expect(prepareDashboardTaskExecution(f.db, "task", { ...preparation(f), repository_root: join(f.root, "subdir") }, f.clock))
        .rejects.toThrow("TASK_PUBLICATION_GIT_IDENTITY_INVALID");
      const original = PinnedDirectory.prototype.read;
      const read = vi.spyOn(PinnedDirectory.prototype, "read").mockImplementation(async function(this: PinnedDirectory, file) {
        const result = await original.call(this, file);
        f.setNow(new Date(f.workflow.budget.deadline));
        return result;
      });
      try {
        await expect(prepareDashboardTaskExecution(f.db, "task", preparation(f), f.clock)).rejects.toThrow("TASK_EXECUTION_BUDGET_EXHAUSTED");
        expect(read).toHaveBeenCalledTimes(1);
      } finally { read.mockRestore(); }
    } finally { await f.cleanup(); }
  });

  it("rejects a preview whose expanded digest manifest could not fit a staging request", async () => {
    const f = await approvedTaskFixture(true, { stage: false });
    try {
      const prefix = "p".repeat(180); await mkdir(join(f.root, prefix));
      const body = preparation(f);
      for (let i = 0; i < 126; i++) {
        const path = `${prefix}/${"f".repeat(200)}-${i}.txt`;
        await writeFile(join(f.root, path), "x"); body.files.push({ path, access: "read", exists: true });
      }
      f.git(["add", "--", prefix]); f.git(["-c", "commit.gpgsign=false", "commit", "-qm", "long paths"]);
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(64 * 1024);
      const before = changes(f);
      await expect(prepareDashboardTaskExecution(f.db, "task", body, f.clock)).rejects.toThrow("TASK_EXECUTION_PLAN_TOO_LARGE");
      expect(changes(f)).toEqual(before); expect(f.generate).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  }, 30000);

  it("rejects an existing result ref and enforces blob and aggregate input limits", async () => {
    const f = await approvedTaskFixture(true, { stage: false });
    try {
      f.git(["update-ref", f.plan.publication.ref, f.plan.repository.baseline_commit]);
      await expect(prepareDashboardTaskExecution(f.db, "task", preparation(f), f.clock)).rejects.toThrow("TASK_PUBLICATION_REF_EXISTS");
      f.git(["update-ref", "-d", f.plan.publication.ref]);
      await writeFile(join(f.root, "answer.mjs"), Buffer.alloc(4 * 1024 * 1024 + 1));
      f.git(["add", "answer.mjs"]); f.git(["-c", "commit.gpgsign=false", "commit", "-qm", "oversize"]);
      await expect(prepareDashboardTaskExecution(f.db, "task", preparation(f), f.clock)).rejects.toThrow("TASK_PUBLICATION_GIT_OUTPUT_LIMIT");
      await writeFile(join(f.root, "answer.mjs"), f.source);
      const body = preparation(f);
      for (let i = 0; i < 5; i++) {
        const path = `large-${i}.txt`; await writeFile(join(f.root, path), Buffer.alloc(4 * 1024 * 1024));
        body.files.push({ path, access: "read", exists: true });
      }
      f.git(["add", "."]); f.git(["-c", "commit.gpgsign=false", "commit", "-qm", "aggregate"]);
      await expect(prepareDashboardTaskExecution(f.db, "task", body, f.clock)).rejects.toThrow("TASK_REPOSITORY_INPUT_OVERSIZE");
      expect(f.generate).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
});

describe("task execution HTTP journey", () => {
  it("blocks cloning a failed task execution from the generic retry endpoint", async () => {
    const f = await approvedTaskFixture(false);
    const server = createDashboardServer({ db: f.db, staticRoot: resolve("dist/dashboard"), host: "127.0.0.1", port: 0,
      clock: f.clock, executorFactory: () => f.executor });
    const origin = `http://${server.address.host}:${server.address.port}`;
    try {
      expect((await f.executor.execute("execute", "fixture", f.clock())).state).toBe("failed");
      const session = await request(`${origin}/api/v1/session`);
      const csrf = (await session.body.json() as { csrf_token: string }).csrf_token;
      const approvals = await request(`${origin}/api/v1/control/requests`);
      expect((await approvals.body.json() as { items: unknown[] }).items).toContainEqual(expect.objectContaining({
        request_id: "execute", task_id: "task", state: "failed", retry_status: "not_allowed" }));
      const before = changes(f);
      const retry = await request(`${origin}/api/v1/control/requests/execute/retry`, { method: "POST",
        headers: { origin, "content-type": "application/json", "x-jarvis-csrf": csrf },
        body: JSON.stringify({ schema_version: 1, request_id: "duplicate", nonce: "duplicate-nonce" }) });
      expect(retry.statusCode).toBe(409);
      expect(await retry.body.json()).toMatchObject({ error: { code: "RETRY_NOT_ALLOWED" } });
      expect(changes(f)).toEqual(before); expect(f.generate).toHaveBeenCalledTimes(1);
    } finally { await server.drain(); server.close(); await f.cleanup(); }
  });

  it("requires Origin/CSRF, prepares and stages, executes only after approval, restores durable completion", async () => {
    const f = await approvedTaskFixture(true, { stage: false });
    const server = createDashboardServer({ db: f.db, staticRoot: resolve("dist/dashboard"), host: "127.0.0.1", port: 0,
      clock: f.clock, executorFactory: () => f.executor });
    const origin = `http://${server.address.host}:${server.address.port}`;
    const session = await request(`${origin}/api/v1/session`);
    const csrf = (await session.body.json() as { csrf_token: string }).csrf_token;
    const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const response = await request(`${origin}${path}`, { method: "POST", headers: { origin,
        "content-type": "application/json", "x-jarvis-csrf": csrf, ...headers }, body: JSON.stringify(body) });
      return { status: response.statusCode, body: await response.body.json() as any };
    };
    const path = "/api/v1/tasks/task/execution";
    try {
      const before = changes(f);
      expect((await post(`${path}/prepare`, preparation(f), { origin: "http://evil.invalid" })).status).toBe(403);
      expect((await post(`${path}/prepare`, preparation(f), { "x-jarvis-csrf": "wrong" })).status).toBe(403);
      const denied = await request(`${origin}${path}`); expect(denied.statusCode).toBe(403); await denied.body.dump();
      expect(changes(f)).toEqual(before);
      const prepared = await post(`${path}/prepare`, preparation(f)); expect(prepared.status).toBe(200);
      const previousProviderPath = process.env.JARVIS_TASK_CLAUDE_PATH;
      try {
        process.env.JARVIS_TASK_CLAUDE_PATH = "";
        const checked = await post(`${path}/check`, { schema_version: 1, plan: prepared.body.plan });
        expect(checked).toMatchObject({ status: 200, body: { execution_available: false,
          readiness: { authentication: "not_probed", reason_code: "TASK_EXECUTION_NOT_CONFIGURED" } } });
        expect(changes(f)).toEqual(before);
        expect((await post("/api/v1/tasks/wrong/execution/check", { schema_version: 1, plan: prepared.body.plan })).status).toBe(400);
      } finally {
        if (previousProviderPath === undefined) delete process.env.JARVIS_TASK_CLAUDE_PATH;
        else process.env.JARVIS_TASK_CLAUDE_PATH = previousProviderPath;
      }
      const staged = await post(`${path}/stage`, { schema_version: 1, request_id: "ui-execute", nonce: "ui-nonce", plan: prepared.body.plan });
      expect(staged.status).toBe(202); expect(staged.body.request.state).toBe("pending");
      const approvals = await request(`${origin}/api/v1/control/requests`);
      expect((await approvals.body.json() as { items: unknown[] }).items)
        .toContainEqual(expect.objectContaining({ request_id: "ui-execute", task_id: "task", action: "task.execute" }));
      const execute = "/api/v1/control/requests/ui-execute/execute";
      expect((await post(execute, { schema_version: 1 })).status).toBe(403);
      expect(f.generate).not.toHaveBeenCalled();
      f.approve(staged.body.request);
      f.runtime.checkReady.mockRejectedValueOnce(new JarvisError("TASK_SANDBOX_UNAVAILABLE"));
      expect(await post(execute, { schema_version: 1 })).toMatchObject({ status: 409, body: { error: { code: "TASK_SANDBOX_UNAVAILABLE" } } });
      expect(f.generate).not.toHaveBeenCalled(); expect(f.control.get("ui-execute")?.state).toBe("approved");
      const result = await post(execute, { schema_version: 1 });
      expect(result).toMatchObject({ status: 200, body: { execution: { request_id: "ui-execute", state: "completed" } } });
      const writes = changes(f);
      const refreshed = await request(`${origin}${path}`, { headers: { "x-jarvis-csrf": csrf } });
      expect(refreshed.statusCode).toBe(200); expect(refreshed.headers["cache-control"]).toBe("no-store");
      const detail: any = await refreshed.body.json();
      expect(detail.requests[0].completion).toMatchObject({ state: "completed", request_id: "ui-execute", ref: f.plan.publication.ref });
      expect(f.git(["rev-parse", f.plan.publication.ref])).toBe(detail.requests[0].completion.commit);
      expect(f.git(["rev-parse", "HEAD"])).toBe(f.plan.repository.baseline_commit);
      expect(f.generate).toHaveBeenCalledTimes(1); expect(changes(f)).toEqual(writes);
      expect(readDashboardTaskExecution(f.db, "task")).toEqual(detail);
      f.db.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
        .run(detail.requests[0].completion.verification_id, "withdraw fixture evidence", f.clock().toISOString());
      const afterRevocation = changes(f);
      const revoked = await request(`${origin}${path}`, { headers: { "x-jarvis-csrf": csrf } });
      expect(revoked.statusCode).toBe(409);
      expect(await revoked.body.json()).toMatchObject({ error: { code: "TASK_COMPLETION_INVALID" } });
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import { AuthorityDb } from './dist/src/db.js';
        import { createDashboardServer } from './dist/src/dashboard/server.js';
        const db = new AuthorityDb(process.argv[1]);
        const server = createDashboardServer({ db, host: '127.0.0.1', port: 0, staticRoot: process.argv[2] });
        try {
          const origin = 'http://127.0.0.1:' + server.address.port;
          const session = await (await fetch(origin + '/api/v1/session', { headers: { connection: 'close' } })).json();
          const result = await fetch(origin + '/api/v1/tasks/task/execution',
            { headers: { 'x-jarvis-csrf': session.csrf_token, connection: 'close' } });
          const body = await result.json();
          process.stdout.write(JSON.stringify({ status: result.status, code: body.error?.code }));
        } finally { server.close(); await server.drain(); db.close(); }
      `, f.db.filename, f.root], { encoding: "utf8", timeout: 10000 });
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ status: 409, code: "TASK_COMPLETION_INVALID" });
      expect(f.generate).toHaveBeenCalledTimes(1);
      expect(changes(f)).toEqual(afterRevocation);
    } finally { await server.close(); await f.cleanup(); }
  }, 30000);
});
