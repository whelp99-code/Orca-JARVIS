import type { ServerResponse } from "node:http";
import { JarvisError, type AuthorityDb } from "../db.js";
import { RecommendationWorkflowStager } from "../recommendation-workflow-staging.js";
import type { ReconcileHub } from "./events.js";
import { PERSONAL_TOPICS } from "./personal-contracts.js";
import { writeDashboardJson } from "./http.js";
import type { DashboardSessionStore } from "./session.js";

const ACCEPT_KEYS = ["schema_version"] as const;
const MAX_STEPS = 6;
const MAX_ATTEMPTS = 2;
const DEADLINE_MS = 10 * 60_000;
const REPOSITORY = "Orca-JARVIS";

type Input = {
  readonly db: AuthorityDb;
  readonly path: string;
  readonly response: ServerResponse;
  readonly requestId: string;
  readonly body: unknown;
  readonly hub: ReconcileHub;
  readonly clock: () => Date;
  readonly session: DashboardSessionStore;
};

type Route =
  | { readonly kind: "accept"; readonly recommendationId: string; readonly rank: number }
  | { readonly kind: "invalid" }
  | { readonly kind: "unhandled" };

export function tryHandleRecommendationAccept(input: Input): boolean {
  const route = match(input.path);
  switch (route.kind) {
    case "unhandled":
      return false;
    case "invalid":
      writeError(input, 400, "RECOMMENDATION_ACTION_INVALID");
      return true;
    case "accept":
      return accept(input, route);
    default:
      return assertNever(route);
  }
}

function accept(input: Input, route: Extract<Route, { readonly kind: "accept" }>): boolean {
  if (!isAcceptBody(input.body)) {
    writeError(input, 400, "RECOMMENDATION_ACTION_INVALID");
    return true;
  }
  const principal = currentDecisionPrincipal(input.db);
  if (principal === undefined) {
    writeError(input, 503, "RECOMMENDATION_ACTION_UNAVAILABLE");
    return true;
  }
  const now = input.clock();
  if (!validDate(now)) {
    writeError(input, 503, "RECOMMENDATION_ACTION_UNAVAILABLE");
    return true;
  }
  const action = currentAction(input.db, route.recommendationId, route.rank);
  if (action === undefined) {
    writeError(input, 409, "RECOMMENDATION_ACTION_REJECTED");
    return true;
  }
  try {
    const staged = new RecommendationWorkflowStager(input.db, () => now).stage({
      schema_version: 1,
      recommendation_id: route.recommendationId,
      action_rank: route.rank,
      requested_by: {
        principal_id: principal,
        authenticated_session_id: input.session.authenticatedSessionId(),
      },
      target: { repository: REPOSITORY, environment: "local" },
      workflow: {
        goal: action.title,
        args: { operation: action.operation, target_digest: action.targetDigest },
      },
      budget: { max_steps: MAX_STEPS, max_attempts_per_node: MAX_ATTEMPTS },
      deadline: new Date(now.getTime() + DEADLINE_MS).toISOString(),
    });
    input.hub.publish([
      PERSONAL_TOPICS.recommendations,
      PERSONAL_TOPICS.decisions,
      PERSONAL_TOPICS.today,
      "approvals",
    ]);
    writeDashboardJson(input.response, {
      status: 202,
      requestId: input.requestId,
      body: {
        schema_version: 1,
        recommendation_id: route.recommendationId,
        action_rank: route.rank,
        request_id: staged.request_id,
        action: staged.action,
        state: staged.state,
      },
    });
    return true;
  } catch (error: unknown) {
    if (!(error instanceof JarvisError)) throw error;
    writeError(input, 409, "RECOMMENDATION_ACTION_REJECTED");
    return true;
  }
}

function currentDecisionPrincipal(db: AuthorityDb): string | undefined {
  const rows = db.db.prepare(
    `SELECT DISTINCT k.principal_id FROM trusted_authority_keys k
     JOIN authority_key_purposes p ON p.key_id=k.key_id
     WHERE p.purpose='decision' ORDER BY k.principal_id`,
  ).all();
  if (rows.length !== 1) return undefined;
  const row = rows[0];
  if (typeof row !== "object" || row === null) return undefined;
  const principal = Reflect.get(row, "principal_id");
  return typeof principal === "string" && principal.length > 0 ? principal : undefined;
}

function currentAction(
  db: AuthorityDb,
  recommendationId: string,
  rank: number,
): { readonly title: string; readonly operation: string; readonly targetDigest: string } | undefined {
  const row = db.db.prepare(
    `SELECT title,operation,target_digest FROM personal_recommendation_actions
     WHERE recommendation_id=? AND rank=?`,
  ).get(recommendationId, rank);
  if (typeof row !== "object" || row === null) return undefined;
  const title = Reflect.get(row, "title");
  const operation = Reflect.get(row, "operation");
  const targetDigest = Reflect.get(row, "target_digest");
  return typeof title === "string" && typeof operation === "string" && typeof targetDigest === "string"
    ? { title, operation, targetDigest }
    : undefined;
}

function match(path: string): Route {
  const prefix = "/api/v1/recommendations/";
  const marker = "/actions/";
  const suffix = "/accept";
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return { kind: "unhandled" };
  const middle = path.slice(prefix.length, -suffix.length);
  const markerIndex = middle.lastIndexOf(marker);
  if (markerIndex <= 0) return { kind: "invalid" };
  const recommendationId = middle.slice(0, markerIndex);
  const rankText = middle.slice(markerIndex + marker.length);
  if (recommendationId.includes("/") || !/^[1-9]\d?$/u.test(rankText)) return { kind: "invalid" };
  const rank = Number(rankText);
  if (Buffer.byteLength(recommendationId, "utf8") > 128 || rank > 32) return { kind: "invalid" };
  return { kind: "accept", recommendationId, rank };
}

function isAcceptBody(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === ACCEPT_KEYS.length && keys[0] === ACCEPT_KEYS[0]
    && Reflect.get(value, "schema_version") === 1;
}

function validDate(value: Date): boolean {
  return Object.getPrototypeOf(value) === Date.prototype && Number.isFinite(value.getTime());
}

function writeError(input: Input, status: number, code: string): void {
  writeDashboardJson(input.response, {
    status,
    requestId: input.requestId,
    body: { schema_version: 1, error: { code, message: "Recommendation action unavailable", request_id: input.requestId } },
  });
}

function assertNever(value: never): never {
  throw new Error(`unexpected recommendation action route: ${JSON.stringify(value)}`);
}
