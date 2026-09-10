import type { AuthorityDb } from "./db.js";
import { TaskTimelinePopulation } from "./task-timeline-population.js";
import {
  values,
  type Row,
  type TaskTimelineSummary,
  type TimelineGraph,
} from "./task-timeline-model.js";

export class TaskTimelineSummaryReader {
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

  isSuppressed(taskId: string): boolean {
    return new TaskTimelinePopulation(this.authority).isSuppressed(taskId);
  }

  summary(taskId: string, graph: TimelineGraph): TaskTimelineSummary | undefined {
    const task = new TaskTimelinePopulation(this.authority).find(taskId);
    return task === undefined ? undefined : {
      ...task, pending_approval: task.pending_approval || this.graphPendingApproval(graph),
    };
  }

  list(limit: number): TaskTimelineSummary[] {
    return new TaskTimelinePopulation(this.authority).list(limit);
  }
}
