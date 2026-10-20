import type { IncomingMessage, ServerResponse } from "node:http";
import { CompanyDailyReportStore } from "../company-daily-report-store.js";
import type { AuthorityDb } from "../db.js";
import { writeDashboardError, writeDashboardJson } from "./http.js";
import { hasSameOriginReadOrigin } from "./request-boundary.js";
import { sessionMatchesCsrf, type DashboardSessionStore } from "./session.js";

const PREFIX = "/api/v1/company-daily-reports";
type Input = {
  readonly path: string;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly requestId: string;
  readonly db: AuthorityDb;
  readonly session: DashboardSessionStore;
  readonly origin: string;
};
export function tryHandleCompanyReports(input: Input): boolean {
  if (input.path !== PREFIX && !input.path.startsWith(`${PREFIX}/`)) return false;
  if (input.request.method !== "GET" || !hasSameOriginReadOrigin(input.request, input.origin)
    || !sessionMatchesCsrf(input.session, header(input.request.headers["x-jarvis-csrf"]))) {
    input.request.resume();
    writeDashboardError(input.response, { status: 403, code: "LOCAL_SESSION_REQUIRED", requestId: input.requestId });
    return true;
  }
  const store = new CompanyDailyReportStore(input.db);
  if (input.path === PREFIX) {
    writeDashboardJson(input.response, { status: 200, requestId: input.requestId,
      body: { schema_version: 1, reports: store.listCards() } });
    return true;
  }
  const encoded = input.path.slice(PREFIX.length + 1);
  if (encoded.length === 0 || encoded.includes("/")) {
    writeDashboardError(input.response, { status: 400, code: "VALIDATION_ERROR", requestId: input.requestId });
    return true;
  }
  let reportId: string;
  try { reportId = decodeURIComponent(encoded); }
  catch (error) {
    if (error instanceof URIError) {
      writeDashboardError(input.response, { status: 400, code: "VALIDATION_ERROR", requestId: input.requestId });
      return true;
    }
    throw error;
  }
  const card = store.card(reportId);
  if (card === undefined) {
    writeDashboardError(input.response, { status: 404, code: "VALIDATION_ERROR", requestId: input.requestId });
    return true;
  }
  writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body: { schema_version: 1, report: card } });
  return true;
}
function header(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
