import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { JarvisError } from "../../src/jarvis-error.js";
import { MemoryOutboxStore } from "../../src/memory-outbox-store.js";
import { MemoryOutboxTick } from "../../src/memory-outbox-tick.js";
import type { MemoryOutboxFailure } from "../../src/memory-outbox-diagnostic.js";
import { removeSuppressedRows } from "../../src/memory-compaction-sanitize.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { claimAction, evidence, FixtureReader, OUTBOX_ARTIFACT_DIGEST, outboxFixture,
  type OutboxFixture } from "../fixtures/memory-outbox-fixture.js";

const fixtures: OutboxFixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) closeMemoryDatabase(f.database);
});
const ready = () => new FixtureReader({ kind: "current", checked_at: "2026-08-31T03:30:00.000Z",
  evidence: [evidence(OUTBOX_ARTIFACT_DIGEST)] });
async function terminal() {
  const f = await outboxFixture({ reader: ready() }); fixtures.push(f);
  const claim = claimAction(f); const saga = f.service.enqueue(claim);
  expect((await f.service.runOnce("terminal-seed", 1)).settled).toBe(1);
  new ControlPlane(f.database.authority).settle(f.commandId, claim.fence, { state: "uncertain",
    effect_type: "memory.outbox.reconciling", payload: {}, failure_code: "MEMORY_OUTBOX_RECONCILING" }, f.clock.now);
  f.database.authority.db.prepare("UPDATE control_command_requests SET lease_fence=lease_fence+1 WHERE request_id=?").run(f.commandId);
  return { f, claim, id: saga.outbox_id };
}

describe("control diagnostic authority and transaction boundaries", () => {
  it.each(["request", "receipt", "digest", "control-request", "control-receipt", "purged"] as const)(
    "retires only the matching control fault after %s closes its authority", async kind => {
      const { f, claim, id } = await terminal();
      const logs: (MemoryOutboxFailure | null)[] = [];
      const tick = new MemoryOutboxTick(() => f.service.runOnce("revocation-owner", 1), failure => logs.push(failure));
      try {
        tick.tick(); await tick.drain();
        expect(logs).toEqual([expect.objectContaining({ phase: "control_reconciliation" })]);
        f.database.authority.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
          .run("unrelated-reference", "unrelated", f.clock.now.toISOString());
        tick.tick(); await tick.drain();
        expect(logs).toHaveLength(1);
        if (kind === "purged") {
          // The fresh compaction builder suspends and restores immutable guards.
          const db = f.database.authority.db;
          const triggers = db.prepare<[], { name: string; sql: string }>(
            "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL").all();
          for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
          try { removeSuppressedRows(db, [{ kind: "outbox", id, component_id: id }]); }
          finally { for (const trigger of triggers) db.exec(trigger.sql); }
        }
        else if (kind === "control-request" || kind === "control-receipt") {
          const other = await outboxFixture({ database: f.database, suffix: "-revoker" });
          f.database.authority.db.prepare(`INSERT INTO control_command_revocations(
            revocation_id,request_id,receipt_id,command_digest,reason,revoked_by,revoked_at,payload_json,payload_digest,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)`).run("diagnostic-revocation",
            kind === "control-request" ? claim.request_id : other.commandId,
            kind === "control-receipt" ? claim.receipt_id : null, claim.command_digest,
            "diagnostic closure", "principal:owner", f.clock.now.toISOString(), "{}", "sha256:fixture", f.clock.now.toISOString());
        } else {
          const reference = kind === "request" ? claim.request_id : kind === "receipt" ? claim.receipt_id : claim.command_digest;
          f.database.authority.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
            .run(reference, "diagnostic closure", f.clock.now.toISOString());
        }
        tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
        expect(new ControlPlane(f.database.authority).get(f.commandId)?.state).toBe("uncertain");
        expect(f.database.authority.db.prepare(
          "SELECT 1 FROM control_command_effects WHERE request_id=? AND effect_type='memory.outbox.reconciled'").get(f.commandId)).toBeUndefined();
        expect(logs).toEqual([expect.objectContaining({ phase: "control_reconciliation" }), null]);
        expect(f.writer.calls).toHaveLength(1);
      } finally { await tick.close(); }
    });

  it.each(["failed", "expired"] as const)("retires a retained dispatch fault when authority closes the row as %s", async mode => {
    const f = await outboxFixture(); fixtures.push(f);
    const claim = claimAction(f); const saga = f.service.enqueue(claim);
    vi.spyOn(MemoryOutboxStore.prototype, "markDispatch").mockImplementationOnce(() => { throw new JarvisError("MEMORY_OUTBOX_STALE_FENCE"); });
    const logs: (MemoryOutboxFailure | null)[] = [];
    const tick = new MemoryOutboxTick(() => f.service.runOnce("terminal-dispatch", 1), failure => logs.push(failure));
    try {
      tick.tick(); await tick.drain();
      expect(f.service.get(saga.outbox_id)?.state).toBe("claimed");
      expect(logs).toEqual([expect.objectContaining({ phase: "dispatch" })]);
      f.clock.now = new Date(f.clock.now.getTime() + (mode === "expired" ? 86_400_000 : 10_000));
      if (mode === "failed") f.database.authority.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
        .run(claim.receipt_id, "revoked dispatch", f.clock.now.toISOString());
      tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
      expect(f.service.get(saga.outbox_id)?.state).toBe(mode);
      expect(logs).toEqual([expect.objectContaining({ phase: "dispatch" }), null]);
      expect(f.writer.calls).toHaveLength(0);
    } finally { await tick.close(); }
  });

  it("recovers an outer cursor failure only after its own successful empty batch", async () => {
    const f = await outboxFixture(); fixtures.push(f);
    const db = f.database.authority.db; const prepare = db.prepare.bind(db);
    let failing = true;
    const error = new JarvisError("MEMORY_OUTBOX_STALE_FENCE", "PRIVATE_SENTINEL"); let reads = 0;
    Object.defineProperty(error, "code", { get: () => ++reads === 1 ? "MEMORY_OUTBOX_STALE_FENCE" : "PRIVATE_SENTINEL" });
    vi.spyOn(db, "prepare").mockImplementation(sql => {
      if (failing && sql.startsWith("SELECT last_updated_at")) throw error;
      return prepare(sql);
    });
    const logs: (MemoryOutboxFailure | null)[] = [];
    const tick = new MemoryOutboxTick(() => f.service.runOnce("empty-batch-owner", 1), failure => logs.push(failure));
    try {
      tick.tick(); await tick.drain();
      expect(logs).toEqual([{ phase: "control_reconciliation", error_code: "MEMORY_OUTBOX_CONTROL_RECONCILE_FAILED",
        cause_code: "MEMORY_OUTBOX_STALE_FENCE" }]);
      expect(reads).toBe(1);
      failing = false;
      tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
      expect(logs).toEqual([expect.objectContaining({ phase: "control_reconciliation" }), null]);
      expect(f.writer.calls).toHaveLength(0);
      expect(JSON.stringify(logs)).not.toContain("PRIVATE_SENTINEL");
    } finally { await tick.close(); }
  });

  it("keeps an outer batch fault through another service's progress", async () => {
    const f = await outboxFixture(); fixtures.push(f);
    const db = f.database.authority.db; const prepare = db.prepare.bind(db);
    let failing = true; let alternate = false;
    vi.spyOn(db, "prepare").mockImplementation(sql => {
      if (failing && sql.startsWith("SELECT last_updated_at")) throw new JarvisError("MEMORY_OUTBOX_STALE_FENCE");
      return prepare(sql);
    });
    const other = await outboxFixture({ database: f.database, suffix: "-other", reader: ready() });
    const logs: (MemoryOutboxFailure | null)[] = [];
    const tick = new MemoryOutboxTick(() => (alternate ? other.service : f.service).runOnce("batch-scope", 1), failure => logs.push(failure));
    try {
      tick.tick(); await tick.drain();
      expect(logs).toHaveLength(1);
      failing = false; alternate = true;
      const saga = other.service.enqueue(claimAction(other));
      tick.tick(); await tick.drain();
      expect(other.service.get(saga.outbox_id)?.state).toBe("settled");
      expect(logs).toHaveLength(1);
      alternate = false;
      tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
      expect(logs).toEqual([expect.objectContaining({ phase: "control_reconciliation" }), null]);
    } finally { await tick.close(); }
  });

  it("retires an outer cursor-commit fault after an independent completion leaves its own batch empty", async () => {
    const { f, claim, id } = await terminal();
    const db = f.database.authority.db;
    db.prepare("UPDATE control_command_requests SET lease_fence=? WHERE request_id=?").run(claim.fence, f.commandId);
    db.exec("DELETE FROM memory_outbox_control_cursor");
    db.exec(`CREATE TRIGGER boundary_cursor_failure BEFORE INSERT ON memory_outbox_control_cursor
      BEGIN SELECT RAISE(ABORT,'PRIVATE_SENTINEL'); END`);
    const logs: (MemoryOutboxFailure | null)[] = [];
    const tick = new MemoryOutboxTick(() => f.service.runOnce("commit-owner", 1), failure => logs.push(failure));
    try {
      tick.tick(); await tick.drain();
      expect(new ControlPlane(f.database.authority).get(f.commandId)?.state).toBe("uncertain");
      expect(logs).toEqual([expect.objectContaining({ phase: "control_reconciliation" })]);
      db.exec("DROP TRIGGER boundary_cursor_failure");
      expect(new ControlPlane(f.database.authority).reconcileMemoryOutbox(id, f.clock.now)).toBe(true);
      tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
      expect(logs).toEqual([expect.objectContaining({ phase: "control_reconciliation" }), null]);
      expect(f.writer.calls).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toContain("PRIVATE_SENTINEL");
    } finally { await tick.close(); }
  });
});
