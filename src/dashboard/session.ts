import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import { DASHBOARD_SCHEMA_VERSION } from "./contracts.js";
import { writeDashboardJson } from "./http.js";

const SESSION_PATH = "/api/v1/session" as const;
const CSRF_BYTE_LENGTH = 32;
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export type DashboardSession = {
  readonly schema_version: 1;
  readonly csrf_token: string;
};

export type DashboardSessionStore = {
  snapshot(): DashboardSession;
  matches(candidate: string): boolean;
};

export type DashboardSessionRouteInput = {
  readonly path: string;
  readonly response: ServerResponse;
  readonly requestId: string;
  readonly session: DashboardSessionStore;
};

export function createDashboardSession(): DashboardSessionStore {
  const csrfToken = randomBytes(CSRF_BYTE_LENGTH).toString("base64url");
  return {
    snapshot(): DashboardSession {
      return { schema_version: DASHBOARD_SCHEMA_VERSION, csrf_token: csrfToken };
    },
    matches(candidate: string): boolean {
      const left = Buffer.from(csrfToken);
      const right = Buffer.from(candidate);
      return left.length === right.length && timingSafeEqual(left, right);
    },
  };
}

export function parseCsrfToken(value: unknown): string | undefined {
  if (typeof value !== "string" || !CSRF_TOKEN_PATTERN.test(value)) return undefined;
  return value;
}

export function sessionMatchesCsrf(session: DashboardSessionStore, candidate: unknown): boolean {
  const token = parseCsrfToken(candidate);
  return token !== undefined && session.matches(token);
}

export function parseDashboardSession(value: unknown): DashboardSession | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (Reflect.get(value, "schema_version") !== DASHBOARD_SCHEMA_VERSION) return undefined;
  const csrfToken = parseCsrfToken(Reflect.get(value, "csrf_token"));
  if (csrfToken === undefined) return undefined;
  return { schema_version: DASHBOARD_SCHEMA_VERSION, csrf_token: csrfToken };
}

export function tryHandleDashboardSession(input: DashboardSessionRouteInput): boolean {
  if (input.path !== SESSION_PATH) return false;
  writeDashboardJson(input.response, {
    status: 200,
    body: input.session.snapshot(),
    requestId: input.requestId,
  });
  return true;
}
