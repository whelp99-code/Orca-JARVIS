import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { controlCommandDigest } from "./control-plane-contract.js";
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
  if (!lookupStaged(input.db, path, now)) return null;
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

/**
 * Every gateway-admitted path must resolve to a locally staged ControlPlane
 * request whose stored identity still matches its command digest. A registration
 * verify carries the ceremony id, so it binds through the ceremony row to the
 * local enrollment that issued it.
 */
function lookupStaged(db: AuthorityDb, path: string, now: Date): boolean {
  if (path === "/api/v1/security/webauthn/credentials") return true;
  const requestId = requestIdFrom(path);
  if (requestId !== undefined) return consistentRequest(db, requestId, now);
  const challengeId = challengeIdFrom(path);
  if (challengeId !== undefined) {
    const row = db.db.prepare("SELECT request_id FROM webauthn_approval_challenges_v2 WHERE challenge_id=?").get(challengeId) as
      { request_id: string } | undefined;
    return row !== undefined && consistentRequest(db, row.request_id, now);
  }
  const registration = registrationFrom(path);
  if (registration === undefined) return false;
  switch (registration.kind) {
    case "options": {
      const begin = enrollmentBeginRequest(db, registration.enrollmentId);
      return begin !== undefined && consistentRequest(db, begin, now);
    }
    case "verify": {
      const ceremony = db.db.prepare(
        "SELECT enrollment_id, begin_request_id FROM webauthn_registration_ceremonies_v2 WHERE ceremony_id=?",
      ).get(registration.ceremonyId) as { enrollment_id: string; begin_request_id: string } | undefined;
      if (ceremony === undefined) return false;
      const begin = enrollmentBeginRequest(db, ceremony.enrollment_id);
      return begin !== undefined && begin === ceremony.begin_request_id && consistentRequest(db, begin, now);
    }
    default:
      return assertNever(registration);
  }
}

function enrollmentBeginRequest(db: AuthorityDb, enrollmentId: string): string | undefined {
  const rows = db.db.prepare(
    "SELECT request_id, args_json FROM control_command_requests WHERE action='remote.credential.enroll.begin'",
  ).all() as Array<{ request_id: string; args_json: string }>;
  const owner = rows.find(row => (JSON.parse(row.args_json) as { enrollment_id?: string }).enrollment_id === enrollmentId);
  return owner?.request_id;
}

type StagedRow = {
  request_id: string; action: string; action_level: number; target_json: string; args_json: string; command_digest: string;
  reversible: number; requested_by: string; requested_at: string; expires_at: string; nonce: string;
};

/** The stored action/target/args/principal/expiry must still hash to the staged command digest, and the request must be live. */
function consistentRequest(db: AuthorityDb, requestId: string, now: Date): boolean {
  const row = db.db.prepare(
    "SELECT request_id, action, action_level, target_json, args_json, command_digest, reversible, requested_by, requested_at, expires_at, nonce"
    + " FROM control_command_requests WHERE request_id=?",
  ).get(requestId) as StagedRow | undefined;
  if (row === undefined || row.action.length === 0 || row.requested_by.length === 0) return false;
  const expires = Date.parse(row.expires_at);
  if (!Number.isFinite(expires) || expires <= now.getTime()) return false;
  const target = JSON.parse(row.target_json) as unknown;
  const args = JSON.parse(row.args_json) as unknown;
  if (typeof target !== "object" || target === null || typeof args !== "object" || args === null) return false;
  const level = row.action_level;
  if (level !== 1 && level !== 2 && level !== 3) return false;
  return controlCommandDigest({
    schema_version: 1, request_id: row.request_id, action: row.action, action_level: level,
    target: target as Record<string, unknown>, args: args as Record<string, unknown>, reversible: row.reversible === 1,
    requested_by: row.requested_by, requested_at: row.requested_at, expires_at: row.expires_at, nonce: row.nonce,
  }) === row.command_digest;
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

type RegistrationPath =
  | { readonly kind: "options"; readonly enrollmentId: string }
  | { readonly kind: "verify"; readonly ceremonyId: string };

function registrationFrom(path: string): RegistrationPath | undefined {
  const match = /^\/api\/v1\/security\/webauthn\/registrations\/([^/]+)\/(options|verify)$/.exec(path);
  const id = match?.[1];
  if (id === undefined) return undefined;
  return match?.[2] === "options" ? { kind: "options", enrollmentId: id } : { kind: "verify", ceremonyId: id };
}

function assertNever(value: never): never {
  throw new Error(`unexpected registration path ${JSON.stringify(value)}`);
}
