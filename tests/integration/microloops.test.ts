import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ApprovedCommandExecutor } from "../../src/approved-executor.js";
import { ControlPlane, signCommandApproval, type CommandApprovalReceipt, type ControlCommandRequestInput } from "../../src/control-plane.js";
import { DurableMicroLoopRuntime, type MicroLoopHandler } from "../../src/microloops.js";
import { future, initialized as createInitialized, localKey } from "../helpers.js";

const temporaryDirectories = new Set<string>();
const initialized = async () => { const db = await createInitialized(); temporaryDirectories.add(dirname(db.filename)); const key = (db.db.prepare("SELECT public_key_pem FROM trusted_authority_keys WHERE key_id='decision-test'").get() as { public_key_pem: string }).public_key_pem; for (const name of readdirSync(tmpdir())) if (name.startsWith("jarvis-external-keys-")) { const directory = join(tmpdir(), name); try { if (readFileSync(join(directory, "decision.pub.pem"), "utf8") === key) temporaryDirectories.add(directory); } catch { /* Ignore unrelated temporary directories removed concurrently. */ } } return db; };
afterAll(() => { for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true }); });

const request = (): ControlCommandRequestInput => ({ schema_version: 1, request_id: "micro-approved", action: "state.project", action_level: 1, target: { environment: "local" }, args: {}, reversible: true, requested_by: "operator", requested_at: new Date().toISOString(), expires_at: future(10), nonce: "micro-approved-nonce" });

describe("durable independent microloops", () => {
  it("isolates one loop failure and records independent status", async () => {
    const db = await initialized(); const runtime = new DurableMicroLoopRuntime(db); const good: MicroLoopHandler = { name: "verification", interval_ms: 10, run: async () => ({ verified: 1 }) }; const bad: MicroLoopHandler = { name: "recovery", interval_ms: 10, run: async () => { throw new Error("simulated"); } };
    const outcomes = await runtime.batch([bad, good], "test-runtime"); expect(outcomes).toEqual([expect.objectContaining({ name: "recovery", state: "failed", error_code: "simulated" }), expect.objectContaining({ name: "verification", state: "completed", result: { verified: 1 } })]);
    expect(runtime.status()).toEqual(expect.arrayContaining([expect.objectContaining({ loop_name: "recovery", cycles: 1, last_error_code: "simulated" }), expect.objectContaining({ loop_name: "verification", cycles: 1, last_error_code: null })])); db.close();
  });

  it("fences a second owner while a loop is active", async () => {
    const db = await initialized(); const first = new DurableMicroLoopRuntime(db); const second = new DurableMicroLoopRuntime(db); let nested: unknown;
    const handler: MicroLoopHandler = { name: "observation", interval_ms: 10, run: async now => { nested = await second.once({ ...handler, run: async () => ({ should_not_run: true }) }, "other-owner", now); return { observed: true }; } };
    await expect(first.once(handler, "first-owner")).resolves.toMatchObject({ state: "completed" }); expect(nested).toMatchObject({ state: "leased" }); db.close();
  });

  it("blocks a reentrant claim by the same owner while its lease is active", async () => {
    const db = await initialized(); const runtime = new DurableMicroLoopRuntime(db); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); let runs = 0; const at = new Date("2030-01-01T00:00:00.000Z");
    const active = runtime.once({ name: "observation", interval_ms: 1_000, run: async () => { runs++; entered.resolve(); await release.promise; return { owner: "first" }; } }, "same-owner", at, 1_000); await entered.promise;
    const blocked = await runtime.once({ name: "observation", interval_ms: 1_000, run: async () => { runs++; return { owner: "reentrant" }; } }, "same-owner", new Date(at.getTime() + 1), 1_000); release.resolve(); await active;
    expect(blocked).toMatchObject({ state: "leased" }); expect(runs).toBe(1); db.close();
  });

  it("runs an interval at T and T+1000 but remains idle at T+999", async () => {
    const db = await initialized(); const runtime = new DurableMicroLoopRuntime(db); const at = new Date("2030-01-01T00:00:00.000Z"); let runs = 0; const handler: MicroLoopHandler = { name: "verification", interval_ms: 1_000, run: async () => ({ run: ++runs }) };
    const atT = await runtime.once(handler, "interval-owner", at); const beforeDue = await runtime.once(handler, "interval-owner", new Date(at.getTime() + 999)); const atDue = await runtime.once(handler, "interval-owner", new Date(at.getTime() + 1_000));
    expect([atT.state, beforeDue.state, atDue.state]).toEqual(["completed", "idle", "completed"]); expect(runs).toBe(2); db.close();
  });

  it("allows an expired takeover and fences the stale completion", async () => {
    const db = await initialized(); const runtime = new DurableMicroLoopRuntime(db); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); const at = new Date("2030-01-01T00:00:00.000Z");
    const stale = runtime.once({ name: "recovery", interval_ms: 1, run: async () => { entered.resolve(); await release.promise; return { generation: "stale" }; } }, "old-owner", at, 1_000); await entered.promise;
    const takeover = await runtime.once({ name: "recovery", interval_ms: 1, run: async () => ({ generation: "current" }) }, "new-owner", new Date(at.getTime() + 1_000), 1_000); release.resolve(); await stale;
    expect(takeover).toMatchObject({ state: "completed", fence: 2 }); expect(runtime.status()).toEqual([expect.objectContaining({ loop_name: "recovery", cycles: 1, owner: "new-owner", fence: 2, last_result_json: "{\"generation\":\"current\"}" })]); db.close();
  });

  it("executes only an already approved command from the command loop queue", async () => {
    const db = await initialized(); const control = new ControlPlane(db); const input = request(); const staged = control.stage(input); const now = new Date().toISOString(); const payload: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1, receipt_id: "micro-approval", request_id: input.request_id, decision: "approve", command_digest: staged.command_digest, signer_principal_id: "test-operator", authenticated_session_id: "action-hub", key_id: "decision-test", algorithm: "Ed25519", issued_at: now, not_before: now, expires_at: input.expires_at, nonce: "micro-receipt-nonce", max_uses: 1, status: "issued" }; control.decide(signCommandApproval(payload, localKey(db)));
    const executor = new ApprovedCommandExecutor(db, join(mkdtempSync(join(tmpdir(), "microloop-backups-")), "backups"), join(mkdtempSync(join(tmpdir(), "microloop-state-")), "state")); const requestId = control.nextApproved(); expect(requestId).toBe(input.request_id); await expect(executor.execute(requestId!)).resolves.toMatchObject({ state: "completed" }); expect(control.nextApproved()).toBeNull(); db.close();
  });
});
