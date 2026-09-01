import type { AuthorityDb } from "./db.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import {
  latest,
  optional,
  pendingApproval,
  rowJson,
  stateRank,
  string,
  values,
  type Row,
  type TaskTimelineSummary,
  type TimelineGraph,
} from "./task-timeline-model.js";

export class TaskTimelineSummaryReader {
  constructor(private readonly authority: AuthorityDb) {}

  private rows(sql: string, ...params: unknown[]): Row[] {
    return this.authority.db.prepare<unknown[], Row>(sql).all(...params);
  }

  private inRows(sqlPrefix: string, ids: Iterable<string>, sqlSuffix = ""): Row[] {
    const items = values(ids);
    if (items.length === 0) return [];
    const placeholders = items.map(() => "?").join(",");
    return this.rows(`${sqlPrefix} (${placeholders}) ${sqlSuffix}`, ...items);
  }

  private controlTaskId(request: Row, fallback: string): string {
    const target = rowJson(request.target_json);
    const args = rowJson(request.args_json);
    return optional(target.task_id) ?? optional(target.work_id)
      ?? optional(target.correlation_id) ?? optional(args.task_id)
      ?? optional(args.work_id) ?? optional(args.correlation_id) ?? fallback;
  }

  private graphPendingApproval(graph: TimelineGraph): boolean {
    if (this.inRows(
      "SELECT request_id FROM control_command_requests WHERE state='pending' AND request_id IN",
      graph.controlIds,
    ).length > 0) return true;
    if (this.inRows(
      "SELECT run_id FROM workflow_runs WHERE state='waiting_approval' AND run_id IN",
      graph.runIds,
    ).length > 0) return true;
    if (this.inRows(
      "SELECT question_id FROM gjc_questions WHERE state='open' AND question_id IN",
      graph.questionIds,
    ).length > 0) return true;
    const projects = values(graph.projectIds);
    return projects.length > 0 && this.inRows(
      "SELECT request_id FROM pre_gjc_authority_requests WHERE state='pending' AND project_id IN",
      projects,
    ).length > 0;
  }

  private sourceIds(graph: TimelineGraph, fallback: string): string[] {
    const ids = values(graph.sourceIds).sort();
    return ids.length > 0 ? ids : [fallback];
  }

  isSuppressed(taskId: string): boolean {
    return new MemoryProjectionAuthority(this.authority).isProjectionIdSuppressed(taskId);
  }

  summary(taskId: string, graph: TimelineGraph): TaskTimelineSummary | undefined {
    const sourceIds = this.sourceIds(graph, taskId);
    const extraPending = this.graphPendingApproval(graph);
    const workRows = this.inRows(
      `SELECT w.id,w.action,w.state,w.created_at,p.state AS projection_state,
       p.updated_at AS projection_updated,
       (SELECT MAX(created_at) FROM event_ledger WHERE work_id=w.id) AS ledger_at
       FROM work_items w LEFT JOIN work_projection p ON p.work_id=w.id WHERE w.id IN`,
      graph.workIds,
      "ORDER BY w.created_at,w.id",
    );
    if (workRows.length > 0) {
      const exact = workRows.find(row => row.id === taskId) ?? workRows.sort((left, right) =>
        latest(right.projection_updated, right.ledger_at, right.created_at).localeCompare(
          latest(left.projection_updated, left.ledger_at, left.created_at),
        )).at(0);
      if (exact === undefined) return undefined;
      const state = optional(exact.projection_state) ?? string(exact.state);
      return {
        task_id: string(exact.id),
        title: string(exact.action),
        kind: "work",
        state,
        updated_at: latest(exact.projection_updated, exact.ledger_at, exact.created_at),
        pending_approval: pendingApproval(state) || extraPending,
        source_ids: sourceIds,
      };
    }
    let summary: TaskTimelineSummary | undefined;
    const consider = (candidate: TaskTimelineSummary): void => {
      if (!summary) {
        summary = candidate;
        return;
      }
      const newer = Date.parse(candidate.updated_at) >= Date.parse(summary.updated_at);
      const stronger = stateRank(candidate.state) > stateRank(summary.state);
      summary = {
        task_id: newer ? candidate.task_id : summary.task_id,
        title: newer ? candidate.title : summary.title,
        kind: newer ? candidate.kind : summary.kind,
        state: stronger || newer ? candidate.state : summary.state,
        updated_at: newer ? candidate.updated_at : summary.updated_at,
        pending_approval: summary.pending_approval || candidate.pending_approval,
        source_ids: [...new Set([...summary.source_ids, ...candidate.source_ids])].sort(),
      };
    };
    for (const request of this.inRows(
      `SELECT request_id,action,state,COALESCE(completed_at,requested_at,created_at) AS updated_at,
       target_json,args_json FROM control_command_requests WHERE request_id IN`,
      graph.controlIds,
      "ORDER BY updated_at,request_id",
    )) {
      const state = string(request.state);
      consider({ task_id: this.controlTaskId(request, taskId), title: string(request.action),
        kind: "command", state, updated_at: string(request.updated_at),
        pending_approval: state === "pending" || extraPending, source_ids: sourceIds });
    }
    for (const run of this.inRows(
      "SELECT run_id,loop_id,state,correlation_id,updated_at FROM workflow_runs WHERE run_id IN",
      graph.runIds,
      "ORDER BY updated_at,run_id",
    )) {
      const state = string(run.state);
      consider({ task_id: string(run.correlation_id) || taskId, title: string(run.loop_id),
        kind: "workflow", state, updated_at: string(run.updated_at),
        pending_approval: state === "waiting_approval" || extraPending, source_ids: sourceIds });
    }
    for (const intent of this.inRows(
      `SELECT intent_id,continuation_id,kind,state,
       COALESCE(completed_at,accepted_at,created_at) AS updated_at
       FROM gjc_intents WHERE intent_id IN`,
      graph.intentIds,
      "ORDER BY updated_at,intent_id",
    )) {
      const state = string(intent.state);
      consider({ task_id: optional(intent.continuation_id) ?? taskId,
        title: `GJC ${string(intent.kind)}`, kind: "agent", state,
        updated_at: string(intent.updated_at), pending_approval: extraPending,
        source_ids: sourceIds });
    }
    return summary;
  }

  list(limit: number): TaskTimelineSummary[] {
    const tasks = new Map<string, TaskTimelineSummary>();
    const upsert = (candidate: TaskTimelineSummary): void => {
      const prior = tasks.get(candidate.task_id);
      if (!prior) {
        tasks.set(candidate.task_id, candidate);
        return;
      }
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
    for (const item of this.rows(
      "SELECT id,action,state,created_at FROM work_items ORDER BY created_at DESC,id DESC LIMIT ?",
      limit,
    )) {
      const state = string(item.state);
      upsert({ task_id: string(item.id), title: string(item.action), kind: "work", state,
        updated_at: string(item.created_at), pending_approval: pendingApproval(state),
        source_ids: [string(item.id)] });
    }
    for (const item of this.rows(
      `SELECT request_id,action,state,COALESCE(completed_at,requested_at,created_at) AS updated_at,
       target_json,args_json FROM control_command_requests
       ORDER BY updated_at DESC,request_id DESC LIMIT ?`,
      limit,
    )) {
      const taskId = this.controlTaskId(item, string(item.request_id));
      const state = string(item.state);
      upsert({ task_id: taskId, title: string(item.action), kind: "command", state,
        updated_at: string(item.updated_at), pending_approval: state === "pending",
        source_ids: [string(item.request_id)] });
    }
    for (const item of this.rows(
      `SELECT run_id,loop_id,state,correlation_id,updated_at FROM workflow_runs
       ORDER BY updated_at DESC,run_id DESC LIMIT ?`,
      limit,
    )) {
      const state = string(item.state);
      const taskId = string(item.correlation_id) || string(item.run_id);
      upsert({ task_id: taskId, title: string(item.loop_id), kind: "workflow", state,
        updated_at: string(item.updated_at), pending_approval: state === "waiting_approval",
        source_ids: [string(item.run_id)] });
    }
    for (const item of this.rows(
      `SELECT intent_id,continuation_id,kind,state,
       COALESCE(completed_at,accepted_at,created_at) AS updated_at FROM gjc_intents
       ORDER BY updated_at DESC,intent_id DESC LIMIT ?`,
      limit,
    )) {
      const state = string(item.state);
      const taskId = optional(item.continuation_id) ?? string(item.intent_id);
      upsert({ task_id: taskId, title: `GJC ${string(item.kind)}`, kind: "agent", state,
        updated_at: string(item.updated_at), pending_approval: false,
        source_ids: [string(item.intent_id)] });
    }
    return [...tasks.values()]
      .filter(item => !this.isSuppressed(item.task_id))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at)
        || left.task_id.localeCompare(right.task_id))
      .slice(0, limit);
  }
}
