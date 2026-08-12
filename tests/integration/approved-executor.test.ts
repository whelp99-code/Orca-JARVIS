import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovedCommandExecutor, ControlPlane, signCommandApproval, type CommandApprovalReceipt, type ControlCommandRequestInput } from "../../src/index.js";
import { future, initialized, localKey } from "../helpers.js";

const request = (id: string, action: string, level: 0 | 1 | 2 | 3 | 4 | 5, args: Record<string, unknown>): ControlCommandRequestInput => ({ schema_version: 1, request_id: id, action, action_level: level, target: { environment: "local" }, args, reversible: true, requested_by: "operator", requested_at: new Date().toISOString(), expires_at: future(10), nonce: `nonce-${id}` });
const approve = (db: Awaited<ReturnType<typeof initialized>>, control: ControlPlane, input: ControlCommandRequestInput): string => { const staged = control.stage(input); const now = new Date().toISOString(); const receipt: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1, receipt_id: `approval-${input.request_id}`, request_id: input.request_id, decision: "approve", command_digest: staged.command_digest, signer_principal_id: "test-operator", authenticated_session_id: "action-hub", key_id: "decision-test", algorithm: "Ed25519", issued_at: now, not_before: now, expires_at: input.expires_at, nonce: `approval-nonce-${input.request_id}`, max_uses: 1, status: "issued" }; control.decide(signCommandApproval(receipt, localKey(db))); return input.request_id; };
const dispose = (db: Awaited<ReturnType<typeof initialized>>, root: string): void => { db.close(); rmSync(root, { recursive: true, force: true }); rmSync(dirname(db.filename), { recursive: true, force: true }); };

describe("approved built-in executor", () => {
  it("backs up, restore-checks, and projects state only after human approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-approved-")); const backupRoot = join(root, "backups"); const stateRoot = join(root, "state");
    const db = await initialized(); const control = new ControlPlane(db); const executor = new ApprovedCommandExecutor(db, backupRoot, stateRoot);
    const backup = approve(db, control, request("backup-1", "database.backup", 2, { destination: "snapshot.sqlite" }));
    await expect(executor.execute(backup)).resolves.toMatchObject({ state: "completed", action: "database.backup" }); expect(existsSync(join(backupRoot, "snapshot.sqlite"))).toBe(true);
    const drill = approve(db, control, request("restore-1", "database.restore_drill", 1, { source: "snapshot.sqlite" }));
    await expect(executor.execute(drill)).resolves.toMatchObject({ state: "completed", result: { quick_check: "ok", migrations_ready: true } });
    const projection = approve(db, control, request("project-1", "state.project", 1, {}));
    const projected = await executor.execute(projection); expect(projected).toMatchObject({ state: "completed" });
    const output = projected.result as { json: string; markdown: string };
    expect(existsSync(output.json)).toBe(true); expect(existsSync(output.markdown)).toBe(true); expect(JSON.parse(readFileSync(output.json, "utf8"))).toMatchObject({ schema_version: 1, now: { doctor_ok: true } });
    expect((db.db.prepare("SELECT COUNT(*) AS count FROM control_command_effects").get() as { count: number }).count).toBe(3); db.close();
  });

  it("consumes approval and records a failed effect for unknown or under-level actions", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-approved-fail-")); const db = await initialized(); const control = new ControlPlane(db); const executor = new ApprovedCommandExecutor(db, join(root, "backups"), join(root, "state"));
    const id = approve(db, control, request("under-level", "database.backup", 1, { destination: "x.sqlite" }));
    await expect(executor.execute(id)).resolves.toMatchObject({ state: "failed", failure_code: "APPROVED_ACTION_LEVEL_TOO_LOW" }); expect(control.list()[0]).toMatchObject({ state: "failed" }); db.close();
  });

  it("replaces a backup destination symlink without touching its target", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-backup-destination-link-")); const backupRoot = join(root, "backups"); const outside = join(root, "outside.txt");
    const db = await initialized(); const control = new ControlPlane(db);
    try {
      mkdirSync(backupRoot); writeFileSync(outside, "sentinel\n"); const destination = join(backupRoot, "snapshot.sqlite"); symlinkSync(outside, destination);
      const id = approve(db, control, request("backup-destination-link", "database.backup", 2, { destination: "snapshot.sqlite" }));
      await expect(new ApprovedCommandExecutor(db, backupRoot, join(root, "state")).execute(id)).resolves.toMatchObject({ state: "completed" });
      expect(readFileSync(outside, "utf8")).toBe("sentinel\n");
      expect(lstatSync(destination).isSymbolicLink()).toBe(false);
      expect(lstatSync(destination).isFile()).toBe(true);
    } finally { dispose(db, root); }
  });

  it("refuses a symlinked backup root", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-backup-root-link-")); const outside = join(root, "outside"); const backupRoot = join(root, "backups");
    const db = await initialized(); const control = new ControlPlane(db);
    try {
      mkdirSync(outside); symlinkSync(outside, backupRoot);
      const id = approve(db, control, request("backup-root-link", "database.backup", 2, { destination: "snapshot.sqlite" }));
      await expect(new ApprovedCommandExecutor(db, backupRoot, join(root, "state")).execute(id)).resolves.toMatchObject({ state: "failed" });
      expect(existsSync(join(outside, "snapshot.sqlite"))).toBe(false);
    } finally { dispose(db, root); }
  });

  it("refuses a restore source symlink even when it points to a valid database", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-restore-source-link-")); const backupRoot = join(root, "backups"); const outside = join(root, "outside.sqlite");
    const db = await initialized(); const control = new ControlPlane(db);
    try {
      mkdirSync(backupRoot); await db.db.backup(outside); symlinkSync(outside, join(backupRoot, "snapshot.sqlite"));
      const id = approve(db, control, request("restore-source-link", "database.restore_drill", 1, { source: "snapshot.sqlite" }));
      await expect(new ApprovedCommandExecutor(db, backupRoot, join(root, "state")).execute(id)).resolves.toMatchObject({ state: "failed" });
    } finally { dispose(db, root); }
  });

  it("refuses a symlinked projection root", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-projection-root-link-")); const outside = join(root, "outside"); const stateRoot = join(root, "state");
    const db = await initialized(); const control = new ControlPlane(db);
    try {
      mkdirSync(outside); symlinkSync(outside, stateRoot);
      const id = approve(db, control, request("projection-root-link", "state.project", 1, {}));
      await expect(new ApprovedCommandExecutor(db, join(root, "backups"), stateRoot).execute(id)).resolves.toMatchObject({ state: "failed" });
      expect(existsSync(join(outside, "CURRENT_STATE.json"))).toBe(false);
    } finally { dispose(db, root); }
  });

  it("ignores a predictable projection temp-file symlink without touching its target", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-projection-temp-link-")); const stateRoot = join(root, "state"); const outside = join(root, "outside.json");
    const db = await initialized(); const control = new ControlPlane(db);
    try {
      mkdirSync(stateRoot); writeFileSync(outside, "sentinel\n"); symlinkSync(outside, join(stateRoot, "CURRENT_STATE.json.tmp"));
      const id = approve(db, control, request("projection-temp-link", "state.project", 1, {}));
      await expect(new ApprovedCommandExecutor(db, join(root, "backups"), stateRoot).execute(id)).resolves.toMatchObject({ state: "completed" });
      expect(readFileSync(outside, "utf8")).toBe("sentinel\n");
    } finally { dispose(db, root); }
  });

  it("publishes JSON and Markdown from one atomic generation under the supplied temp state root", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-projection-generation-")); const stateRoot = join(root, "state");
    const db = await initialized(); const control = new ControlPlane(db);
    try {
      const id = approve(db, control, request("projection-generation", "state.project", 1, {}));
      const result = await new ApprovedCommandExecutor(db, join(root, "backups"), stateRoot).execute(id);
      expect(result).toMatchObject({ state: "completed" });
      const output = result.result as { json: string; markdown: string };
      expect(output.json.startsWith(`${stateRoot}${sep}`)).toBe(true);
      expect(output.markdown.startsWith(`${stateRoot}${sep}`)).toBe(true);
      expect(dirname(output.json)).toBe(dirname(output.markdown));
      expect(dirname(output.json)).not.toBe(stateRoot);
    } finally { dispose(db, root); }
  });

  it("excludes the active projection request from its own projected queue", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-projection-self-")); const stateRoot = join(root, "state");
    const db = await initialized(); const control = new ControlPlane(db);
    try {
      const id = approve(db, control, request("projection-self", "state.project", 1, {}));
      const result = await new ApprovedCommandExecutor(db, join(root, "backups"), stateRoot).execute(id);
      expect(result).toMatchObject({ state: "completed" });
      const output = result.result as { json: string };
      const projection = JSON.parse(readFileSync(output.json, "utf8")) as { next_3: Array<{ request_id?: string }> };
      expect(projection.next_3.map(item => item.request_id)).not.toContain(id);
    } finally { dispose(db, root); }
  });
});
