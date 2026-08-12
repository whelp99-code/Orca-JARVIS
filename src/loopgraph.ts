import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { AuthorityDb, JarvisError } from "./db.js";
import { ControlPlane } from "./control-plane.js";

export type LoopNodeKind = "observe" | "assess" | "approval" | "dispatch" | "verify" | "recover" | "complete" | "fail";
export interface LoopNode { id: string; kind: LoopNodeKind; transitions: Record<string, string>; }
export interface LoopSpec { schema_version: 1; loop_id: string; version: number; name: string; start: string; nodes: LoopNode[]; }
export interface WorkflowRunInput { run_id: string; loop_id: string; correlation_id: string; input: unknown; budget: { max_steps: number; max_attempts_per_node: number; deadline: string }; }
export interface WorkflowAdvanceInput { run_id: string; outcome: string; output: unknown; evidence_digest?: string; approval_receipt_id?: string; }
export interface StoredWorkflowRun { run_id: string; loop_id: string; state: string; current_node: string; correlation_id: string; input: unknown; budget: unknown; attempts: number; created_at: string; updated_at: string; completed_at: string | null; failure_code: string | null; }

const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export const DEFAULT_AGENTOPS_LOOP: LoopSpec = {
  schema_version: 1,
  loop_id: "agentops-default",
  version: 1,
  name: "Observe, approve, dispatch, verify, recover",
  start: "observe",
  nodes: [
    { id: "observe", kind: "observe", transitions: { observed: "assess", unavailable: "recover" } },
    { id: "assess", kind: "assess", transitions: { no_action: "complete", command_required: "approval", unsafe: "fail" } },
    { id: "approval", kind: "approval", transitions: { approved: "dispatch", rejected: "fail" } },
    { id: "dispatch", kind: "dispatch", transitions: { success: "verify", retryable_failure: "recover", uncertain: "fail" } },
    { id: "verify", kind: "verify", transitions: { passed: "complete", failed: "recover" } },
    { id: "recover", kind: "recover", transitions: { recovered: "verify", escalated: "fail" } },
    { id: "complete", kind: "complete", transitions: {} },
    { id: "fail", kind: "fail", transitions: {} },
  ],
};

function validate(spec: LoopSpec): void {
  if (spec.schema_version !== 1 || !nonempty(spec.loop_id) || !nonempty(spec.name) || !Number.isInteger(spec.version) || spec.version < 1 || !nonempty(spec.start) || !Array.isArray(spec.nodes) || spec.nodes.length < 2) throw new JarvisError("LOOP_SPEC_INVALID");
  const ids = new Set<string>(); for (const node of spec.nodes) { if (!nonempty(node.id) || ids.has(node.id) || !new Set<LoopNodeKind>(["observe","assess","approval","dispatch","verify","recover","complete","fail"]).has(node.kind) || !node.transitions || typeof node.transitions !== "object" || Array.isArray(node.transitions)) throw new JarvisError("LOOP_SPEC_INVALID"); ids.add(node.id); }
  if (!ids.has(spec.start)) throw new JarvisError("LOOP_SPEC_INVALID");
  for (const node of spec.nodes) { if ((node.kind === "complete" || node.kind === "fail") && Object.keys(node.transitions).length > 0) throw new JarvisError("LOOP_SPEC_INVALID"); for (const [outcome, target] of Object.entries(node.transitions)) if (!nonempty(outcome) || !ids.has(target)) throw new JarvisError("LOOP_SPEC_INVALID"); }
}

const stateFor = (node: LoopNode): string => node.kind === "approval" ? "waiting_approval" : node.kind === "verify" ? "verifying" : node.kind === "recover" ? "recovering" : node.kind === "complete" ? "completed" : node.kind === "fail" ? "failed" : "running";

export class LoopGraph {
  private readonly control: ControlPlane;
  constructor(private readonly authority: AuthorityDb) { this.control = new ControlPlane(authority); }

  register(spec: LoopSpec, now = new Date()): string {
    validate(spec); const specDigest = digest(spec); const prior = this.authority.db.prepare("SELECT spec_digest FROM loop_definitions WHERE loop_id=?").get(spec.loop_id) as { spec_digest: string } | undefined;
    if (prior) { if (prior.spec_digest !== specDigest) throw new JarvisError("LOOP_SPEC_REPLAY_CONFLICT"); return specDigest; }
    this.authority.db.prepare("INSERT INTO loop_definitions(loop_id,version,name,spec_json,spec_digest,state,created_at) VALUES(?,?,?,?,?,?,?)").run(spec.loop_id, spec.version, spec.name, canonicalize(spec), specDigest, "active", now.toISOString());
    this.control.emit({ event_id: `evt:loop:${spec.loop_id}:registered`, event_type: "loop.registered", source: "jarvis-loopgraph", subject: spec.loop_id, correlation_id: spec.loop_id, payload: { version: spec.version, spec_digest: specDigest }, created_at: now.toISOString() }); return specDigest;
  }

  ensureDefaults(now = new Date()): void { this.register(DEFAULT_AGENTOPS_LOOP, now); }

  private spec(loopId: string): LoopSpec {
    const row = this.authority.db.prepare("SELECT spec_json,state FROM loop_definitions WHERE loop_id=?").get(loopId) as { spec_json: string; state: string } | undefined;
    if (!row || row.state !== "active") throw new JarvisError("LOOP_NOT_ACTIVE"); const spec = JSON.parse(row.spec_json) as LoopSpec; validate(spec); return spec;
  }

  start(input: WorkflowRunInput, now = new Date()): StoredWorkflowRun {
    if (!nonempty(input.run_id) || !nonempty(input.loop_id) || !nonempty(input.correlation_id) || !input.budget || !Number.isInteger(input.budget.max_steps) || input.budget.max_steps < 1 || !Number.isInteger(input.budget.max_attempts_per_node) || input.budget.max_attempts_per_node < 1 || Date.parse(input.budget.deadline) <= now.getTime()) throw new JarvisError("WORKFLOW_INPUT_INVALID");
    const spec = this.spec(input.loop_id); const start = spec.nodes.find(node => node.id === spec.start)!; const initialState = stateFor(start);
    const prior = this.authority.db.prepare("SELECT * FROM workflow_runs WHERE run_id=?").get(input.run_id) as Record<string, unknown> | undefined;
    if (prior) { const stored = this.row(prior); if (stored.loop_id !== input.loop_id || stored.correlation_id !== input.correlation_id || canonicalize(stored.input) !== canonicalize(input.input) || canonicalize(stored.budget) !== canonicalize(input.budget)) throw new JarvisError("WORKFLOW_REPLAY_CONFLICT"); return stored; }
    this.authority.db.prepare("INSERT INTO workflow_runs(run_id,loop_id,state,current_node,correlation_id,input_json,budget_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(input.run_id, input.loop_id, initialState, spec.start, input.correlation_id, canonicalize(input.input), canonicalize(input.budget), now.toISOString(), now.toISOString());
    this.control.emit({ event_id: `evt:workflow:${input.run_id}:started`, event_type: "workflow.started", source: "jarvis-loopgraph", subject: input.run_id, correlation_id: input.correlation_id, payload: { loop_id: input.loop_id, current_node: spec.start, state: initialState }, created_at: now.toISOString() }); return this.get(input.run_id);
  }

  private approvalReceipt(input: WorkflowAdvanceInput, run: StoredWorkflowRun, current: LoopNode): { receipt_id: string; request_id: string; command_digest: string; lease_fence: number } | undefined {
    if (current.kind !== "approval") return undefined;
    if (!nonempty(input.approval_receipt_id)) throw new JarvisError("WORKFLOW_APPROVAL_RECEIPT_REQUIRED");
    const row = this.authority.db.prepare("SELECT a.receipt_id,a.request_id,a.command_digest,r.action,r.args_json,r.state,r.lease_fence,x.lease_fence AS redemption_fence FROM control_command_receipts a JOIN control_command_requests r ON r.request_id=a.request_id JOIN control_command_redemptions x ON x.receipt_id=a.receipt_id AND x.request_id=r.request_id WHERE a.receipt_id=? AND a.decision='approve'").get(input.approval_receipt_id) as Record<string, unknown> | undefined;
    if (!row || row.action !== "workflow.advance" || row.state !== "claimed" || Number(row.lease_fence) !== Number(row.redemption_fence)) throw new JarvisError("WORKFLOW_APPROVAL_RECEIPT_REQUIRED");
    const args = JSON.parse(String(row.args_json)) as Record<string, unknown>;
    if (args.run_id !== run.run_id || args.outcome !== input.outcome) throw new JarvisError("WORKFLOW_APPROVAL_RECEIPT_REQUIRED");
    return { receipt_id: String(row.receipt_id), request_id: String(row.request_id), command_digest: String(row.command_digest), lease_fence: Number(row.lease_fence) };
  }

  advance(input: WorkflowAdvanceInput, now = new Date()): StoredWorkflowRun {
    if (!nonempty(input.run_id) || !nonempty(input.outcome)) throw new JarvisError("WORKFLOW_ADVANCE_INVALID");
    let result: StoredWorkflowRun | undefined; const tx = this.authority.db.transaction(() => {
      const row = this.authority.db.prepare("SELECT * FROM workflow_runs WHERE run_id=?").get(input.run_id) as Record<string, unknown> | undefined; if (!row) throw new JarvisError("WORKFLOW_NOT_FOUND"); const run = this.row(row);
      if (["completed","failed","uncertain","cancelled"].includes(run.state)) throw new JarvisError("WORKFLOW_TERMINAL"); const budget = run.budget as { max_steps: number; max_attempts_per_node: number; deadline: string }; if (Date.parse(budget.deadline) <= now.getTime() || run.attempts >= budget.max_steps) throw new JarvisError("WORKFLOW_BUDGET_EXHAUSTED");
      const spec = this.spec(run.loop_id); const current = spec.nodes.find(node => node.id === run.current_node); if (!current) throw new JarvisError("WORKFLOW_STATE_INVALID"); const targetId = current.transitions[input.outcome]; if (!targetId) throw new JarvisError("WORKFLOW_TRANSITION_NOT_ALLOWED"); const target = spec.nodes.find(node => node.id === targetId)!; const approval = this.approvalReceipt(input, run, current);
      const attempt = Number((this.authority.db.prepare("SELECT COUNT(*) AS count FROM workflow_steps WHERE run_id=? AND node_id=?").get(run.run_id, current.id) as { count: number }).count) + 1; if (attempt > budget.max_attempts_per_node) throw new JarvisError("WORKFLOW_NODE_ATTEMPTS_EXHAUSTED");
      const outputJson = canonicalize(input.output); const stepId = `step:${digest({ run: run.run_id, node: current.id, attempt, outcome: input.outcome }).slice(7)}`; const transitionId = `transition:${digest({ run: run.run_id, from: current.id, to: target.id, attempt }).slice(7)}`;
      this.authority.db.prepare("INSERT INTO workflow_steps(step_id,run_id,node_id,attempt,outcome,output_json,output_digest,evidence_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(stepId, run.run_id, current.id, attempt, input.outcome, outputJson, digest(input.output), input.evidence_digest ?? null, now.toISOString());
      this.authority.db.prepare("INSERT INTO workflow_transitions(transition_id,run_id,from_node,to_node,outcome,evidence_digest,created_at,approval_receipt_id) VALUES(?,?,?,?,?,?,?,?)").run(transitionId, run.run_id, current.id, target.id, input.outcome, input.evidence_digest ?? null, now.toISOString(), approval?.receipt_id ?? null);
      if (approval) this.authority.db.prepare("INSERT INTO workflow_step_approvals(approval_id,step_id,transition_id,run_id,request_id,receipt_id,lease_fence,command_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(`workflow-step-approval:${digest({ stepId, receipt: approval.receipt_id }).slice(7)}`, stepId, transitionId, run.run_id, approval.request_id, approval.receipt_id, approval.lease_fence, approval.command_digest, now.toISOString());
      const nextState = stateFor(target); const completedAt = nextState === "completed" || nextState === "failed" ? now.toISOString() : null; this.authority.db.prepare("UPDATE workflow_runs SET state=?,current_node=?,attempts=attempts+1,updated_at=?,completed_at=? WHERE run_id=? AND state=? AND current_node=?").run(nextState, target.id, now.toISOString(), completedAt, run.run_id, run.state, current.id);
      this.control.emit({ event_id: `evt:workflow:${run.run_id}:transition:${run.attempts + 1}`, event_type: "workflow.transitioned", source: "jarvis-loopgraph", subject: run.run_id, correlation_id: run.correlation_id, causation_id: `evt:workflow:${run.run_id}:started`, payload: { from: current.id, to: target.id, outcome: input.outcome, state: nextState, evidence_digest: input.evidence_digest ?? null, approval_receipt_id: approval?.receipt_id ?? null }, created_at: now.toISOString() }); result = this.get(run.run_id);
    }); tx(); if (!result) throw new JarvisError("WORKFLOW_ADVANCE_FAILED"); return result;
  }

  cancel(runId: string, reason: string, now = new Date()): StoredWorkflowRun {
    if (!nonempty(runId) || !nonempty(reason)) throw new JarvisError("WORKFLOW_CANCEL_INVALID"); const changed = this.authority.db.prepare("UPDATE workflow_runs SET state='cancelled',updated_at=?,completed_at=?,failure_code=? WHERE run_id=? AND state NOT IN ('completed','failed','uncertain','cancelled')").run(now.toISOString(), now.toISOString(), reason, runId); if (changed.changes !== 1) throw new JarvisError("WORKFLOW_CANCEL_NOT_AVAILABLE"); const run = this.get(runId); this.control.emit({ event_id: `evt:workflow:${runId}:cancelled`, event_type: "workflow.cancelled", source: "jarvis-loopgraph", subject: runId, correlation_id: run.correlation_id, payload: { reason }, created_at: now.toISOString() }); return run;
  }

  private row(row: Record<string, unknown>): StoredWorkflowRun { return { run_id: String(row.run_id), loop_id: String(row.loop_id), state: String(row.state), current_node: String(row.current_node), correlation_id: String(row.correlation_id), input: JSON.parse(String(row.input_json)), budget: JSON.parse(String(row.budget_json)), attempts: Number(row.attempts), created_at: String(row.created_at), updated_at: String(row.updated_at), completed_at: row.completed_at === null ? null : String(row.completed_at), failure_code: row.failure_code === null ? null : String(row.failure_code) }; }
  get(runId: string): StoredWorkflowRun { const row = this.authority.db.prepare("SELECT * FROM workflow_runs WHERE run_id=?").get(runId) as Record<string, unknown> | undefined; if (!row) throw new JarvisError("WORKFLOW_NOT_FOUND"); return this.row(row); }
  list(): StoredWorkflowRun[] { return (this.authority.db.prepare("SELECT * FROM workflow_runs ORDER BY created_at,run_id").all() as Array<Record<string, unknown>>).map(row => this.row(row)); }
}
