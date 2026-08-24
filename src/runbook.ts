import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { AuthorityDb, JarvisError } from "./db.js";
import { passiveCapabilityProbe, runDoctor } from "./doctor.js";
import { LiveSupervisor } from "./live-supervisor.js";
import { ControlPlane, type ActionLevel } from "./control-plane.js";

export interface RunbookSpec {
  schema_version: 1;
  runbook_id: string;
  version: number;
  name: string;
  minimum_action_level: ActionLevel;
  effect: "diagnostic" | "local_database" | "service_control";
}
export interface RunbookResult { runbook_id: string; state: "completed" | "failed" | "escalated"; result: unknown; }
export interface ExternalEffectContext {
  request_id: string;
  fence: number;
  effect_id: string;
  idempotency_key: string;
}
export interface HostEffectReceipt {
  restarted: boolean;
  idempotency_key?: string;
  detail?: unknown;
}
export interface HostOperations { restartService?(service: string, context?: ExternalEffectContext): Promise<HostEffectReceipt>; }

const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
export const BUILTIN_RUNBOOKS: readonly RunbookSpec[] = [
  { schema_version: 1, runbook_id: "runtime-diagnose", version: 1, name: "Run JARVIS doctor and return failed checks", minimum_action_level: 1, effect: "diagnostic" },
  { schema_version: 1, runbook_id: "report-backlog", version: 1, name: "Acknowledge one exact live report after operator approval", minimum_action_level: 2, effect: "local_database" },
  { schema_version: 1, runbook_id: "wal-checkpoint", version: 1, name: "Run a passive SQLite WAL checkpoint", minimum_action_level: 2, effect: "local_database" },
  { schema_version: 1, runbook_id: "native-abi-mismatch", version: 1, name: "Diagnose Node and native ABI mismatch without rebuilding", minimum_action_level: 1, effect: "diagnostic" },
  { schema_version: 1, runbook_id: "daemon-dead", version: 1, name: "Restart one approved service through an injected host adapter", minimum_action_level: 3, effect: "service_control" },
] as const;

export class RunbookEngine {
  private readonly control: ControlPlane;
  constructor(private readonly authority: AuthorityDb, private readonly host: HostOperations = {}) { this.control = new ControlPlane(authority); }

  ensureBuiltIns(now = new Date()): void {
    for (const spec of BUILTIN_RUNBOOKS) {
      const specDigest = digest(spec); const prior = this.authority.db.prepare("SELECT spec_digest FROM runbook_definitions WHERE runbook_id=?").get(spec.runbook_id) as { spec_digest: string } | undefined;
      if (prior) { if (prior.spec_digest !== specDigest) throw new JarvisError("RUNBOOK_SPEC_DRIFT"); continue; }
      this.authority.db.prepare("INSERT INTO runbook_definitions(runbook_id,version,name,minimum_action_level,spec_json,spec_digest,created_at) VALUES(?,?,?,?,?,?,?)").run(spec.runbook_id, spec.version, spec.name, spec.minimum_action_level, canonicalize(spec), specDigest, now.toISOString());
      this.control.emit({ event_id: `evt:runbook:${spec.runbook_id}:registered`, event_type: "runbook.registered", source: "jarvis-runbook", subject: spec.runbook_id, correlation_id: spec.runbook_id, payload: { spec_digest: specDigest }, created_at: now.toISOString() });
    }
  }

  minimumLevel(runbookId: string): ActionLevel {
    this.ensureBuiltIns(); const row = this.authority.db.prepare("SELECT minimum_action_level FROM runbook_definitions WHERE runbook_id=?").get(runbookId) as { minimum_action_level: number } | undefined; if (!row) throw new JarvisError("RUNBOOK_NOT_FOUND"); return Number(row.minimum_action_level) as ActionLevel;
  }

  private record(requestId: string, result: RunbookResult, now: Date): RunbookResult {
    const payload = canonicalize(result.result); const executionId = `runbook-execution:${digest({ requestId, runbookId: result.runbook_id, result: result.result }).slice(7)}`;
    this.authority.db.prepare("INSERT INTO runbook_executions(execution_id,request_id,runbook_id,state,result_json,result_digest,created_at) VALUES(?,?,?,?,?,?,?)").run(executionId, requestId, result.runbook_id, result.state, payload, digest(result.result), now.toISOString());
    this.control.emit({ event_id: `evt:runbook:${requestId}:${result.state}`, event_type: `runbook.${result.state}`, source: "jarvis-runbook", subject: result.runbook_id, correlation_id: requestId, causation_id: `evt:${requestId}:claimed:1`, payload: { execution_id: executionId, result: result.result }, created_at: now.toISOString() }); return result;
  }

  async execute(requestId: string, actionLevel: ActionLevel, runbookId: string, args: Record<string, unknown>, now = new Date(), effectContext?: ExternalEffectContext): Promise<RunbookResult> {
    this.ensureBuiltIns(now); const required = this.minimumLevel(runbookId); if (actionLevel < required) throw new JarvisError("RUNBOOK_ACTION_LEVEL_TOO_LOW");
    if (this.authority.db.prepare("SELECT 1 FROM runbook_executions WHERE request_id=?").get(requestId)) throw new JarvisError("RUNBOOK_REPLAY_BLOCKED");
    if (runbookId === "runtime-diagnose") { const report = await runDoctor(this.authority, now, passiveCapabilityProbe()); return this.record(requestId, { runbook_id: runbookId, state: "completed", result: { doctor_ok: report.ok, failed_checks: report.checks.filter(check => !check.ok) } }, now); }
    if (runbookId === "native-abi-mismatch") { const report = await runDoctor(this.authority, now, passiveCapabilityProbe()); const runtime = report.checks.filter(check => check.name.startsWith("runtime.")); return this.record(requestId, { runbook_id: runbookId, state: runtime.every(check => check.ok) ? "completed" : "escalated", result: { runtime, automatic_rebuild: false, required_action: runtime.every(check => check.ok) ? null : "Use the pinned Node 24 toolchain and obtain a new approval before rebuilding native modules." } }, now); }
    if (runbookId === "report-backlog") { const reportId = args.report_id; if (typeof reportId !== "string" || !reportId) throw new JarvisError("RUNBOOK_INPUT_INVALID"); const supervisor = new LiveSupervisor(this.authority); supervisor.acknowledgeReport(reportId); return this.record(requestId, { runbook_id: runbookId, state: "completed", result: { report_id: reportId, acknowledged: true } }, now); }
    if (runbookId === "wal-checkpoint") { const checkpoint = this.authority.db.pragma("wal_checkpoint(PASSIVE)"); return this.record(requestId, { runbook_id: runbookId, state: "completed", result: { mode: "PASSIVE", checkpoint } }, now); }
    if (runbookId === "daemon-dead") {
      const service = args.service;
      if (typeof service !== "string" || !service) throw new JarvisError("RUNBOOK_INPUT_INVALID");
      if (!this.host.restartService) return this.record(requestId, { runbook_id: runbookId, state: "escalated", result: { service, reason: "HOST_ADAPTER_REQUIRED", command_executed: false } }, now);
      const restart = await this.host.restartService(service, effectContext);
      if (effectContext && restart.idempotency_key !== undefined && restart.idempotency_key !== effectContext.idempotency_key) throw new JarvisError("EXTERNAL_EFFECT_RECEIPT_MISMATCH");
      return this.record(requestId, { runbook_id: runbookId, state: restart.restarted ? "completed" : "failed", result: { service, ...restart } }, now);
    }
    throw new JarvisError("RUNBOOK_NOT_FOUND");
  }
}
