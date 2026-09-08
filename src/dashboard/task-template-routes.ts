import type { IncomingMessage, ServerResponse } from "node:http";
import { JarvisError } from "../db.js";
import { compileTaskTemplate } from "../task-templates.js";
import { writeDashboardJson } from "./http.js";

/** Called only after the common Origin/CSRF/JSON-size boundary; compilation has no DB or provider effects. */
export function tryHandleTaskTemplateCompile(input: {
  path: string; request: IncomingMessage; response: ServerResponse; requestId: string; body: unknown;
}): boolean {
  if (input.request.method !== "POST" || input.path !== "/api/v1/task-templates/compile") return false;
  try {
    const compiled = compileTaskTemplate(input.body);
    writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body: { schema_version: 1, compiled } });
  } catch (error) {
    if (!(error instanceof JarvisError) || !["TASK_TEMPLATE_INVALID", "TEAM_PROPOSAL_INPUT_INVALID"].includes(error.code)) throw error;
    writeDashboardJson(input.response, { status: 400, requestId: input.requestId,
      body: { schema_version: 1, error: { code: error.code, message: "Invalid task template input", request_id: input.requestId } } });
  }
  return true;
}
