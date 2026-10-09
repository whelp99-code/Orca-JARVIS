import type { DashboardApiInput } from "./api-routes.js";
import { hasSameOriginReadOrigin } from "./request-boundary.js";
import { sessionMatchesCsrf } from "./session.js";
import { writeDashboardError, writeDashboardJson } from "./http.js";

export async function tryHandleMailCandidates(input: DashboardApiInput): Promise<boolean> {
  if (input.path !== "/api/v1/mail-candidates") return false;
  if (input.request.method !== "GET" || !hasSameOriginReadOrigin(input.request, input.origin)
    || !sessionMatchesCsrf(input.session, typeof input.request.headers["x-jarvis-csrf"] === "string"
      ? input.request.headers["x-jarvis-csrf"] : undefined)) {
    input.request.resume();
    writeDashboardError(input.response, { status: 403, code: "LOCAL_SESSION_REQUIRED", requestId: input.requestId });
    return true;
  }
  if (new URL(input.url ?? "", input.origin).search !== "") {
    writeDashboardError(input.response, { status: 400, code: "VALIDATION_ERROR", requestId: input.requestId });
    return true;
  }
  const body = input.mailCandidates === undefined
    ? { schema_version: 1, proof_level: "native-read", authority: "none", observed_at: input.clock().toISOString(),
      crm: { state: "unconnected", reason: "unconfigured" }, sb: { state: "unconnected", reason: "unconfigured" } }
    : await input.mailCandidates.read();
  writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body });
  return true;
}
