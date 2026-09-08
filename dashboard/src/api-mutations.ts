import type { StoredControlCommand } from "../../src/control-plane.js";
import type { CreateTaskRequest } from "../../src/dashboard/contracts.js";
import type { TaskTemplateBinding } from "../../src/task-templates.js";
import { parseCompiledTemplate, type CompiledTaskTemplate } from "./task-template-contract.js";
import type {
  TeamMemberProposal,
  TeamProposalRequestV1,
  TeamProposalResultV1,
} from "../../src/team-proposal.js";
import {
  classifyDashboardError,
  DashboardApiError,
  type ApiErrorKind,
  type SessionResponse,
} from "./api.js";

export type ProposalMutationClient = Readonly<{
  previewProposal: (request: TeamProposalRequestV1) => Promise<TeamProposalResultV1>;
  createTask: (request: CreateTaskRequest & { readonly task_template?: TaskTemplateBinding }) => Promise<StoredControlCommand>;
  compileTemplate?: (request: unknown) => Promise<CompiledTaskTemplate>;
}>;

const CAPABILITY_IDS = ["codex", "claude", "orca_read", "gjc", "live_resume"] as const;
const CAPABILITY_STAGES = ["installed", "configured", "protocol_compatible", "operational", "authorized"] as const;
const ARCHETYPES = ["leader", "researcher", "analyst", "builder", "writer", "designer", "critic"] as const;
const COMMAND_STATES = ["pending", "approved", "rejected", "claimed", "completed", "failed", "uncertain", "cancelled"] as const;
const ACTION_LEVELS = [0, 1, 2, 3, 4, 5] as const;
const CSRF_HEADER = "X-JARVIS-CSRF";
const REQUEST_TIMEOUT_MS = 10_000;

type SessionLoader = () => Promise<SessionResponse>;
type Parser<T> = (value: unknown) => T | undefined;
type JsonPost<T> = Readonly<{
  path: string;
  value: unknown;
  parse: Parser<T>;
  csrfToken: string;
}>;

export function createProposalMutationClient(
  loadSession: SessionLoader = fetchSession,
): ProposalMutationClient {
  let tokenRequest: Promise<string> | undefined;
  async function csrfToken(): Promise<string> {
    tokenRequest ??= loadSession().then((session) => session.csrf_token);
    try {
      return await tokenRequest;
    } catch (error: unknown) {
      tokenRequest = undefined;
      throw error;
    }
  }
  return {
    compileTemplate: async value => await postJson({ path: "/api/v1/task-templates/compile", value,
      parse: parseCompiledTemplate, csrfToken: await csrfToken() }),
    previewProposal: async (value) => await postJson({
      path: "/api/v1/proposals/preview",
      value,
      parse: parseProposalEnvelope,
      csrfToken: await csrfToken(),
    }),
    createTask: async (value) => await postJson({
      path: "/api/v1/tasks",
      value,
      parse: parseTaskEnvelope,
      csrfToken: await csrfToken(),
    }),
  };
}

async function fetchSession(): Promise<SessionResponse> {
  const response = await request("/api/v1/session", {
    headers: { Accept: "application/json" },
  });
  const body = await responseBody(response);
  if (!response.ok) throw errorFromBody(response.status, requestId(response), body);
  if (!isSession(body)) throw validationError(requestId(response));
  return body;
}

async function postJson<T>(input: JsonPost<T>): Promise<T> {
  const response = await request(input.path, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      [CSRF_HEADER]: input.csrfToken,
    },
    body: JSON.stringify(input.value),
  });
  const body = await responseBody(response);
  const responseRequestId = requestId(response);
  if (!response.ok) throw errorFromBody(response.status, responseRequestId, body);
  const parsed = input.parse(body);
  if (parsed === undefined) throw validationError(responseRequestId);
  return parsed;
}

async function request(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, {
      ...init,
      credentials: "same-origin",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    throw new DashboardApiError(classifyDashboardError(error));
  }
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new DashboardApiError({
        kind: kindFromStatus(response.status),
        code: "JSON_INVALID",
        message: "Invalid JSON",
        request_id: requestId(response),
      });
    }
    throw error;
  }
}

function parseProposalEnvelope(value: unknown): TeamProposalResultV1 | undefined {
  if (!isRecord(value) || value.schema_version !== 1 || !isProposal(value.proposal)) return undefined;
  return value.proposal;
}

function parseTaskEnvelope(value: unknown): StoredControlCommand | undefined {
  if (!isRecord(value) || value.schema_version !== 1 || !isStoredCommand(value.request)) return undefined;
  return value.request;
}

function isProposal(value: unknown): value is TeamProposalResultV1 {
  if (!isRecord(value) || value.schema_version !== 1) return false;
  switch (value.status) {
    case "needs_input":
      return isArrayOf(value.questions, isQuestion);
    case "blocked":
      return isArrayOf(value.reasons, isReason);
    case "ready":
      return isDigest(value.proposal_digest) && typeof value.objective === "string"
        && isArrayOf(value.members, isMember);
    default:
      return false;
  }
}

function isQuestion(value: unknown): value is Extract<TeamProposalResultV1, { status: "needs_input" }>["questions"][number] {
  return isRecord(value) && typeof value.id === "string"
    && typeof value.text === "string" && value.required === true;
}

function isReason(value: unknown): value is Extract<TeamProposalResultV1, { status: "blocked" }>["reasons"][number] {
  return isRecord(value) && isMemberOf(value.capability_id, CAPABILITY_IDS)
    && isMemberOf(value.stage, CAPABILITY_STAGES);
}

function isMember(value: unknown): value is TeamMemberProposal {
  return isRecord(value) && typeof value.member_id === "string"
    && isMemberOf(value.archetype, ARCHETYPES) && typeof value.role === "string"
    && isStringArray(value.scope) && isStringArray(value.exclusions)
    && isStringArray(value.verification)
    && isArrayOf(value.preferred_capability_ids, (item): item is (typeof CAPABILITY_IDS)[number] => (
      isMemberOf(item, CAPABILITY_IDS)
    ));
}

function isStoredCommand(value: unknown): value is StoredControlCommand {
  return isRecord(value) && value.schema_version === 1
    && typeof value.request_id === "string" && typeof value.action === "string"
    && isMemberOf(value.action_level, ACTION_LEVELS) && isRecord(value.target)
    && isRecord(value.args) && typeof value.reversible === "boolean"
    && typeof value.requested_by === "string" && typeof value.requested_at === "string"
    && typeof value.expires_at === "string" && typeof value.nonce === "string"
    && typeof value.command_digest === "string" && isMemberOf(value.state, COMMAND_STATES);
}

function isSession(value: unknown): value is SessionResponse {
  return isRecord(value) && value.schema_version === 1
    && typeof value.csrf_token === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value.csrf_token);
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function errorFromBody(status: number, responseRequestId: string, body: unknown): DashboardApiError {
  const kind = kindFromStatus(status);
  if (isRecord(body) && body.schema_version === 1 && isRecord(body.error)
    && typeof body.error.code === "string" && typeof body.error.message === "string"
    && typeof body.error.request_id === "string") {
    return new DashboardApiError({
      kind,
      code: body.error.code,
      message: body.error.message,
      request_id: body.error.request_id,
    });
  }
  return new DashboardApiError({
    kind,
    code: kind.toUpperCase(),
    message: kind,
    request_id: responseRequestId,
  });
}

function validationError(responseRequestId: string): DashboardApiError {
  return new DashboardApiError({
    kind: "server",
    code: "VALIDATION_ERROR",
    message: "Validation error",
    request_id: responseRequestId,
  });
}

function kindFromStatus(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "not_found";
  return "server";
}

function requestId(response: Response): string {
  return response.headers.get("X-Request-Id") ?? "";
}

function isMemberOf<T extends string | number>(value: unknown, allowed: readonly T[]): value is T {
  return allowed.some((item) => item === value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isArrayOf<T>(value: unknown, item: (entry: unknown) => entry is T): value is readonly T[] {
  return Array.isArray(value) && value.every(item);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
