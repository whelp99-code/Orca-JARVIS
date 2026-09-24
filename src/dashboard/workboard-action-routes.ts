import type { ServerResponse } from "node:http";
import { z } from "zod";
import { operationSchema } from "../workboard/action-contracts.js";
import type { WorkboardActions } from "../workboard/actions.js";
import { writeDashboardJson } from "./http.js";

const id = z.string().min(1).max(2048);
const prepare = z.object({ workId: id }).strict();
const submit = z.object({ token: id, operation: operationSchema, authorityReceipt: z.unknown().optional() }).strict();
const reconcile = z.object({ intentId: id }).strict();

/** Called only after the shared exact-Origin + local-session CSRF + bounded JSON boundary. */
export async function tryHandleWorkboardAction(input: {
  path: string; body: unknown; response: ServerResponse; requestId: string; workboardActions?: WorkboardActions;
  hub: { publish(topics: readonly string[]): void };
}): Promise<boolean> {
  const operation = input.path.slice("/api/v1/workboard/actions/".length);
  if (!input.path.startsWith("/api/v1/workboard/actions/") || !["prepare", "submit", "reconcile"].includes(operation)) return false;
  const write = (status: number, body: unknown) => writeDashboardJson(input.response, { status, body, requestId: input.requestId });
  try {
    if (!input.workboardActions) throw new Error("WORKBOARD_ACTION_UNSUPPORTED");
    let value: unknown;
    if (operation === "prepare") {
      value = await input.workboardActions.prepare(prepare.parse(input.body).workId);
    } else if (operation === "submit") {
      const body = submit.parse(input.body);
      value = await input.workboardActions.submit(body.token, body.operation, body.authorityReceipt);
    } else {
      value = await input.workboardActions.reconcile(reconcile.parse(input.body).intentId);
    }
    input.hub.publish(["workboard"]);
    write(200, value);
  } catch (error) {
    const code = error instanceof z.ZodError ? "WORKBOARD_INPUT_INVALID"
      : error instanceof Error && /^WORKBOARD_[A-Z_]+$/u.test(error.message) ? error.message : "WORKBOARD_SOURCE_UNAVAILABLE";
    write(code === "WORKBOARD_INPUT_INVALID" ? 400 : 409,
      { schema_version: 1, error: { code, message: code, request_id: input.requestId } });
  }
  return true;
}
