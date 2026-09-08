import type { IncomingMessage, ServerResponse } from "node:http";
import { JarvisError, type AuthorityDb } from "../db.js";
import type { ReconcileHub } from "./events.js";
import { writeDashboardJson } from "./http.js";
import { sessionMatchesCsrf, type DashboardSessionStore } from "./session.js";
import { checkDashboardTaskExecution, prepareDashboardTaskExecution, stageDashboardTaskExecution } from "./task-execution-service.js";
import { readDashboardTaskExecution } from "./task-execution-read.js";

type Input = { db: AuthorityDb; path: string; request: IncomingMessage; response: ServerResponse;
  requestId: string; session: DashboardSessionStore; hub: ReconcileHub; clock: () => Date; body?: unknown };

// Server has already decoded the path. A second decode could change the task identity.
function route(path: string) {
  const match = /^\/api\/v1\/tasks\/([^/]+)\/execution(?:\/(prepare|stage|check))?$/.exec(path);
  return match ? { taskId: match[1]!, action: match[2] } : undefined;
}
export async function tryHandleTaskExecution(input: Input): Promise<boolean> {
  const matched = route(input.path);
  if (!matched) return false;
  if ((input.request.method === "GET") !== (matched.action === undefined)) return false;
  if (input.request.method !== "GET" && input.request.method !== "POST") return false;
  if (!sessionMatchesCsrf(input.session, input.request.headers["x-jarvis-csrf"])) {
    write(input, 403, { schema_version: 1, error: { code: "LOCAL_SESSION_REQUIRED",
      message: "Local session required", request_id: input.requestId } }); return true;
  }
  try {
    if (Buffer.byteLength(matched.taskId) > 160 || !matched.taskId.trim()) throw new JarvisError("TASK_EXECUTION_INPUT_INVALID");
    if (!matched.action) write(input, 200, readDashboardTaskExecution(input.db, matched.taskId, input.clock()));
    else if (matched.action === "prepare") write(input, 200,
      await prepareDashboardTaskExecution(input.db, matched.taskId, input.body, input.clock));
    else if (matched.action === "check") write(input, 200,
      await checkDashboardTaskExecution(input.db, matched.taskId, input.body, input.clock));
    else {
      const request = await stageDashboardTaskExecution(input.db, matched.taskId, input.body, input.clock);
      input.hub.publish(["overview", "tasks", `task:${matched.taskId}`, "approvals"]);
      write(input, 202, { schema_version: 1, request });
    }
  } catch (error) {
    if (!(error instanceof JarvisError) || error.code === "MEMORY_PROJECTION_AUTHORITY_NOT_READY") throw error;
    const code = error.code;
    if (!/^(TASK_|WORKFLOW_NOT_FOUND$|CONTROL_)/.test(code)) throw error;
    const status = ["TASK_NOT_FOUND", "WORKFLOW_NOT_FOUND"].includes(code) ? 404
      : ["TASK_EXECUTION_INPUT_INVALID", "TASK_EXECUTION_PLAN_INVALID", "TASK_EXECUTION_REQUEST_INVALID"].includes(code) ? 400 : 409;
    write(input, status, { schema_version: 1, error: { code, message: "Task execution request unavailable", request_id: input.requestId } });
  }
  return true;
}
function write(input: Input, status: number, body: unknown) {
  writeDashboardJson(input.response, { status, body, requestId: input.requestId });
}
