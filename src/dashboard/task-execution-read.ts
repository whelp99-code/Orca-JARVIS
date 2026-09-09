import { readControlCommand } from "../control-command-read.js";
import { JarvisError, type AuthorityDb } from "../db.js";
import { LoopGraph } from "../loopgraph.js";
import { readTaskCompletionEvidence } from "../task-completion-evidence.js";
import { parseTaskExecutionPlan } from "../task-execution-plan.js";
import type { OverviewApproval } from "./legacy-read-contracts.js";
import { parseTaskTemplateBinding } from "../task-templates.js";
import { readDashboardTaskRouting } from "./task-routing-read.js";

function taskTemplate(input: unknown) {
  if (!input || typeof input !== "object" || !Object.hasOwn(input, "task_template")) return undefined;
  return parseTaskTemplateBinding(Reflect.get(input, "task_template"));
}

/** Durable status only; no filesystem/provider checks or command writes during refresh. */
export function readDashboardTaskExecution(db: AuthorityDb, taskId: string, observedAt = new Date()) {
  return db.db.transaction(() => {
    const rows = db.db.prepare(`SELECT run_id FROM workflow_runs WHERE json_valid(input_json) AND json_extract(input_json,'$.task_id')=?
      ORDER BY created_at DESC,run_id DESC LIMIT 21`).all(taskId) as { run_id: string }[];
    if (rows.length === 0) throw new JarvisError("TASK_NOT_FOUND");
    const graph = new LoopGraph(db);
    const runs = rows.slice(0, 20).map(row => {
      const run = graph.get(row.run_id);
      const template = taskTemplate(run.input);
      const routing = readDashboardTaskRouting(db, run);
      return { run_id: run.run_id, state: run.state, updated_at: run.updated_at,
        ...(routing ? { routing } : {}),
        ...(template ? { task_template: template } : {}) };
    });
    const candidates = db.db.prepare(`SELECT request_id FROM control_command_requests
      WHERE action='task.execute' AND json_valid(target_json) AND json_extract(target_json,'$.task_id')=?
      ORDER BY requested_at DESC,request_id DESC LIMIT 21`).all(taskId) as { request_id: string }[];
    const requests = candidates.slice(0, 20).flatMap(row => {
      const command = readControlCommand(db, row.request_id);
      if (!command) return [];
      const plan = parseTaskExecutionPlan(command.args.plan);
      const run = graph.get(plan.run_id);
      const template = taskTemplate(run.input);
      const routing = readDashboardTaskRouting(db, run, plan);
      if (plan.task_id !== taskId || command.target.run_id !== plan.run_id) throw new JarvisError("TASK_EXECUTION_BINDING_INVALID");
      const request: OverviewApproval = { request_id: command.request_id, action: command.action,
        action_level: command.action_level, requested_at: command.requested_at, requested_by: command.requested_by,
        state: command.state, summary: "Execute the reviewed task plan", retry_status: "not_allowed" };
      return [{ request, plan, command_digest: command.command_digest, expires_at: command.expires_at,
        ...(routing ? { routing } : {}),
        ...(template ? { task_template: template } : {}),
        completion: readTaskCompletionEvidence(db, command.request_id, observedAt)?.completion ?? null }];
    });
    return { schema_version: 1 as const, task_id: taskId, runs, requests,
      truncated: { runs: rows.length > 20, requests: candidates.length > 20 } };
  }).deferred();
}

export type DashboardTaskExecution = ReturnType<typeof readDashboardTaskExecution>;
