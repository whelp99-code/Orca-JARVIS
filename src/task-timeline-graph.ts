import type { AuthorityDb } from "./db.js";
import {
  bindingKey,
  graphIds,
  isRow,
  optional,
  rowJson,
  string,
  values,
  type Row,
  type TimelineGraph,
} from "./task-timeline-model.js";

export class TaskTimelineGraphReader {
  constructor(private readonly authority: Pick<AuthorityDb, "db">) {}

  private rows(sql: string, ...params: unknown[]): Row[] {
    return this.authority.db.prepare<unknown[], Row>(sql).all(...params);
  }

  private inRows(sqlPrefix: string, ids: Iterable<string>, sqlSuffix = ""): Row[] {
    const items = values(ids);
    if (items.length === 0) return [];
    const placeholders = "SELECT value FROM json_each(?)";
    return this.rows(`${sqlPrefix} (${placeholders}) ${sqlSuffix}`, JSON.stringify(items));
  }

  private add(set: Set<string>, value: unknown): boolean {
    const item = optional(value);
    if (!item || set.has(item)) return false;
    set.add(item);
    return true;
  }

  private addJsonReferences(graph: TimelineGraph, value: unknown): boolean {
    const payload = rowJson(value);
    let changed = false;
    for (const key of ["task_id", "work_id"] as const) {
      changed = this.add(graph.workIds, payload[key]) || changed;
    }
    changed = this.add(graph.runIds, payload["run_id"]) || changed;
    changed = this.add(graph.controlIds, payload["request_id"]) || changed;
    changed = this.add(graph.continuationIds, payload["continuation_id"]) || changed;
    changed = this.add(graph.intentIds, payload["intent_id"]) || changed;
    changed = this.add(graph.questionIds, payload["question_id"]) || changed;
    changed = this.add(graph.projectIds, payload["project_id"]) || changed;
    if (isRow(payload.input)) changed = this.addJsonReferences(graph, payload.input) || changed;
    return changed;
  }

  private relatedControlRequestsFor(ids: Iterable<string>): Row[] {
    const items = values(ids);
    if (items.length === 0) return [];
    const placeholders = "SELECT value FROM json_each(?)";
    const jsonPaths = ["$.task_id", "$.work_id", "$.run_id", "$.correlation_id", "$.request_id",
      "$.continuation_id", "$.intent_id", "$.question_id", "$.project_id"];
    const predicates = [`request_id IN (${placeholders})`];
    const encoded = JSON.stringify(items);
    const params: unknown[] = [encoded];
    for (const column of ["target_json", "args_json"]) {
      for (const path of jsonPaths) {
        predicates.push(`json_extract(${column},'${path}') IN (${placeholders})`);
        params.push(encoded);
      }
    }
    return this.rows(
      `SELECT * FROM control_command_requests WHERE ${predicates.join(" OR ")}
       ORDER BY requested_at,request_id`,
      ...params,
    );
  }

  private relatedWorkflowRunsFor(ids: Iterable<string>): Row[] {
    const items = values(ids);
    if (items.length === 0) return [];
    const placeholders = "SELECT value FROM json_each(?)";
    const encoded = JSON.stringify(items);
    const params: unknown[] = [encoded, encoded];
    const jsonPaths = ["$.task_id", "$.work_id", "$.request_id", "$.correlation_id", "$.run_id",
      "$.continuation_id", "$.intent_id", "$.project_id"];
    const predicates = [`run_id IN (${placeholders})`, `correlation_id IN (${placeholders})`];
    for (const path of jsonPaths) {
      predicates.push(`json_extract(input_json,'${path}') IN (${placeholders})`);
      params.push(encoded);
    }
    return this.rows(
      `SELECT * FROM workflow_runs WHERE ${predicates.join(" OR ")} ORDER BY created_at,run_id`,
      ...params,
    );
  }

  private relatedGjcIntentsFor(ids: Iterable<string>, questionIds: Iterable<string>): Row[] {
    const items = values(ids);
    const questions = values(questionIds);
    const predicates: string[] = [];
    const params: unknown[] = [];
    if (items.length > 0) {
      const placeholders = "SELECT value FROM json_each(?)";
      predicates.push(
        `intent_id IN (${placeholders})`,
        `continuation_id IN (${placeholders})`,
        `json_extract(payload_json,'$.continuation_id') IN (${placeholders})`,
      );
      const encoded = JSON.stringify(items);
      params.push(encoded, encoded, encoded);
    }
    if (questions.length > 0) {
      const placeholders = "SELECT value FROM json_each(?)";
      predicates.push(`json_extract(payload_json,'$.question_id') IN (${placeholders})`);
      params.push(JSON.stringify(questions));
    }
    if (predicates.length === 0) return [];
    return this.rows(
      `SELECT * FROM gjc_intents WHERE ${predicates.join(" OR ")} ORDER BY created_at,intent_id`,
      ...params,
    );
  }

  private addBindings(graph: TimelineGraph): boolean {
    const projectIds = values(graph.projectIds);
    const canonicalPaths = values(graph.canonicalPaths);
    const worktreeIds = values(graph.worktreeIds);
    const predicates: string[] = [];
    const params: unknown[] = [];
    if (projectIds.length > 0) {
      predicates.push(`project_id IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(projectIds));
    }
    if (canonicalPaths.length > 0) {
      predicates.push(`canonical_path IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(canonicalPaths));
    }
    if (projectIds.length === 0 && worktreeIds.length > 0) {
      predicates.push(`worktree_id IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(worktreeIds));
    }
    if (predicates.length === 0) return false;
    let changed = false;
    const sql = `SELECT canonical_path,provider,terminal_id,session_id,incarnation_id,pty_id,
      worktree_id,project_id FROM live_supervisor_bindings
      WHERE ${predicates.join(" OR ")} ORDER BY canonical_path,provider,terminal_id`;
    for (const row of this.rows(sql, ...params)) {
      const matchesProject = projectIds.length > 0 && projectIds.includes(string(row.project_id));
      const matchesPath = canonicalPaths.includes(string(row.canonical_path));
      const matchesWorktreeOnly = projectIds.length === 0
        && worktreeIds.includes(string(row.worktree_id));
      if (!matchesProject && !matchesPath && !matchesWorktreeOnly) continue;
      const key = bindingKey(row);
      if (graph.bindings.has(key)) continue;
      graph.bindings.set(key, row);
      changed = true;
      changed = this.add(graph.canonicalPaths, row.canonical_path) || changed;
      changed = this.add(graph.projectIds, row.project_id) || changed;
      changed = this.add(graph.worktreeIds, row.worktree_id) || changed;
    }
    return changed;
  }

  build(taskId: string): TimelineGraph {
    const graph: TimelineGraph = {
      ids: new Set([taskId]),
      workIds: new Set(),
      continuationIds: new Set(),
      controlIds: new Set(),
      runIds: new Set(),
      intentIds: new Set(),
      questionIds: new Set(),
      projectIds: new Set(),
      worktreeIds: new Set(),
      canonicalPaths: new Set(taskId.startsWith("/") ? [taskId] : []),
      bindings: new Map(),
      sourceIds: new Set(),
    };
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      const ids = graphIds(graph);
      const workSql = `SELECT w.id,w.action,w.state,w.created_at,w.worktree_id,w.terminal_kind,
        w.terminal_session_id,p.id AS project_id FROM work_items w
        JOIN census_snapshots s ON s.id=w.snapshot_id JOIN projects p ON p.id=s.project_id
        WHERE w.id IN`;
      for (const row of this.inRows(workSql, ids, "ORDER BY w.created_at,w.id")) {
        changed = this.add(graph.workIds, row.id) || changed;
        changed = this.add(graph.sourceIds, row.id) || changed;
        changed = this.add(graph.projectIds, row.project_id) || changed;
        changed = this.add(graph.worktreeIds, row.worktree_id) || changed;
      }
      const continuationKeys = new Set([...ids, ...graph.workIds]);
      for (const row of this.inRows(
        "SELECT * FROM continuation_acceptances WHERE id IN",
        continuationKeys,
        "ORDER BY created_at,id",
      )) {
        changed = this.add(graph.continuationIds, row.id) || changed;
        changed = this.add(graph.workIds, row.work_id) || changed;
        changed = this.add(graph.sourceIds, row.id) || changed;
      }
      for (const row of this.inRows(
        "SELECT * FROM continuation_acceptances WHERE work_id IN",
        graph.workIds,
        "ORDER BY created_at,id",
      )) {
        changed = this.add(graph.continuationIds, row.id) || changed;
        changed = this.add(graph.workIds, row.work_id) || changed;
        changed = this.add(graph.sourceIds, row.id) || changed;
      }
      for (const request of this.relatedControlRequestsFor(graphIds(graph))) {
        changed = this.add(graph.controlIds, request.request_id) || changed;
        changed = this.add(graph.sourceIds, request.request_id) || changed;
        changed = this.addJsonReferences(graph, request.target_json) || changed;
        changed = this.addJsonReferences(graph, request.args_json) || changed;
      }
      for (const run of this.relatedWorkflowRunsFor(graphIds(graph))) {
        changed = this.add(graph.runIds, run.run_id) || changed;
        changed = this.add(graph.sourceIds, run.run_id) || changed;
        changed = this.add(graph.ids, run.correlation_id) || changed;
        changed = this.addJsonReferences(graph, run.input_json) || changed;
      }
      for (const approval of this.inRows(
        "SELECT * FROM workflow_step_approvals WHERE run_id IN",
        graph.runIds,
        "ORDER BY created_at,approval_id",
      )) {
        changed = this.add(graph.controlIds, approval.request_id) || changed;
        changed = this.add(graph.sourceIds, approval.request_id) || changed;
      }
      for (const intent of this.relatedGjcIntentsFor(graphIds(graph), graph.questionIds)) {
        changed = this.add(graph.intentIds, intent.intent_id) || changed;
        changed = this.add(graph.sourceIds, intent.intent_id) || changed;
        changed = this.add(graph.continuationIds, intent.continuation_id) || changed;
        changed = this.addJsonReferences(graph, intent.payload_json) || changed;
      }
      for (const question of this.inRows(
        "SELECT * FROM gjc_questions WHERE intent_id IN",
        graph.intentIds,
        "ORDER BY created_at,question_id",
      )) {
        changed = this.add(graph.questionIds, question.question_id) || changed;
        changed = this.add(graph.intentIds, question.intent_id) || changed;
      }
      for (const question of this.inRows(
        "SELECT * FROM gjc_questions WHERE question_id IN",
        graphIds(graph),
        "ORDER BY created_at,question_id",
      )) {
        changed = this.add(graph.questionIds, question.question_id) || changed;
        changed = this.add(graph.intentIds, question.intent_id) || changed;
      }
      changed = this.addBindings(graph) || changed;
      if (!changed) break;
    }
    return graph;
  }
}
