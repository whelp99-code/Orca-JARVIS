import type { DashboardApiInput } from "./api-routes.js";
import { JarvisError } from "../jarvis-error.js";
import { hasSameOriginReadOrigin } from "./request-boundary.js";
import { sessionMatchesCsrf } from "./session.js";
import { writeDashboardError, writeDashboardJson } from "./http.js";

export async function tryHandleFinanceRead(input: DashboardApiInput): Promise<boolean> {
  if (input.path !== "/api/v1/finance-read/config" && input.path !== "/api/v1/finance-read"
    && input.path !== "/api/v1/finance-read/company-binding") return false;
  if (input.request.method !== "GET" || !hasSameOriginReadOrigin(input.request, input.origin)
    || !sessionMatchesCsrf(input.session, typeof input.request.headers["x-jarvis-csrf"] === "string"
      ? input.request.headers["x-jarvis-csrf"] : undefined)) {
    input.request.resume();
    writeDashboardError(input.response, { status: 403, code: "LOCAL_SESSION_REQUIRED", requestId: input.requestId });
    return true;
  }
  const runtime = input.priceFinance;
  if (input.path.endsWith("/config")) {
    writeDashboardJson(input.response, { status: 200, requestId: input.requestId,
      body: runtime === undefined ? { schema_version: 1, configured: false }
        : { schema_version: 1, configured: true, company_id: runtime.company_id } });
    return true;
  }
  if (runtime === undefined) {
    writeDashboardJson(input.response, { status: 503, requestId: input.requestId,
      body: { schema_version: 1, error: { code: "PRICE_READ_UNCONFIGURED",
        message: "Price reader is not configured", request_id: input.requestId } } });
    return true;
  }
  try {
    const query = new URL(input.url ?? "", input.origin).searchParams;
    const entries = [...query.entries()];
    if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new JarvisError("CORE5_NATIVE_READ_INPUT_INVALID");
    if (input.path.endsWith("/company-binding") && entries.length !== 0) {
      throw new JarvisError("CORE5_NATIVE_READ_INPUT_INVALID");
    }
    const receipt = input.path.endsWith("/company-binding")
      ? await runtime.readCompanyBinding() : await runtime.reader.read(Object.fromEntries(entries));
    writeDashboardJson(input.response, { status: 200, body: receipt, requestId: input.requestId });
  } catch (error) {
    if (!(error instanceof JarvisError)) throw error;
    const status = error.code === "CORE5_NATIVE_READ_SCOPE_DENIED" ? 403
      : error.code === "CORE5_NATIVE_READ_INPUT_INVALID" ? 400 : 502;
    writeDashboardJson(input.response, { status, requestId: input.requestId,
      body: { schema_version: 1, error: { code: error.code,
        message: "Price read refused; no financial effect", request_id: input.requestId } } });
  }
  return true;
}
