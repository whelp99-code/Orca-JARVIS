import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryOutboxDiagnostics } from "../../src/memory-outbox-diagnostics.js";
import { memoryOutboxFailure, tagMemoryOutboxFailure } from "../../src/memory-outbox-diagnostic.js";
import { ControlPlane } from "../../src/control-plane.js";
import { JarvisError } from "../../src/jarvis-error.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { claimAction, outboxFixture, type OutboxFixture } from "../fixtures/memory-outbox-fixture.js";

const fixtures: OutboxFixture[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) closeMemoryDatabase(f.database); });
const fault = (phase: "provider_write" | "provider_observation" | "control_reconciliation") =>
  memoryOutboxFailure(tagMemoryOutboxFailure(phase, new Error("PRIVATE_SENTINEL")));

describe("bounded diagnostic lifecycle", () => {
  it.each(["writers", "observers", "controls"] as const)("bounds the %s sample independently of the outage backlog", async group => {
    const f = await outboxFixture(); fixtures.push(f);
    const diagnostics = new MemoryOutboxDiagnostics(f.database.authority);
    const phase = group === "writers" ? "provider_write"
      : group === "observers" ? "provider_observation" : "control_reconciliation";

    for (let index = 0; index < 1024; index += 1) diagnostics.record(`outage-${index}`, fault(phase));

    expect(diagnostics[group].size).toBeLessThanOrEqual(32);
    expect(diagnostics[group].size).toBeGreaterThan(0);
  });

  it("visits a later closed fault while the oldest fault remains active", async () => {
    const a = await outboxFixture(); fixtures.push(a);
    const b = await outboxFixture({ database: a.database, suffix: "-page-b" });
    const c = await outboxFixture({ database: a.database, suffix: "-page-c" });
    const diagnostics = new MemoryOutboxDiagnostics(a.database.authority);
    const entries = [a, b, c].map(f => {
      const id = f.service.enqueue(claimAction(f)).outbox_id;
      const failure = fault("provider_write"); diagnostics.record(id, failure);
      return { id, failure };
    });
    const first = entries[0]; const later = entries[2];
    if (first === undefined || later === undefined) throw new Error("fixture entries missing");
    diagnostics.take(1);
    a.database.authority.db.prepare("UPDATE memory_outbox SET state='failed' WHERE outbox_id=?").run(later.id);
    const retired = [];

    for (let page = 0; page < 3; page += 1) retired.push(...diagnostics.take(1).retired);

    expect(retired).toContain(later.failure);
    expect(retired).not.toContain(first.failure);
    expect(diagnostics["writers"].has(`${first.id}:provider_write`)).toBe(true);
  });

  it("does not advance a failed cleanup page before the same query succeeds", async () => {
    const f = await outboxFixture(); fixtures.push(f);
    const diagnostics = new MemoryOutboxDiagnostics(f.database.authority);
    const a = fault("provider_write"); const b = fault("provider_write");
    diagnostics.record("missing-a", a); diagnostics.record("missing-b", b);
    const db = f.database.authority.db; const prepare = db.prepare.bind(db);
    let unavailable = true;
    const hook = vi.spyOn(db, "prepare").mockImplementation((...args) => {
      if (unavailable && args[0].startsWith("WITH faults")) {
        unavailable = false; throw new Error("PRIVATE_SENTINEL");
      }
      return prepare(...args);
    });

    expect(diagnostics.take(1).failure?.phase).toBe("cycle");
    const recovered = diagnostics.take(1);

    expect(recovered.retired).toContain(a);
    expect(recovered.retired).not.toContain(b);
    hook.mockRestore();
  });

  it("bounds retirement receipts accumulated before the next successful query", async () => {
    const f = await outboxFixture(); fixtures.push(f);
    const diagnostics = new MemoryOutboxDiagnostics(f.database.authority);

    for (let index = 0; index < 1024; index += 1) {
      diagnostics.record(`retirement-${index}`, fault("provider_write"));
      diagnostics.resolve(`retirement-${index}`, "provider_write");
    }

    expect(diagnostics["retired"].length).toBeLessThanOrEqual(108);
  });

  it("keeps the shown fault and never receipts an unresolved eviction", async () => {
    const f = await outboxFixture(); fixtures.push(f);
    const diagnostics = new MemoryOutboxDiagnostics(f.database.authority);
    const id = f.service.enqueue(claimAction(f)).outbox_id;
    const shown = fault("provider_write"); diagnostics.record(id, shown);
    expect(diagnostics.take(1).failure).toBe(shown);
    const evicted = fault("provider_write"); diagnostics.record("older-missing", evicted);

    for (let index = 0; index < 70; index += 1) diagnostics.record(`new-missing-${index}`, fault("provider_write"));
    const page = diagnostics.take(1);

    expect(diagnostics["writers"].size).toBeLessThanOrEqual(32);
    expect(diagnostics["writers"].has(`${id}:provider_write`)).toBe(true);
    expect(page.failure).toBe(shown);
    expect(page.retired).not.toContain(evicted);
    expect(page.retired).not.toContain(shown);
  });

  it("retires the last shown cause even when closure precedes showing its replacement", async () => {
    const f = await outboxFixture(); fixtures.push(f);
    const claim = claimAction(f); const id = f.service.enqueue(claim).outbox_id;
    const diagnostics = new MemoryOutboxDiagnostics(f.database.authority);
    const first = memoryOutboxFailure(tagMemoryOutboxFailure("control_reconciliation",
      new JarvisError("MEMORY_OUTBOX_STALE_FENCE")));
    const next = memoryOutboxFailure(tagMemoryOutboxFailure("control_reconciliation",
      new JarvisError("MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID")));
    diagnostics.record(id, first);
    expect(diagnostics.take(1).failure).toBe(first);

    diagnostics.record(id, next);
    new ControlPlane(f.database.authority).settle(f.commandId, claim.fence, {
      state: "failed", effect_type: "memory.outbox.reconciled", payload: {}, failure_code: "MEMORY_OUTBOX_FAILED",
    }, f.clock.now);
    const closed = diagnostics.take(1);

    expect(closed.failure).toBeUndefined();
    expect(closed.retired).toContain(first);
    expect(closed.retired).toContain(next);
  });

  it("keeps the shown receipt when a failing cycle accumulates more resolutions", async () => {
    const f = await outboxFixture(); fixtures.push(f);
    const diagnostics = new MemoryOutboxDiagnostics(f.database.authority);
    const id = f.service.enqueue(claimAction(f)).outbox_id;
    const shown = fault("provider_write"); diagnostics.record(id, shown);
    diagnostics.take(1); diagnostics.resolve(id, "provider_write");

    for (let index = 0; index < 1000; index += 1) {
      diagnostics.record(`resolved-${index}`, fault("provider_write"));
      diagnostics.resolve(`resolved-${index}`, "provider_write");
    }
    const closed = diagnostics.take(1);

    expect(closed.retired.length).toBeLessThanOrEqual(108);
    expect(closed.retired).toContain(shown);
  });
});
