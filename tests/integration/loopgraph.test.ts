import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ApprovedCommandExecutor } from "../../src/approved-executor.js";
import { ControlPlane, signCommandApproval, type CommandApprovalReceipt, type ControlCommandRequestInput } from "../../src/control-plane.js";
import { DEFAULT_AGENTOPS_LOOP, LoopGraph } from "../../src/loopgraph.js";
import { future, initialized as createInitialized, localKey } from "../helpers.js";

const temporaryDirectories = new Set<string>();
const initialized = async () => { const db = await createInitialized(); temporaryDirectories.add(dirname(db.filename)); const key = (db.db.prepare("SELECT public_key_pem FROM trusted_authority_keys WHERE key_id='decision-test'").get() as { public_key_pem: string }).public_key_pem; for (const name of readdirSync(tmpdir())) if (name.startsWith("jarvis-external-keys-")) { const directory = join(tmpdir(), name); try { if (readFileSync(join(directory, "decision.pub.pem"), "utf8") === key) temporaryDirectories.add(directory); } catch { /* Ignore unrelated temporary directories removed concurrently. */ } } return db; };
afterAll(() => { for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true }); });

const command = (id: string, action: string, level: 0 | 1 | 2 | 3 | 4 | 5, args: Record<string, unknown>): ControlCommandRequestInput => ({ schema_version: 1, request_id: id, action, action_level: level, target: { environment: "local" }, args, reversible: true, requested_by: "operator", requested_at: new Date().toISOString(), expires_at: future(10), nonce: `nonce-${id}` });
const approve = (db: Awaited<ReturnType<typeof initialized>>, control: ControlPlane, input: ControlCommandRequestInput): string => { const staged = control.stage(input); const now = new Date().toISOString(); const payload: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1, receipt_id: `approval-${input.request_id}`, request_id: input.request_id, decision: "approve", command_digest: staged.command_digest, signer_principal_id: "test-operator", authenticated_session_id: "action-hub", key_id: "decision-test", algorithm: "Ed25519", issued_at: now, not_before: now, expires_at: input.expires_at, nonce: `approval-${input.request_id}`, max_uses: 1, status: "issued" }; control.decide(signCommandApproval(payload, localKey(db))); return input.request_id; };

describe("approval-gated dynamic LoopGraph", () => {
  it("requires a separately approved command for every workflow transition", async () => {
    const db = await initialized(); const control = new ControlPlane(db); const executor = new ApprovedCommandExecutor(db); const deadline = future(30);
    const registration = approve(db, control, command("register-loop", "workflow.register", 3, { spec: DEFAULT_AGENTOPS_LOOP })); await expect(executor.execute(registration)).resolves.toMatchObject({ state: "completed" });
    const start = approve(db, control, command("start-run", "workflow.start", 2, { run_id: "run-1", loop_id: DEFAULT_AGENTOPS_LOOP.loop_id, correlation_id: "corr-1", input: { task: "inspect" }, budget: { max_steps: 10, max_attempts_per_node: 2, deadline } }));
    await expect(executor.execute(start)).resolves.toMatchObject({ state: "completed", result: { current_node: "observe", state: "running" } });
    const first = approve(db, control, command("advance-observe", "workflow.advance", 2, { run_id: "run-1", outcome: "observed", output: { healthy: true }, evidence_digest: "sha256:observed" })); await executor.execute(first);
    const second = approve(db, control, command("advance-assess", "workflow.advance", 2, { run_id: "run-1", outcome: "command_required", output: { action: "restart" } })); await executor.execute(second);
    const graph = new LoopGraph(db); expect(graph.get("run-1")).toMatchObject({ current_node: "approval", state: "waiting_approval", attempts: 2 });
    expect(() => graph.advance({ run_id: "run-1", outcome: "success", output: {} })).toThrow("WORKFLOW_TRANSITION_NOT_ALLOWED");
    const approved = approve(db, control, command("advance-approved", "workflow.advance", 2, { run_id: "run-1", outcome: "approved", output: { approval_receipt: true } })); await executor.execute(approved);
    expect(graph.get("run-1")).toMatchObject({ current_node: "dispatch", state: "running", attempts: 3 });
    expect((db.db.prepare("SELECT COUNT(*) AS count FROM workflow_transitions").get() as { count: number }).count).toBe(3); db.close();
  });

  it("fails a workflow start when its definition was not registered by an approved command", async () => {
    const db = await initialized(); const control = new ControlPlane(db); const executor = new ApprovedCommandExecutor(db); const start = approve(db, control, command("start-unregistered", "workflow.start", 2, { run_id: "run-unregistered", loop_id: DEFAULT_AGENTOPS_LOOP.loop_id, correlation_id: "corr-unregistered", input: {}, budget: { max_steps: 5, max_attempts_per_node: 1, deadline: future(10) } }));
    await expect(executor.execute(start)).resolves.toMatchObject({ state: "failed", failure_code: "LOOP_NOT_ACTIVE" }); expect((db.db.prepare("SELECT COUNT(*) AS count FROM loop_definitions").get() as { count: number }).count).toBe(0); db.close();
  });

  it("requires an approval receipt when leaving an approval node", async () => {
    const db = await initialized(); const graph = new LoopGraph(db); graph.register(DEFAULT_AGENTOPS_LOOP); graph.start({ run_id: "run-receipt-required", loop_id: DEFAULT_AGENTOPS_LOOP.loop_id, correlation_id: "corr-receipt-required", input: {}, budget: { max_steps: 10, max_attempts_per_node: 2, deadline: future(10) } }); graph.advance({ run_id: "run-receipt-required", outcome: "observed", output: {} }); graph.advance({ run_id: "run-receipt-required", outcome: "command_required", output: {} });
    expect(() => graph.advance({ run_id: "run-receipt-required", outcome: "approved", output: {} })).toThrow("WORKFLOW_APPROVAL_RECEIPT_REQUIRED"); expect(graph.get("run-receipt-required")).toMatchObject({ current_node: "approval", state: "waiting_approval" }); db.close();
  });

  it("persists the authorizing receipt link on an approved approval-node transition", async () => {
    const db = await initialized(); const control = new ControlPlane(db); const executor = new ApprovedCommandExecutor(db); const graph = new LoopGraph(db); graph.register(DEFAULT_AGENTOPS_LOOP); graph.start({ run_id: "run-receipt-link", loop_id: DEFAULT_AGENTOPS_LOOP.loop_id, correlation_id: "corr-receipt-link", input: {}, budget: { max_steps: 10, max_attempts_per_node: 2, deadline: future(10) } }); graph.advance({ run_id: "run-receipt-link", outcome: "observed", output: {} }); graph.advance({ run_id: "run-receipt-link", outcome: "command_required", output: {} });
    const advance = approve(db, control, command("advance-with-receipt", "workflow.advance", 2, { run_id: "run-receipt-link", outcome: "approved", output: {} })); await expect(executor.execute(advance)).resolves.toMatchObject({ state: "completed" }); const transition = db.db.prepare("SELECT * FROM workflow_transitions WHERE run_id=? AND from_node='approval'").get("run-receipt-link");
    expect(transition).toMatchObject({ approval_receipt_id: "approval-advance-with-receipt" }); db.close();
  });

  it("fails closed on graph drift and terminal replay", async () => {
    const db = await initialized(); const graph = new LoopGraph(db); graph.register(DEFAULT_AGENTOPS_LOOP); expect(() => graph.register({ ...DEFAULT_AGENTOPS_LOOP, name: "drift" })).toThrow("LOOP_SPEC_REPLAY_CONFLICT");
    graph.start({ run_id: "run-2", loop_id: DEFAULT_AGENTOPS_LOOP.loop_id, correlation_id: "corr-2", input: {}, budget: { max_steps: 5, max_attempts_per_node: 1, deadline: future(10) } }); graph.advance({ run_id: "run-2", outcome: "observed", output: {} }); graph.advance({ run_id: "run-2", outcome: "no_action", output: {} }); expect(graph.get("run-2")).toMatchObject({ state: "completed", current_node: "complete" }); expect(() => graph.advance({ run_id: "run-2", outcome: "x", output: {} })).toThrow("WORKFLOW_TERMINAL"); db.close();
  });
});
