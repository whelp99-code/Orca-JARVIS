import type { DashboardApiInput } from "./api-routes.js";
import { personalMailConnectorDefinition } from "../personal-connector-definitions.js";
import { classifyPersonalSnapshot, personalResultBase, personalUnavailable } from "../personal-connector-results.js";
import { freezePersonalResult, personalConnectorDigest } from "../personal-connector-values.js";
import { JarvisError } from "../jarvis-error.js";
import { hasSameOriginReadOrigin } from "./request-boundary.js";
import { sessionMatchesCsrf } from "./session.js";
import { writeDashboardError, writeDashboardJson } from "./http.js";

export async function tryHandleMailSummary(input: DashboardApiInput): Promise<boolean> {
  if (input.path !== "/api/v1/connectors/mail") return false;
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
  const now = input.clock();
  const definition = personalMailConnectorDefinition(input.mailSource !== undefined);
  const context = { checked_at: now.toISOString(),
    checkpoint_session: { mode: "stateless", version: 1, persistence: "process_local", handle: null } } as const;
  let body;
  if (input.mailSource === undefined) body = personalUnavailable(definition, "not_configured", context);
  else {
    try {
      const snapshot = await input.mailSource.read(now);
      const digest = personalConnectorDigest(snapshot);
      body = freezePersonalResult({ ...personalResultBase(definition, context),
        ...classifyPersonalSnapshot(snapshot, "mail", now), observed_at: snapshot.observed_at,
        evidence: { evidence_id: `connector:mail:${digest.slice(7)}`, digest },
        evidence_refs: snapshot.evidence_refs, cursor: snapshot.cursor, checkpoint: null, values: snapshot.values });
    } catch (error) {
      if (!(error instanceof JarvisError)) throw error;
      body = personalUnavailable(definition, "adapter_failed", context);
    }
  }
  writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body });
  return true;
}
