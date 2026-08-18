import { realpathSync } from "node:fs";
import { canonicalize } from "./canonical.js";
import { AuthorityDb, JarvisError } from "./db.js";

export type TaskTimelineSource = "work" | "control" | "workflow" | "gjc" | "verification" | "progress";
export type TaskTimelineKind = "status" | "command" | "approval" | "workflow" | "agent" | "verification" | "evidence" | "system";

export interface TaskTimelineEvent {
  event_id: string;
  task_id: string;
  source: TaskTimelineSource;
  kind: TaskTimelineKind;
  actor: string;
  title: string;
  status: string | null;
  payload: unknown;
  evidence_refs: string[];
  created_at: string;
  sequence: number;
}

export interface TaskTimelineSummary {
  task_id: string;
  title: string;
  kind: "work" | "command" | "workflow" | "agent";
  state: string;
  updated_at: string;
  pending_approval: boolean;
  source_ids: string[];
}

export interface TaskTimelineContext {
  schema_version: 1;
  generated_at: string;
  task: TaskTimelineSummary;
  events: TaskTimelineEvent[];
  pending_decisions: unknown[];
  workers: unknown[];
  evidence: unknown[];
  truncated: boolean;
}

type Row = Record<string, unknown>;
type MutableEvent = Omit<TaskTimelineEvent, "sequence">;

interface TimelineGraph {
  ids: Set<string>;
  workIds: Set<string>;
  continuationIds: Set<string>;
  controlIds: Set<string>;
  runIds: Set<string>;
  intentIds: Set<string>;
  questionIds: Set<string>;
  projectIds: Set<string>;
  worktreeIds: Set<string>;
  canonicalPaths: Set<string>;
  bindings: Map<string, Row>;
  sourceIds: Set<string>;
}

const parse = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
};
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const rowJson = (value: unknown): Row => { const parsed = parse(value); return isRow(parsed) ? parsed : {}; };
const string = (value: unknown): string => value === null || value === undefined ? "" : String(value);
const optional = (value: unknown): string | null => value === null || value === undefined || value === "" ? null : String(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));
const evidence = (...values: unknown[]): string[] => [...new Set(values.flatMap(value => Array.isArray(value) ? value : [value]).filter(nonempty))];
const latest = (...values: unknown[]): string => values.map(optional).filter(nonempty).sort().at(-1) ?? "";
const values = (set: Iterable<string>): string[] => [...new Set([...set].filter(nonempty))];
const bindingKey = (row: Row): string => `${string(row.canonical_path)}\0${string(row.provider)}\0${string(row.terminal_id)}`;
const canonicalPath = (value: unknown): string => { const path = optional(value); if (!path || !path.startsWith("/")) return path ?? ""; try { return realpathSync(path); } catch { return path; } };

const stateRank = (state: string): number => {
  if (["failed", "uncertain", "blocked"].includes(state)) return 100;
  if (["rejected", "cancelled"].includes(state)) return 90;
  if (["pending", "awaiting_decision", "waiting_approval", "approval_required", "needs_input"].includes(state)) return 80;
  if (["approved", "claimed", "running", "accepted", "verifying", "recovering", "continued", "awaiting_verification"].includes(state)) return 70;
  if (["completed", "shadow_completed", "stopped"].includes(state)) return 20;
  return 40;
};
const pendingApproval = (state: string): boolean => ["pending", "awaiting_decision", "waiting_approval", "approval_required", "needs_input"].includes(state);

export class TaskTimeline {
  constructor(private readonly authority: AuthorityDb) {}

  private rows(sql: string, ...params: unknown[]): Row[] { return this.authority.db.prepare(sql).all(...params) as Row[]; }
  private row(sql: string, ...params: unknown[]): Row | undefined { return this.authority.db.prepare(sql).get(...params) as Row | undefined; }
  private totalChanges(): number { return Number(this.row("SELECT total_changes() AS count")?.count ?? 0); }
  private readOnly<T>(fn: () => T): T {
    const before = this.totalChanges(); const result = fn(); const after = this.totalChanges();
    if (after !== before) throw new JarvisError("TASK_TIMELINE_MUTATED");
    return result;
  }
  private inRows(sqlPrefix: string, ids: Iterable<string>, sqlSuffix = ""): Row[] {
    const items = values(ids); if (items.length === 0) return [];
    return this.rows(`${sqlPrefix} (${items.map(() => "?").join(",")}) ${sqlSuffix}`, ...items);
  }
  private add(set: Set<string>, value: unknown): boolean { const item = optional(value); if (!item || set.has(item)) return false; set.add(item); return true; }
  private graphIds(graph: TimelineGraph): Set<string> { return new Set([...graph.ids, ...graph.workIds, ...graph.continuationIds, ...graph.controlIds, ...graph.runIds, ...graph.intentIds, ...graph.questionIds, ...graph.projectIds]); }
  private controlTaskId(request: Row, fallback: string): string {
    const target = rowJson(request.target_json); const args = rowJson(request.args_json);
    return optional(target.task_id) ?? optional(target.work_id) ?? optional(target.correlation_id) ?? optional(args.task_id) ?? optional(args.work_id) ?? optional(args.correlation_id) ?? fallback;
  }
  private addJsonReferences(graph: TimelineGraph, value: unknown): boolean {
    const payload = rowJson(value); let changed = false;
    for (const key of ["task_id", "work_id"] as const) changed = this.add(graph.workIds, payload[key]) || changed;
    for (const key of ["run_id"] as const) changed = this.add(graph.runIds, payload[key]) || changed;
    for (const key of ["request_id"] as const) changed = this.add(graph.controlIds, payload[key]) || changed;
    for (const key of ["continuation_id"] as const) changed = this.add(graph.continuationIds, payload[key]) || changed;
    for (const key of ["intent_id"] as const) changed = this.add(graph.intentIds, payload[key]) || changed;
    for (const key of ["question_id"] as const) changed = this.add(graph.questionIds, payload[key]) || changed;
    for (const key of ["project_id"] as const) changed = this.add(graph.projectIds, payload[key]) || changed;
    if (isRow(payload.input)) changed = this.addJsonReferences(graph, payload.input) || changed;
    return changed;
  }
  private relatedControlRequestsFor(ids: Iterable<string>): Row[] {
    const items = values(ids); if (items.length === 0) return [];
    const placeholders = items.map(() => "?").join(",");
    const jsonPaths = ["$.task_id", "$.work_id", "$.run_id", "$.correlation_id", "$.request_id", "$.continuation_id", "$.intent_id", "$.question_id", "$.project_id"];
    const predicates = [`request_id IN (${placeholders})`]; const params: unknown[] = [...items];
    for (const column of ["target_json", "args_json"]) for (const path of jsonPaths) { predicates.push(`json_extract(${column},'${path}') IN (${placeholders})`); params.push(...items); }
    return this.rows(`SELECT * FROM control_command_requests WHERE ${predicates.join(" OR ")} ORDER BY requested_at,request_id`, ...params);
  }
  private relatedWorkflowRunsFor(ids: Iterable<string>): Row[] {
    const items = values(ids); if (items.length === 0) return [];
    const placeholders = items.map(() => "?").join(",");
    const params: unknown[] = [...items, ...items];
    const jsonPaths = ["$.task_id", "$.work_id", "$.request_id", "$.correlation_id", "$.run_id", "$.continuation_id", "$.intent_id", "$.project_id"];
    const predicates = [`run_id IN (${placeholders})`, `correlation_id IN (${placeholders})`];
    for (const path of jsonPaths) { predicates.push(`json_extract(input_json,'${path}') IN (${placeholders})`); params.push(...items); }
    return this.rows(`SELECT * FROM workflow_runs WHERE ${predicates.join(" OR ")} ORDER BY created_at,run_id`, ...params);
  }
  private relatedGjcIntentsFor(ids: Iterable<string>, questionIds: Iterable<string>): Row[] {
    const items = values(ids); const questions = values(questionIds); const predicates: string[] = []; const params: unknown[] = [];
    if (items.length > 0) {
      const placeholders = items.map(() => "?").join(",");
      predicates.push(`intent_id IN (${placeholders})`, `continuation_id IN (${placeholders})`, `json_extract(payload_json,'$.continuation_id') IN (${placeholders})`);
      params.push(...items, ...items, ...items);
    }
    if (questions.length > 0) { const placeholders = questions.map(() => "?").join(","); predicates.push(`json_extract(payload_json,'$.question_id') IN (${placeholders})`); params.push(...questions); }
    if (predicates.length === 0) return [];
    return this.rows(`SELECT * FROM gjc_intents WHERE ${predicates.join(" OR ")} ORDER BY created_at,intent_id`, ...params);
  }
  private addBindings(graph: TimelineGraph): boolean {
    const projectIds = values(graph.projectIds); const canonicalPaths = values(graph.canonicalPaths); const worktreeIds = values(graph.worktreeIds);
    const predicates: string[] = []; const params: unknown[] = [];
    if (projectIds.length > 0) { predicates.push(`project_id IN (${projectIds.map(() => "?").join(",")})`); params.push(...projectIds); }
    if (canonicalPaths.length > 0) { predicates.push(`canonical_path IN (${canonicalPaths.map(() => "?").join(",")})`); params.push(...canonicalPaths); }
    if (projectIds.length === 0 && worktreeIds.length > 0) { predicates.push(`worktree_id IN (${worktreeIds.map(() => "?").join(",")})`); params.push(...worktreeIds); }
    if (predicates.length === 0) return false;
    let changed = false;
    for (const row of this.rows(`SELECT canonical_path,provider,terminal_id,session_id,incarnation_id,pty_id,worktree_id,project_id FROM live_supervisor_bindings WHERE ${predicates.join(" OR ")} ORDER BY canonical_path,provider,terminal_id`, ...params)) {
      const matchesProject = projectIds.length > 0 && projectIds.includes(string(row.project_id));
      const matchesPath = canonicalPaths.includes(string(row.canonical_path));
      const matchesWorktreeOnly = projectIds.length === 0 && worktreeIds.includes(string(row.worktree_id));
      if (!matchesProject && !matchesPath && !matchesWorktreeOnly) continue;
      const key = bindingKey(row); if (graph.bindings.has(key)) continue;
      graph.bindings.set(key, row); changed = true;
      changed = this.add(graph.canonicalPaths, row.canonical_path) || changed;
      changed = this.add(graph.projectIds, row.project_id) || changed;
      changed = this.add(graph.worktreeIds, row.worktree_id) || changed;
    }
    return changed;
  }
  private buildGraph(taskId: string): TimelineGraph {
    const graph: TimelineGraph = { ids: new Set([taskId]), workIds: new Set(), continuationIds: new Set(), controlIds: new Set(), runIds: new Set(), intentIds: new Set(), questionIds: new Set(), projectIds: new Set(), worktreeIds: new Set(), canonicalPaths: new Set(taskId.startsWith("/") ? [taskId] : []), bindings: new Map(), sourceIds: new Set() };
    for (let pass = 0; pass < 8; pass++) {
      let changed = false; const ids = this.graphIds(graph);
      for (const row of this.inRows("SELECT w.id,w.action,w.state,w.created_at,w.worktree_id,w.terminal_kind,w.terminal_session_id,p.id AS project_id FROM work_items w JOIN census_snapshots s ON s.id=w.snapshot_id JOIN projects p ON p.id=s.project_id WHERE w.id IN", ids, "ORDER BY w.created_at,w.id")) {
        changed = this.add(graph.workIds, row.id) || changed; changed = this.add(graph.sourceIds, row.id) || changed; changed = this.add(graph.projectIds, row.project_id) || changed; changed = this.add(graph.worktreeIds, row.worktree_id) || changed;
      }
      const continuationKeys = new Set([...ids, ...graph.workIds]);
      for (const row of this.inRows("SELECT * FROM continuation_acceptances WHERE id IN", continuationKeys, "ORDER BY created_at,id")) { changed = this.add(graph.continuationIds, row.id) || changed; changed = this.add(graph.workIds, row.work_id) || changed; changed = this.add(graph.sourceIds, row.id) || changed; }
      for (const row of this.inRows("SELECT * FROM continuation_acceptances WHERE work_id IN", graph.workIds, "ORDER BY created_at,id")) { changed = this.add(graph.continuationIds, row.id) || changed; changed = this.add(graph.workIds, row.work_id) || changed; changed = this.add(graph.sourceIds, row.id) || changed; }
      for (const request of this.relatedControlRequestsFor(this.graphIds(graph))) {
        changed = this.add(graph.controlIds, request.request_id) || changed; changed = this.add(graph.sourceIds, request.request_id) || changed;
        changed = this.addJsonReferences(graph, request.target_json) || changed; changed = this.addJsonReferences(graph, request.args_json) || changed;
      }
      for (const run of this.relatedWorkflowRunsFor(this.graphIds(graph))) {
        changed = this.add(graph.runIds, run.run_id) || changed; changed = this.add(graph.sourceIds, run.run_id) || changed; changed = this.add(graph.ids, run.correlation_id) || changed; changed = this.addJsonReferences(graph, run.input_json) || changed;
      }
      for (const approval of this.inRows("SELECT * FROM workflow_step_approvals WHERE run_id IN", graph.runIds, "ORDER BY created_at,approval_id")) { changed = this.add(graph.controlIds, approval.request_id) || changed; changed = this.add(graph.sourceIds, approval.request_id) || changed; }
      for (const intent of this.relatedGjcIntentsFor(this.graphIds(graph), graph.questionIds)) {
        changed = this.add(graph.intentIds, intent.intent_id) || changed; changed = this.add(graph.sourceIds, intent.intent_id) || changed; changed = this.add(graph.continuationIds, intent.continuation_id) || changed; changed = this.addJsonReferences(graph, intent.payload_json) || changed;
      }
      for (const question of this.inRows("SELECT * FROM gjc_questions WHERE intent_id IN", graph.intentIds, "ORDER BY created_at,question_id")) { changed = this.add(graph.questionIds, question.question_id) || changed; changed = this.add(graph.intentIds, question.intent_id) || changed; }
      for (const question of this.inRows("SELECT * FROM gjc_questions WHERE question_id IN", this.graphIds(graph), "ORDER BY created_at,question_id")) { changed = this.add(graph.questionIds, question.question_id) || changed; changed = this.add(graph.intentIds, question.intent_id) || changed; }
      changed = this.addBindings(graph) || changed;
      if (!changed) break;
    }
    return graph;
  }
  private graphPendingApproval(graph: TimelineGraph): boolean {
    if (this.inRows("SELECT request_id FROM control_command_requests WHERE state='pending' AND request_id IN", graph.controlIds).length > 0) return true;
    if (this.inRows("SELECT run_id FROM workflow_runs WHERE state='waiting_approval' AND run_id IN", graph.runIds).length > 0) return true;
    if (this.inRows("SELECT question_id FROM gjc_questions WHERE state='open' AND question_id IN", graph.questionIds).length > 0) return true;
    const projects = values(graph.projectIds); if (projects.length > 0 && this.inRows("SELECT request_id FROM pre_gjc_authority_requests WHERE state='pending' AND project_id IN", projects).length > 0) return true;
    return false;
  }
  private sourceIds(graph: TimelineGraph, fallback: string): string[] { const ids = values(graph.sourceIds).sort(); return ids.length > 0 ? ids : [fallback]; }
  private summaryFromGraph(taskId: string, graph: TimelineGraph): TaskTimelineSummary | undefined {
    const sourceIds = this.sourceIds(graph, taskId); const extraPending = this.graphPendingApproval(graph);
    const workRows = this.inRows("SELECT w.id,w.action,w.state,w.created_at,p.state AS projection_state,p.updated_at AS projection_updated,(SELECT MAX(created_at) FROM event_ledger WHERE work_id=w.id) AS ledger_at FROM work_items w LEFT JOIN work_projection p ON p.work_id=w.id WHERE w.id IN", graph.workIds, "ORDER BY w.created_at,w.id");
    if (workRows.length > 0) {
      const exact = workRows.find(row => row.id === taskId) ?? workRows.sort((left, right) => latest(right.projection_updated, right.ledger_at, right.created_at).localeCompare(latest(left.projection_updated, left.ledger_at, left.created_at)))[0]!;
      const state = optional(exact.projection_state) ?? string(exact.state);
      return { task_id: string(exact.id), title: string(exact.action), kind: "work", state, updated_at: latest(exact.projection_updated, exact.ledger_at, exact.created_at), pending_approval: pendingApproval(state) || extraPending, source_ids: sourceIds };
    }
    let summary: TaskTimelineSummary | undefined;
    const consider = (candidate: TaskTimelineSummary): void => {
      if (!summary) { summary = candidate; return; }
      const newer = Date.parse(candidate.updated_at) >= Date.parse(summary.updated_at);
      const stronger = stateRank(candidate.state) > stateRank(summary.state);
      summary = { task_id: newer ? candidate.task_id : summary.task_id, title: newer ? candidate.title : summary.title, kind: newer ? candidate.kind : summary.kind, state: stronger || newer ? candidate.state : summary.state, updated_at: newer ? candidate.updated_at : summary.updated_at, pending_approval: summary.pending_approval || candidate.pending_approval, source_ids: [...new Set([...summary.source_ids, ...candidate.source_ids])].sort() };
    };
    for (const request of this.inRows("SELECT request_id,action,state,COALESCE(completed_at,requested_at,created_at) AS updated_at,target_json,args_json FROM control_command_requests WHERE request_id IN", graph.controlIds, "ORDER BY updated_at,request_id")) {
      const state = string(request.state); consider({ task_id: this.controlTaskId(request, taskId), title: string(request.action), kind: "command", state, updated_at: string(request.updated_at), pending_approval: state === "pending" || extraPending, source_ids: sourceIds });
    }
    for (const run of this.inRows("SELECT run_id,loop_id,state,correlation_id,updated_at FROM workflow_runs WHERE run_id IN", graph.runIds, "ORDER BY updated_at,run_id")) {
      const state = string(run.state); consider({ task_id: string(run.correlation_id) || taskId, title: string(run.loop_id), kind: "workflow", state, updated_at: string(run.updated_at), pending_approval: state === "waiting_approval" || extraPending, source_ids: sourceIds });
    }
    for (const intent of this.inRows("SELECT intent_id,continuation_id,kind,state,COALESCE(completed_at,accepted_at,created_at) AS updated_at FROM gjc_intents WHERE intent_id IN", graph.intentIds, "ORDER BY updated_at,intent_id")) {
      const state = string(intent.state); consider({ task_id: optional(intent.continuation_id) ?? taskId, title: `GJC ${string(intent.kind)}`, kind: "agent", state, updated_at: string(intent.updated_at), pending_approval: extraPending, source_ids: sourceIds });
    }
    return summary;
  }

  list(limit = 100): TaskTimelineSummary[] {
    return this.readOnly(() => {
      const maximum = clamp(limit, 1, 500); const tasks = new Map<string, TaskTimelineSummary>();
      const upsert = (candidate: TaskTimelineSummary): void => {
        const prior = tasks.get(candidate.task_id);
        if (!prior) { tasks.set(candidate.task_id, candidate); return; }
        const newer = Date.parse(candidate.updated_at) >= Date.parse(prior.updated_at);
        const stronger = stateRank(candidate.state) > stateRank(prior.state);
        tasks.set(candidate.task_id, {
          task_id: candidate.task_id,
          title: newer ? candidate.title : prior.title,
          kind: newer ? candidate.kind : prior.kind,
          state: stronger || newer ? candidate.state : prior.state,
          updated_at: newer ? candidate.updated_at : prior.updated_at,
          pending_approval: prior.pending_approval || candidate.pending_approval,
          source_ids: [...new Set([...prior.source_ids, ...candidate.source_ids])].sort(),
        });
      };
      for (const item of this.rows("SELECT id,action,state,created_at FROM work_items ORDER BY created_at DESC,id DESC LIMIT ?", maximum)) {
        const state = string(item.state); upsert({ task_id: string(item.id), title: string(item.action), kind: "work", state, updated_at: string(item.created_at), pending_approval: pendingApproval(state), source_ids: [string(item.id)] });
      }
      for (const item of this.rows("SELECT request_id,action,state,COALESCE(completed_at,requested_at,created_at) AS updated_at,target_json,args_json FROM control_command_requests ORDER BY updated_at DESC,request_id DESC LIMIT ?", maximum)) {
        const taskId = this.controlTaskId(item, string(item.request_id));
        const state = string(item.state); upsert({ task_id: taskId, title: string(item.action), kind: "command", state, updated_at: string(item.updated_at), pending_approval: state === "pending", source_ids: [string(item.request_id)] });
      }
      for (const item of this.rows("SELECT run_id,loop_id,state,correlation_id,updated_at FROM workflow_runs ORDER BY updated_at DESC,run_id DESC LIMIT ?", maximum)) {
        const state = string(item.state); const taskId = string(item.correlation_id) || string(item.run_id); upsert({ task_id: taskId, title: string(item.loop_id), kind: "workflow", state, updated_at: string(item.updated_at), pending_approval: state === "waiting_approval", source_ids: [string(item.run_id)] });
      }
      for (const item of this.rows("SELECT intent_id,continuation_id,kind,state,COALESCE(completed_at,accepted_at,created_at) AS updated_at FROM gjc_intents ORDER BY updated_at DESC,intent_id DESC LIMIT ?", maximum)) {
        const state = string(item.state); const taskId = optional(item.continuation_id) ?? string(item.intent_id); upsert({ task_id: taskId, title: `GJC ${string(item.kind)}`, kind: "agent", state, updated_at: string(item.updated_at), pending_approval: false, source_ids: [string(item.intent_id)] });
      }
      return [...tasks.values()].sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.task_id.localeCompare(right.task_id)).slice(0, maximum);
    });
  }

  private summary(taskId: string): TaskTimelineSummary | undefined { return this.summaryFromGraph(taskId, this.buildGraph(taskId)); }

  private relatedControlRequests(taskId: string): Row[] { return this.relatedControlRequestsFor([taskId]); }
  private relatedWorkflowRuns(taskId: string): Row[] { return this.relatedWorkflowRunsFor([taskId]); }

  private addWorkEvents(taskId: string, graph: TimelineGraph, add: (event: MutableEvent) => void): void {
    for (const work of this.inRows("SELECT * FROM work_items WHERE id IN", graph.workIds, "ORDER BY created_at,id")) {
      const workId = string(work.id);
      add({ event_id: `work:${workId}:observed`, task_id: taskId, source: "work", kind: "status", actor: "jarvis", title: string(work.action), status: string(work.state), payload: { work_id: workId, authorization: work.authorization, deadline: work.deadline, repo_id: work.repo_id, worktree_id: work.worktree_id }, evidence_refs: evidence(work.action_digest, work.scope_digest, work.budget_digest), created_at: string(work.created_at) });
      for (const row of this.rows("SELECT * FROM event_ledger WHERE work_id=? ORDER BY seq", workId)) add({ event_id: `work-ledger:${string(row.seq)}`, task_id: taskId, source: "work", kind: string(row.event_type).includes("verification") ? "verification" : "status", actor: "jarvis", title: string(row.event_type), status: string(row.event_type), payload: parse(row.payload_json), evidence_refs: [], created_at: string(row.created_at) });
      for (const row of this.rows("SELECT * FROM audit_facts WHERE subject_id=? ORDER BY seq", workId)) add({ event_id: `audit:${string(row.seq)}`, task_id: taskId, source: "work", kind: "system", actor: "jarvis-audit", title: string(row.fact_type), status: null, payload: parse(row.payload_json), evidence_refs: [], created_at: string(row.created_at) });
      for (const row of this.rows("SELECT * FROM verification_evidence WHERE work_id=? ORDER BY created_at,evidence_id", workId)) add({ event_id: string(row.evidence_id), task_id: taskId, source: "verification", kind: "verification", actor: string(row.signer_key_id), title: "verification.evidence", status: "recorded", payload: parse(row.payload_json), evidence_refs: evidence(row.evidence_id), created_at: string(row.created_at) });
    }
    for (const row of this.inRows("SELECT * FROM continuation_acceptances WHERE id IN", graph.continuationIds, "ORDER BY created_at,id")) add({ event_id: `continuation:${string(row.id)}`, task_id: taskId, source: "work", kind: "status", actor: "authority", title: "continuation.accepted", status: string(row.status || "accepted"), payload: row, evidence_refs: evidence(row.authorization_id), created_at: string(row.created_at) });
    for (const row of this.inRows("SELECT * FROM outbox WHERE continuation_id IN", graph.continuationIds, "ORDER BY created_at,intent_id")) add({ event_id: string(row.intent_id), task_id: taskId, source: "gjc", kind: "agent", actor: "shadow-outbox", title: `outbox.${string(row.kind)}`, status: optional(row.outcome) ?? (row.acked_at ? "acked" : row.delivered_at ? "delivered" : "pending"), payload: parse(row.payload_json), evidence_refs: [], created_at: string(row.created_at) });
  }
  private addControlEvents(taskId: string, graph: TimelineGraph, add: (event: MutableEvent) => void): void {
    for (const request of this.inRows("SELECT * FROM control_command_requests WHERE request_id IN", graph.controlIds, "ORDER BY requested_at,request_id")) {
      const requestId = string(request.request_id);
      for (const row of this.rows("SELECT * FROM control_events WHERE subject=? OR correlation_id=? ORDER BY seq", requestId, requestId)) add({ event_id: string(row.event_id), task_id: taskId, source: "control", kind: string(row.event_type).includes("approved") || string(row.event_type).includes("rejected") ? "approval" : "command", actor: string(row.source), title: string(row.event_type), status: optional(rowJson(row.payload_json).state) ?? string(row.event_type).split(".").at(-1) ?? null, payload: parse(row.payload_json), evidence_refs: evidence(row.payload_digest), created_at: string(row.created_at) });
      for (const row of this.rows("SELECT * FROM control_command_receipts WHERE request_id=? ORDER BY created_at,receipt_id", requestId)) add({ event_id: string(row.receipt_id), task_id: taskId, source: "control", kind: "approval", actor: string(row.signer_principal_id), title: `approval.${string(row.decision)}`, status: string(row.decision), payload: { authenticated_session_id: row.authenticated_session_id, key_id: row.key_id, expires_at: row.expires_at }, evidence_refs: evidence(row.command_digest), created_at: string(row.created_at) });
      for (const row of this.rows("SELECT * FROM control_command_effects WHERE request_id=? ORDER BY created_at,effect_id", requestId)) add({ event_id: string(row.effect_id), task_id: taskId, source: "control", kind: "command", actor: "approved-executor", title: string(row.effect_type), status: string(request.state), payload: parse(row.payload_json), evidence_refs: evidence(row.payload_digest), created_at: string(row.created_at) });
      for (const row of this.rows("SELECT * FROM control_command_revocations WHERE request_id=? ORDER BY created_at,revocation_id", requestId)) add({ event_id: string(row.revocation_id), task_id: taskId, source: "control", kind: "command", actor: string(row.revoked_by), title: "control.command.revoked", status: "cancelled", payload: parse(row.payload_json), evidence_refs: evidence(row.payload_digest), created_at: string(row.created_at) });
      for (const row of this.rows("SELECT * FROM control_effect_attempts WHERE request_id=? ORDER BY created_at,attempt_id", requestId)) add({ event_id: string(row.attempt_id), task_id: taskId, source: "control", kind: "command", actor: "approved-executor", title: `effect.${string(row.effect_type)}`, status: string(row.state), payload: { receipt_digest: row.receipt_digest, error_code: row.error_code }, evidence_refs: evidence(row.idempotency_key, row.receipt_digest), created_at: string(row.created_at) });
    }
    for (const id of this.graphIds(graph)) for (const row of this.rows("SELECT * FROM control_events WHERE correlation_id=? OR subject=? ORDER BY seq", id, id)) add({ event_id: string(row.event_id), task_id: taskId, source: "control", kind: string(row.event_type).startsWith("workflow.") ? "workflow" : "command", actor: string(row.source), title: string(row.event_type), status: string(row.event_type).split(".").at(-1) ?? null, payload: parse(row.payload_json), evidence_refs: evidence(row.payload_digest), created_at: string(row.created_at) });
  }
  private addWorkflowEvents(taskId: string, graph: TimelineGraph, add: (event: MutableEvent) => void): void {
    for (const run of this.inRows("SELECT * FROM workflow_runs WHERE run_id IN", graph.runIds, "ORDER BY created_at,run_id")) {
      const runId = string(run.run_id);
      add({ event_id: `workflow:${runId}:state`, task_id: taskId, source: "workflow", kind: "workflow", actor: "jarvis-loopgraph", title: string(run.loop_id), status: string(run.state), payload: { run_id: runId, current_node: run.current_node, attempts: run.attempts, failure_code: run.failure_code }, evidence_refs: [], created_at: string(run.created_at) });
      for (const row of this.rows("SELECT * FROM workflow_steps WHERE run_id=? ORDER BY created_at,step_id", runId)) add({ event_id: string(row.step_id), task_id: taskId, source: "workflow", kind: string(row.node_id) === "verify" ? "verification" : "workflow", actor: string(row.node_id), title: `workflow.${string(row.node_id)}`, status: string(row.outcome), payload: parse(row.output_json), evidence_refs: evidence(row.output_digest, row.evidence_digest), created_at: string(row.created_at) });
      for (const row of this.rows("SELECT * FROM workflow_transitions WHERE run_id=? ORDER BY created_at,transition_id", runId)) add({ event_id: string(row.transition_id), task_id: taskId, source: "workflow", kind: "workflow", actor: "jarvis-loopgraph", title: "workflow.transitioned", status: string(row.outcome), payload: { from_node: row.from_node, to_node: row.to_node, approval_receipt_id: row.approval_receipt_id }, evidence_refs: evidence(row.evidence_digest), created_at: string(row.created_at) });
      for (const row of this.rows("SELECT * FROM workflow_step_approvals WHERE run_id=? ORDER BY created_at,approval_id", runId)) add({ event_id: string(row.approval_id), task_id: taskId, source: "workflow", kind: "approval", actor: "jarvis-loopgraph", title: "workflow.approval.receipt", status: "approve", payload: { step_id: row.step_id, transition_id: row.transition_id, request_id: row.request_id, receipt_id: row.receipt_id }, evidence_refs: evidence(row.command_digest), created_at: string(row.created_at) });
    }
  }
  private addGjcEvents(taskId: string, graph: TimelineGraph, add: (event: MutableEvent) => void): void {
    for (const intent of this.inRows("SELECT * FROM gjc_intents WHERE intent_id IN", graph.intentIds, "ORDER BY created_at,intent_id")) {
      const intentId = string(intent.intent_id);
      add({ event_id: `gjc:${intentId}:state`, task_id: taskId, source: "gjc", kind: "agent", actor: "gjc-coordinator", title: `gjc.${string(intent.kind)}`, status: string(intent.state), payload: { intent_id: intentId, continuation_id: intent.continuation_id, attempts: intent.attempts, failure_code: intent.failure_code, receipt: parse(intent.receipt_json) }, evidence_refs: evidence(intent.payload_digest), created_at: string(intent.created_at) });
      for (const row of this.rows("SELECT * FROM gjc_intent_events WHERE intent_id=? ORDER BY sequence", intentId)) add({ event_id: `gjc-event:${string(row.sequence)}`, task_id: taskId, source: "gjc", kind: "agent", actor: "gjc-runtime", title: string(row.event_type), status: string(row.event_type), payload: parse(row.payload_json), evidence_refs: [], created_at: string(row.created_at) });
      for (const row of this.rows("SELECT * FROM gjc_dispatch_receipts WHERE intent_id=? ORDER BY accepted_at,intent_id", intentId)) add({ event_id: `gjc-dispatch-receipt:${intentId}`, task_id: taskId, source: "gjc", kind: "agent", actor: "gjc-coordinator", title: "gjc.dispatch.receipt", status: "accepted", payload: parse(row.receipt_json), evidence_refs: [], created_at: string(row.accepted_at) });
      for (const row of this.rows("SELECT * FROM gjc_answer_receipts WHERE intent_id=? ORDER BY completed_at,intent_id", intentId)) add({ event_id: `gjc-answer-receipt:${intentId}`, task_id: taskId, source: "gjc", kind: "agent", actor: "gjc-coordinator", title: "gjc.answer.receipt", status: "completed", payload: parse(row.receipt_json), evidence_refs: [], created_at: string(row.completed_at) });
      for (const row of this.rows("SELECT * FROM gjc_questions WHERE intent_id=? ORDER BY created_at,question_id", intentId)) add({ event_id: string(row.question_id), task_id: taskId, source: "gjc", kind: "approval", actor: "gjc-coordinator", title: "agent.question", status: string(row.state), payload: parse(row.snapshot_json), evidence_refs: evidence(row.snapshot_digest), created_at: string(row.created_at) });
    }
    for (const question of this.inRows("SELECT * FROM gjc_question_answers WHERE question_id IN", graph.questionIds, "ORDER BY created_at,question_id")) add({ event_id: `answer:${string(question.question_id)}`, task_id: taskId, source: "gjc", kind: "approval", actor: "operator", title: "agent.answer", status: "answered", payload: { answer: parse(question.answer_json), receipt: parse(question.receipt_json) }, evidence_refs: evidence(question.answer_digest), created_at: string(question.created_at) });
  }
  private addProgressEvents(taskId: string, graph: TimelineGraph, add: (event: MutableEvent) => void): void {
    const seen = new Set<string>();
    for (const binding of graph.bindings.values()) {
      const canonicalBindingPath = string(binding.canonical_path);
      for (const row of this.rows("SELECT o.*,p.state AS projection_state,p.cursor AS projection_cursor,p.observed_at AS projection_observed_at,p.updated_at AS projection_updated_at FROM progress_observations o LEFT JOIN progress_projection p ON p.worktree_selector=o.worktree_selector AND p.provider=o.provider AND p.terminal_handle=o.terminal_handle AND p.observation_identity=o.observation_identity WHERE o.provider=? AND o.terminal_handle=? ORDER BY o.created_at,o.observation_identity", binding.provider, binding.terminal_id)) {
        if (canonicalPath(row.worktree_selector) !== canonicalBindingPath) continue;
        const eventId = string(row.observation_identity); if (seen.has(eventId)) continue; seen.add(eventId);
        const assessment = rowJson(row.assessment_json);
        add({ event_id: eventId, task_id: taskId, source: "progress", kind: "agent", actor: string(row.provider), title: "agent.progress", status: optional(assessment.state) ?? optional(row.projection_state), payload: { ...assessment, projection: optional(row.projection_state) ? { state: row.projection_state, cursor: row.projection_cursor, observed_at: row.projection_observed_at, updated_at: row.projection_updated_at } : null }, evidence_refs: evidence(row.observation_identity), created_at: string(row.created_at) });
      }
    }
  }
  private addNegativeEvidenceEvents(taskId: string, graph: TimelineGraph, add: (event: MutableEvent) => void): void {
    const requestIds = values(graph.controlIds);
    const predicates = ["task_id=?"];
    const params: unknown[] = [taskId];
    if (requestIds.length > 0) {
      predicates.push(`request_id IN (${requestIds.map(() => "?").join(",")})`);
      params.push(...requestIds);
    }
    for (const row of this.rows(`SELECT evidence_id,task_id,attempt_id,reason_code,evidence_digest,created_at FROM negative_evidence WHERE ${predicates.join(" OR ")} ORDER BY created_at,evidence_id`, ...params)) {
      add({ event_id: string(row.evidence_id), task_id: taskId, source: "control", kind: "evidence", actor: "approved-executor", title: "evidence.negative.recorded", status: string(row.reason_code), payload: { reason_code: row.reason_code, evidence_digest: row.evidence_digest, attempt_id: row.attempt_id }, evidence_refs: evidence(row.evidence_id, row.evidence_digest), created_at: string(row.created_at) });
    }
  }
  private addPreGjcEvents(taskId: string, graph: TimelineGraph, add: (event: MutableEvent) => void): void {
    const projects = values(graph.projectIds);
    if (projects.length === 0) return;
    const relatedTelemetry = (value: unknown): boolean => {
      const telemetry = rowJson(value); const ids = this.graphIds(graph);
      return [telemetry.task_id, telemetry.work_id, telemetry.correlation_id, telemetry.run_id].some(item => optional(item) !== null && ids.has(string(item)));
    };
    for (const row of this.inRows("SELECT * FROM pre_gjc_improvement_proposals WHERE project_id IN", projects, "ORDER BY created_at,proposal_id")) if (relatedTelemetry(row.telemetry_json)) add({ event_id: string(row.proposal_id), task_id: taskId, source: "control", kind: "system", actor: "pre-gjc-shadow", title: "correlation.proposed", status: "untrusted", payload: { project_id: row.project_id, trust: "untrusted", state: row.state, telemetry: parse(row.telemetry_json) }, evidence_refs: [], created_at: string(row.created_at) });
    for (const row of this.inRows("SELECT * FROM pre_gjc_authority_requests WHERE project_id IN", projects, "ORDER BY created_at,request_id")) add({ event_id: string(row.request_id), task_id: taskId, source: "control", kind: "approval", actor: "pre-gjc-shadow", title: `pre_gjc.authority.${string(row.authority_kind)}`, status: string(row.state), payload: row, evidence_refs: evidence(row.request_digest), created_at: string(row.created_at) });
    for (const row of this.inRows("SELECT * FROM pre_gjc_resume_intents WHERE project_id IN", projects, "ORDER BY created_at,intent_id")) add({ event_id: string(row.intent_id), task_id: taskId, source: "control", kind: "command", actor: "pre-gjc-shadow", title: "pre_gjc.resume.intent", status: string(row.state), payload: row, evidence_refs: [], created_at: string(row.created_at) });
    for (const row of this.inRows("SELECT * FROM pre_gjc_policy_resume_intents WHERE project_id IN", projects, "ORDER BY created_at,intent_id")) add({ event_id: string(row.intent_id), task_id: taskId, source: "control", kind: "command", actor: "pre-gjc-shadow", title: "pre_gjc.policy_resume.intent", status: string(row.state), payload: row, evidence_refs: evidence(row.config_digest, row.prompt_digest), created_at: string(row.created_at) });
    for (const row of this.inRows("SELECT * FROM pre_gjc_completion_evidence WHERE project_id IN", projects, "ORDER BY signed_at,evidence_id")) add({ event_id: string(row.evidence_id), task_id: taskId, source: "verification", kind: "evidence", actor: "pre-gjc-shadow", title: `pre_gjc.evidence.${string(row.kind)}`, status: "recorded", payload: parse(row.payload_json), evidence_refs: evidence(row.evidence_id), created_at: string(row.signed_at) });
    for (const row of this.inRows("SELECT * FROM pre_gjc_boundary_audits WHERE project_id IN", projects, "ORDER BY created_at,audit_id")) add({ event_id: string(row.audit_id), task_id: taskId, source: "progress", kind: "status", actor: "pre-gjc-shadow", title: "pre_gjc.boundary", status: string(row.aggregate_status), payload: row, evidence_refs: [], created_at: string(row.created_at) });
  }

  timeline(taskId: string, limit = 200): TaskTimelineEvent[] { return this.readOnly(() => this.timelineUnsafe(taskId, limit)); }
  private timelineUnsafe(taskId: string, limit = 200, graph = this.buildGraph(taskId)): TaskTimelineEvent[] {
    if (!nonempty(taskId)) throw new JarvisError("TASK_TIMELINE_INVALID");
    const maximum = clamp(limit, 1, 1000); const events: MutableEvent[] = []; const eventIds = new Set<string>();
    const add = (event: MutableEvent): void => { if (eventIds.has(event.event_id)) return; eventIds.add(event.event_id); events.push(event); };

    this.addWorkEvents(taskId, graph, add);
    this.addControlEvents(taskId, graph, add);
    this.addNegativeEvidenceEvents(taskId, graph, add);
    this.addWorkflowEvents(taskId, graph, add);
    this.addGjcEvents(taskId, graph, add);
    this.addProgressEvents(taskId, graph, add);
    this.addPreGjcEvents(taskId, graph, add);

    const sorted = events.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.source.localeCompare(right.source) || left.event_id.localeCompare(right.event_id));
    if (sorted.length === 0 && !this.summaryFromGraph(taskId, graph)) throw new JarvisError("TASK_TIMELINE_NOT_FOUND");
    return sorted.slice(Math.max(0, sorted.length - maximum)).map((event, index) => ({ ...event, sequence: index + 1 }));
  }

  context(taskId: string, limit = 100, maxBytes = 128 * 1024, now = new Date()): TaskTimelineContext {
    return this.readOnly(() => {
      const graph = this.buildGraph(taskId); const task = this.summaryFromGraph(taskId, graph); if (!task) throw new JarvisError("TASK_TIMELINE_NOT_FOUND");
      const controls = this.inRows("SELECT * FROM control_command_requests WHERE request_id IN", graph.controlIds, "ORDER BY requested_at,request_id");
      const intentIds = values(graph.intentIds);
      const pendingDecisions: unknown[] = controls.filter(item => item.state === "pending").map(item => ({ kind: "command", request_id: item.request_id, action: item.action, action_level: item.action_level, expires_at: item.expires_at }));
      for (const work of this.inRows("SELECT id,action,state,deadline FROM work_items WHERE id IN", graph.workIds, "ORDER BY created_at,id")) if (work.state === "awaiting_decision") pendingDecisions.push({ kind: "work", work_id: work.id, action: work.action, deadline: work.deadline });
      if (intentIds.length > 0) pendingDecisions.push(...this.inRows("SELECT question_id,intent_id,state,created_at FROM gjc_questions WHERE state='open' AND intent_id IN", intentIds, "ORDER BY created_at,question_id"));
      const projects = values(graph.projectIds); if (projects.length > 0) pendingDecisions.push(...this.inRows("SELECT request_id,project_id,authority_kind,state,expires_at FROM pre_gjc_authority_requests WHERE state='pending' AND project_id IN", projects, "ORDER BY created_at,request_id").map(row => ({ kind: "pre_gjc", ...row })));
      const workers = [...graph.bindings.values()].sort((left, right) => string(left.canonical_path).localeCompare(string(right.canonical_path)) || string(left.provider).localeCompare(string(right.provider)) || string(left.terminal_id).localeCompare(string(right.terminal_id)));
      const evidenceRows = [
        ...this.inRows("SELECT evidence_id,signer_key_id,created_at FROM verification_evidence WHERE work_id IN", graph.workIds, "ORDER BY created_at,evidence_id"),
        ...this.inRows("SELECT evidence_id,kind,signed_at AS created_at FROM pre_gjc_completion_evidence WHERE project_id IN", projects, "ORDER BY signed_at,evidence_id"),
      ];
      let events = this.timelineUnsafe(taskId, clamp(Math.max(limit, 1000), 1, 1000), graph); let truncated = false;
      const build = (): TaskTimelineContext => ({ schema_version: 1, generated_at: now.toISOString(), task, events, pending_decisions: pendingDecisions, workers, evidence: evidenceRows, truncated });
      const maximum = clamp(maxBytes, 1024, 1024 * 1024);
      while (events.length > 1 && Buffer.byteLength(canonicalize(build()), "utf8") > maximum) { events = events.slice(1).map((event, index) => ({ ...event, sequence: index + 1 })); truncated = true; }
      if (Buffer.byteLength(canonicalize(build()), "utf8") > maximum) throw new JarvisError("TASK_TIMELINE_CONTEXT_TOO_LARGE");
      return build();
    });
  }
}
