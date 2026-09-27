import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { ingressMac, sha256Prefixed } from "./remote-approval-crypto.js";
import type { RemoteIngressContextV1, RemoteIngressResolver } from "./remote-approval-types.js";

const HEADER = "x-jarvis-remote-ingress";

type Envelope = {
  readonly schema_version: 1;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body_digest: string;
  readonly session_digest: `hmac-sha256:${string}`;
  readonly origin: string;
  readonly issued_at: string;
  readonly nonce: string;
};

export function createProductionIngressResolver(input: {
  readonly db: AuthorityDb;
  readonly key: Buffer | undefined;
  readonly origin: string;
  readonly now: () => Date;
  readonly nonceTtlSeconds: number;
}): RemoteIngressResolver {
  return (request, body) => admitIngress(input, request, body);
}

function admitIngress(input: {
  readonly db: AuthorityDb;
  readonly key: Buffer | undefined;
  readonly origin: string;
  readonly now: () => Date;
  readonly nonceTtlSeconds: number;
}, request: IncomingMessage, body: Buffer): RemoteIngressContextV1 | null {
  if (input.key === undefined || input.key.byteLength !== 32) return null;
  const envelope = parseEnvelope(headerValue(request.headers[HEADER]));
  if (envelope === undefined) return null;
  const path = request.url === undefined ? undefined : pathOf(request.url);
  if (path === undefined || envelope.path !== path || envelope.method !== (request.method === "POST" ? "POST" : "GET")) return null;
  if (envelope.origin !== input.origin || envelope.body_digest !== sha256Prefixed(body)) return null;
  const mac = envelopeMac(headerValue(request.headers[HEADER]));
  const expected = ingressMac(input.key, envelope);
  if (mac === undefined || mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const now = input.now();
  const issued = Date.parse(envelope.issued_at);
  if (!Number.isFinite(issued) || Math.abs(now.getTime() - issued) > input.nonceTtlSeconds * 1000) return null;
  if (!consumeNonce(input.db, envelope, now, input.nonceTtlSeconds)) return null;
  if (!lookupStaged(input.db, path)) return null;
  return {
    schema_version: 1,
    trust_mode: "gateway",
    gateway_owner_digest: sha256Prefixed(envelope.origin),
    gateway_session_digest: envelope.session_digest,
    public_origin: envelope.origin,
    request_method: envelope.method,
    canonical_path: path,
    body_digest: sha256Prefixed(body),
    envelope_nonce_digest: sha256Prefixed(envelope.nonce),
    issued_at: envelope.issued_at,
  };
}

function lookupStaged(db: AuthorityDb, path: string): boolean {
  if (path === "/api/v1/security/webauthn/credentials") return true;
  const requestId = requestIdFrom(path);
  if (requestId !== undefined) return consistentRequest(db, requestId);
  const challengeId = challengeIdFrom(path);
  if (challengeId !== undefined) {
    const row = db.db.prepare("SELECT request_id FROM webauthn_approval_challenges_v2 WHERE challenge_id=?").get(challengeId) as
      { request_id: string } | undefined;
    return row !== undefined && consistentRequest(db, row.request_id);
  }
  const enrollmentId = enrollmentIdFrom(path);
  if (enrollmentId === undefined) return false;
  const rows = db.db.prepare(
    "SELECT args_json FROM control_command_requests WHERE action='remote.credential.enroll.begin'",
  ).all() as Array<{ args_json: string }>;
  return rows.some(row => {
    const args = JSON.parse(row.args_json) as { enrollment_id?: string };
    return args.enrollment_id === enrollmentId;
  });
}

function consistentRequest(db: AuthorityDb, requestId: string): boolean {
  const row = db.db.prepare(
    "SELECT action, target_json, args_json, command_digest, requested_by, expires_at FROM control_command_requests WHERE request_id=?",
  ).get(requestId) as {
    action: string; target_json: string; args_json: string; command_digest: string; requested_by: string; expires_at: string;
  } | undefined;
  if (row === undefined || row.action.length === 0 || row.requested_by.length === 0) return false;
  if (!row.command_digest.startsWith("sha256:") || !Number.isFinite(Date.parse(row.expires_at))) return false;
  const target = JSON.parse(row.target_json) as unknown;
  const args = JSON.parse(row.args_json) as unknown;
  if (typeof target !== "object" || target === null || typeof args !== "object" || args === null) return false;
  return sha256Prefixed(canonicalize(target)).length > 0 && sha256Prefixed(canonicalize(args)).length > 0;
}

function consumeNonce(db: AuthorityDb, envelope: Envelope, now: Date, ttlSeconds: number): boolean {
  const expires = new Date(Date.parse(envelope.issued_at) + ttlSeconds * 1000).toISOString();
  try {
    db.db.prepare(
      "INSERT INTO remote_gateway_ingress_nonces_v2(nonce_digest, session_digest, body_digest, issued_at, expires_at, consumed_at) VALUES(?,?,?,?,?,?)",
    ).run(sha256Prefixed(envelope.nonce), envelope.session_digest, envelope.body_digest, envelope.issued_at, expires, now.toISOString());
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) return false;
    throw error;
  }
}

function parseEnvelope(header: string | undefined): Envelope | undefined {
  if (header === undefined || !header.includes(".")) return undefined;
  const encoded = header.slice(0, header.lastIndexOf("."));
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const method = Reflect.get(parsed, "method");
  const session = Reflect.get(parsed, "session_digest");
  if (Reflect.get(parsed, "schema_version") !== 1 || (method !== "GET" && method !== "POST")) return undefined;
  if (typeof session !== "string" || !session.startsWith("hmac-sha256:")) return undefined;
  const path = Reflect.get(parsed, "path");
  const bodyDigest = Reflect.get(parsed, "body_digest");
  const origin = Reflect.get(parsed, "origin");
  const issued = Reflect.get(parsed, "issued_at");
  const nonce = Reflect.get(parsed, "nonce");
  if (typeof path !== "string" || typeof bodyDigest !== "string" || typeof origin !== "string") return undefined;
  if (typeof issued !== "string" || typeof nonce !== "string" || nonce.length < 16) return undefined;
  return {
    schema_version: 1, method, path, body_digest: bodyDigest, session_digest: session as `hmac-sha256:${string}`,
    origin, issued_at: issued, nonce,
  };
}

function envelopeMac(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const mac = header.slice(header.lastIndexOf(".") + 1);
  return /^[0-9a-f]{64}$/.test(mac) ? mac : undefined;
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pathOf(url: string): string | undefined {
  try {
    return new URL(url, "http://127.0.0.1").pathname;
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

function requestIdFrom(path: string): string | undefined {
  const review = /^\/api\/v1\/remote-approvals\/([^/]+)$/.exec(path);
  if (review?.[1] !== undefined) return review[1];
  const options = /^\/api\/v1\/remote-approvals\/([^/]+)\/options$/.exec(path);
  return options?.[1];
}

function challengeIdFrom(path: string): string | undefined {
  const match = /^\/api\/v1\/remote-approvals\/([^/]+)\/(?:verify|status)$/.exec(path);
  return match?.[1];
}

function enrollmentIdFrom(path: string): string | undefined {
  const match = /^\/api\/v1\/security\/webauthn\/registrations\/([^/]+)\/(?:options|verify)$/.exec(path);
  return match?.[1];
}
