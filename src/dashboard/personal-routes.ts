import type { ServerResponse } from "node:http";
import { DASHBOARD_SCHEMA_VERSION } from "./contracts.js";
import { PersonalCursorError } from "./personal-cursor.js";
import { writeDashboardJson } from "./http.js";
import { PERSONAL_PAGE_DEFAULT, PERSONAL_PAGE_MAX } from "./personal-contracts.js";
import type { PersonalLookup } from "./personal-details.js";
import { assertSafeIdentifier, PersonalProjectionPrivacyError } from "./personal-privacy.js";
import { PersonalResponseTooLargeError, type PersonalDashboardReadModel, type PersonalPageRequest } from "./personal-read-model.js";

type Input = { readonly model: PersonalDashboardReadModel; readonly url: string | undefined; readonly path: string;
  readonly response: ServerResponse; readonly requestId: string; readonly now: Date };
type Route = { readonly kind: "today" } | { readonly kind: "recommendation"; readonly id: string }
  | { readonly kind: "evidence"; readonly contextId: string; readonly recommendationId: string }
  | { readonly kind: "list"; readonly resource: "runs" | "decisions" | "notifications" | "health"; readonly page: PersonalPageRequest }
  | { readonly kind: "invalid"; readonly code: "PERSONAL_QUERY_INVALID" | "PERSONAL_ID_INVALID" }
  | { readonly kind: "unhandled" };

const ERRORS = {
  PERSONAL_QUERY_INVALID: { status: 400, message: "Invalid personal read query" },
  PERSONAL_ID_INVALID: { status: 400, message: "Invalid personal resource identity" },
  PERSONAL_CURSOR_INVALID: { status: 400, message: "Invalid personal page cursor" },
  PERSONAL_RESPONSE_TOO_LARGE: { status: 413, message: "Personal response is too large" },
  PERSONAL_RESOURCE_NOT_FOUND: { status: 404, message: "Personal resource not found" },
} as const;

export async function tryHandlePersonalRead(input: Input): Promise<boolean> {
  try {
    return await handlePersonalRead(input);
  } catch (error) {
    if (error instanceof PersonalCursorError) { writeError(input, "PERSONAL_CURSOR_INVALID"); return true; }
    if (error instanceof PersonalResponseTooLargeError) { writeError(input, "PERSONAL_RESPONSE_TOO_LARGE"); return true; }
    throw error;
  }
}

async function handlePersonalRead(input: Input): Promise<boolean> {
  const route = match(input);
  switch (route.kind) {
    case "unhandled": return false;
    case "invalid": writeError(input, route.code); return true;
    case "today": write(input, input.model.today(input.now)); return true;
    case "recommendation": writeLookup(input, input.model.recommendation(route.id, input.now)); return true;
    case "evidence": writeLookup(input, input.model.evidence(route.contextId, route.recommendationId, input.now)); return true;
    case "list": await writeList(input, route.resource, route.page); return true;
    default: return assertNever(route);
  }
}

function match(input: Input): Route {
  if (input.path === "/api/v1/today") return noQuery(input.url) ? { kind: "today" } : invalid("PERSONAL_QUERY_INVALID");
  const recommendation = segment(input.path, "/api/v1/recommendations/");
  if (recommendation !== undefined) return noQuery(input.url) ? safeRecommendation(recommendation) : invalid("PERSONAL_QUERY_INVALID");
  const evidence = evidenceSegments(input.path);
  if (evidence !== undefined) {
    const query = exactQuery(input.url, ["recommendation_id"]);
    const recommendationId = query?.get("recommendation_id") ?? undefined;
    if (recommendationId === undefined || recommendationId === "") return invalid("PERSONAL_QUERY_INVALID");
    try { return { kind: "evidence", contextId: assertSafeIdentifier(evidence), recommendationId: assertSafeIdentifier(recommendationId) }; }
    catch (error) { if (error instanceof PersonalProjectionPrivacyError) return invalid("PERSONAL_ID_INVALID"); throw error; }
  }
  const lists = new Map<string, "runs" | "decisions" | "notifications" | "health">([
    ["/api/v1/daily-runs", "runs"], ["/api/v1/decision-inbox", "decisions"],
    ["/api/v1/notification-intents", "notifications"], ["/api/v1/source-health", "health"],
  ]);
  const resource = lists.get(input.path);
  if (resource === undefined) return { kind: "unhandled" };
  const page = parsePage(input.url, input.now);
  return page === undefined ? invalid("PERSONAL_QUERY_INVALID") : { kind: "list", resource, page };
}

function safeRecommendation(id: string): Route {
  try { return { kind: "recommendation", id: assertSafeIdentifier(id) }; }
  catch (error) { if (error instanceof PersonalProjectionPrivacyError) return invalid("PERSONAL_ID_INVALID"); throw error; }
}

function parsePage(url: string | undefined, now: Date): PersonalPageRequest | undefined {
  const query = exactQuery(url, ["limit", "cursor"]);
  if (query === undefined) return undefined;
  const rawLimit = query.get("limit");
  if (rawLimit !== null && !/^[1-9]\d{0,2}$/.test(rawLimit)) return undefined;
  const limit = rawLimit === null ? PERSONAL_PAGE_DEFAULT : Number(rawLimit);
  if (limit < 1 || limit > PERSONAL_PAGE_MAX) return undefined;
  const cursor = query.get("cursor");
  if (cursor !== null && (cursor.length === 0 || Buffer.byteLength(cursor, "utf8") > 2_048)) return undefined;
  return { limit, cursor, now };
}

function exactQuery(url: string | undefined, allowed: readonly string[]): URLSearchParams | undefined {
  try {
    const query = new URL(url ?? "/", "http://127.0.0.1").searchParams;
    for (const key of query.keys()) if (!allowed.includes(key) || query.getAll(key).length !== 1) return undefined;
    return query;
  } catch (error) { if (error instanceof TypeError) return undefined; throw error; }
}

function noQuery(url: string | undefined): boolean { return exactQuery(url, []) !== undefined; }
function segment(path: string, prefix: string): string | undefined {
  if (!path.startsWith(prefix)) return undefined;
  const value = path.slice(prefix.length);
  return value.length > 0 && !value.includes("/") ? value : undefined;
}
function evidenceSegments(path: string): string | undefined {
  const prefix = "/api/v1/contexts/"; const suffix = "/evidence";
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return undefined;
  const value = path.slice(prefix.length, -suffix.length);
  return value.length > 0 && !value.includes("/") ? value : undefined;
}
function invalid(code: "PERSONAL_QUERY_INVALID" | "PERSONAL_ID_INVALID"): Route { return { kind: "invalid", code }; }

async function writeList(input: Input, resource: "runs" | "decisions" | "notifications" | "health", page: PersonalPageRequest): Promise<void> {
  switch (resource) {
    case "runs": write(input, input.model.dailyRuns(page)); return;
    case "decisions": write(input, input.model.decisions(page)); return;
    case "notifications": write(input, input.model.notifications(page)); return;
    case "health": write(input, await input.model.health(page)); return;
    default: assertNever(resource);
  }
}
function writeLookup(input: Input, lookup: PersonalLookup<unknown>): void {
  if (lookup.kind === "found") write(input, lookup.value); else writeError(input, "PERSONAL_RESOURCE_NOT_FOUND");
}
function write(input: Input, body: unknown): void {
  writeDashboardJson(input.response, { status: 200, body, requestId: input.requestId });
}
function writeError(input: Input, code: keyof typeof ERRORS): void {
  const error = ERRORS[code];
  writeDashboardJson(input.response, { status: error.status, requestId: input.requestId,
    body: { schema_version: DASHBOARD_SCHEMA_VERSION, error: { code, message: error.message, request_id: input.requestId } } });
}
function assertNever(value: never): never { throw new Error(`unexpected personal route: ${JSON.stringify(value)}`); }
