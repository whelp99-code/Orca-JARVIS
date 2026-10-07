import { timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ControlPlane, type ControlCommandRequestInput } from "../control-plane.js";
import { JarvisError, type AuthorityDb } from "../db.js";
import {
  externalDelegateBatchDigest,
  parseExternalDelegateItems,
} from "../external-delegate.js";
import { parseSecondBrainStrictJsonBytes } from "../second-brain-strict-json.js";
import { writeDashboardJson } from "./http.js";

const STAGE = "/api/v1/internal/external-delegate";
const TRUST = "/api/v1/internal/external-delegate/trust";
const AUDIT = "/api/v1/internal/external-delegate/audit";
const TOKEN_HEADER = "x-jarvis-delegate-token";
const MAX_BODY = 64 * 1024;

export function isExternalDelegatePath(path: string): boolean {
  return path === STAGE || path === TRUST || path === AUDIT || path.startsWith(`${STAGE}/`);
}

export async function tryHandleExternalDelegate(input: Readonly<{
  path: string;
  request: IncomingMessage;
  response: ServerResponse;
  requestId: string;
  db: AuthorityDb;
  now?: Date;
}>): Promise<boolean> {
  if (!isExternalDelegatePath(input.path)) return false;
  const token = header(input.request.headers[TOKEN_HEADER]);
  if (!tokenMatches(token)) {
    writeDashboardJson(input.response, { status: 401, requestId: input.requestId, body: { error: { code: "DELEGATE_TOKEN_REQUIRED" } } });
    return true;
  }
  const now = input.now ?? new Date();
  try {
    if (input.path === TRUST && input.request.method === "GET") {
      writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body: trustBody(input.db) });
      return true;
    }
    if (input.path === AUDIT && input.request.method === "POST") {
      const body = await readObject(input.request);
      auditLowRisk(input.db, body, now);
      writeDashboardJson(input.response, { status: 202, requestId: input.requestId, body: { logged: true } });
      return true;
    }
    if (input.path === STAGE && input.request.method === "POST") {
      const body = await readObject(input.request);
      const staged = stage(input.db, body, now);
      writeDashboardJson(input.response, { status: 201, requestId: input.requestId, body: staged });
      return true;
    }
    const id = requestIdOf(input.path);
    if (id === undefined) return notFound(input);
    if (input.request.method === "GET" && input.path === `${STAGE}/${id}`) {
      const digest = new URL(input.request.url ?? "/", "http://127.0.0.1").searchParams.get("batch_digest") ?? "";
      writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body: lookup(input.db, id, digest, now) });
      return true;
    }
    if (input.request.method === "POST" && input.path === `${STAGE}/${id}/consume`) {
      const body = await readObject(input.request);
      consume(input.db, id, body, now);
      writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body: { consumed: true } });
      return true;
    }
    return notFound(input);
  } catch (error) {
    if (error instanceof JarvisError && error.code === "CONTROL_COMMAND_REPLAY_CONFLICT") {
      writeDashboardJson(input.response, { status: 409, requestId: input.requestId, body: { error: { code: "DELEGATE_CONFLICT" } } });
      return true;
    }
    if (error instanceof DelegateError) {
      writeDashboardJson(input.response, { status: error.status, requestId: input.requestId, body: { error: { code: error.code } } });
      return true;
    }
    if (error instanceof JarvisError) {
      writeDashboardJson(input.response, { status: 400, requestId: input.requestId, body: { error: { code: error.code } } });
      return true;
    }
    throw error;
  }
}

class DelegateError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function stage(db: AuthorityDb, body: Record<string, unknown>, now: Date): { request_id: string; command_digest: string; batch_digest: string; state: string } {
  if ("requested_by" in body || "source" in body) throw new DelegateError(400, "DELEGATE_INVALID");
  const items = parseExternalDelegateItems(body.items);
  const batchDigest = externalDelegateBatchDigest(items);
  if (body.batch_digest !== batchDigest) throw new DelegateError(400, "BATCH_DIGEST_MISMATCH");
  const summary = body.batch_summary;
  if (typeof summary !== "string" || summary.length < 1 || summary.length > 240) throw new DelegateError(400, "DELEGATE_INVALID");
  const requestId = body.request_id;
  if (typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(requestId)) throw new DelegateError(400, "DELEGATE_INVALID");
  const expiresIn = body.expires_in_seconds;
  if (typeof expiresIn !== "number" || !Number.isInteger(expiresIn) || expiresIn < 900 || expiresIn > 7200) throw new DelegateError(400, "DELEGATE_INVALID");
  const requested = now.toISOString();
  const input: ControlCommandRequestInput = {
    schema_version: 1,
    request_id: requestId,
    action: "external.delegate",
    action_level: 3,
    target: { environment: "external", system: "grok-bot" },
    args: {
      source: "grok-bot",
      action_kind: items.length === 1 ? items[0]?.action_kind : "batch",
      summary,
      batch_summary: summary,
      batch_digest: batchDigest,
      payload_digest: batchDigest,
      items,
    },
    reversible: false,
    requested_by: "agent:grok-bot",
    requested_at: requested,
    expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    nonce: `delegate:${requestId}`,
  };
  const staged = new ControlPlane(db).stage(input, now);
  return { request_id: staged.request_id, command_digest: staged.command_digest, batch_digest: batchDigest, state: staged.state };
}

function lookup(db: AuthorityDb, requestId: string, batchDigest: string, now: Date): Record<string, unknown> {
  const row = db.db.prepare(
    "SELECT state, command_digest, args_json, expires_at FROM control_command_requests WHERE request_id = ? AND action = 'external.delegate'",
  ).get(requestId) as { state: string; command_digest: string; args_json: string; expires_at: string } | undefined;
  if (row === undefined) throw new DelegateError(404, "DELEGATE_NOT_FOUND");
  const args = JSON.parse(row.args_json) as { batch_digest?: string };
  if (args.batch_digest !== batchDigest) throw new DelegateError(404, "DELEGATE_NOT_FOUND");
  const used = usedDigests(db, requestId);
  if (row.state === "pending") return { state: "pending", command_digest: row.command_digest, batch_digest: batchDigest, used_item_digests: used };
  if (row.state !== "approved") return { state: row.state, used_item_digests: used };
  if (Date.parse(row.expires_at) <= now.getTime()) return { state: "expired", used_item_digests: used };
  const receipt = db.db.prepare(
    "SELECT payload_json, key_id, expires_at FROM control_command_receipts WHERE request_id = ? AND decision = 'approve'",
  ).get(requestId) as { payload_json: string; key_id: string; expires_at: string } | undefined;
  if (receipt === undefined || Date.parse(receipt.expires_at) <= now.getTime()) return { state: "expired", used_item_digests: used };
  return {
    state: "approved",
    key_id: receipt.key_id,
    command_digest: row.command_digest,
    batch_digest: batchDigest,
    receipt: JSON.parse(receipt.payload_json) as unknown,
    used_item_digests: used,
  };
}

function consume(db: AuthorityDb, requestId: string, body: Record<string, unknown>, now: Date): void {
  const digest = body.item_digest;
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new DelegateError(400, "DELEGATE_INVALID");
  const row = db.db.prepare(
    "SELECT state, args_json, expires_at FROM control_command_requests WHERE request_id = ? AND action = 'external.delegate'",
  ).get(requestId) as { state: string; args_json: string; expires_at: string } | undefined;
  if (row === undefined || row.state !== "approved" || Date.parse(row.expires_at) <= now.getTime()) {
    throw new DelegateError(404, "DELEGATE_NOT_FOUND");
  }
  const args = JSON.parse(row.args_json) as { items?: Array<{ payload_digest?: string }> };
  if (!args.items?.some(item => item.payload_digest === digest)) throw new DelegateError(404, "DELEGATE_NOT_FOUND");
  const receipt = db.db.prepare(
    "SELECT payload_json, expires_at FROM control_command_receipts WHERE request_id = ? AND decision = 'approve'",
  ).get(requestId) as { payload_json: string; expires_at: string } | undefined;
  if (receipt === undefined || Date.parse(receipt.expires_at) <= now.getTime()) throw new DelegateError(404, "DELEGATE_NOT_FOUND");
  const signed = JSON.parse(receipt.payload_json) as { status?: string; decision?: string; not_before?: string; expires_at?: string };
  const notBefore = Date.parse(String(signed.not_before));
  const expires = Date.parse(String(signed.expires_at));
  if (signed.status !== "issued" || signed.decision !== "approve" || !Number.isFinite(notBefore) || !Number.isFinite(expires)
    || notBefore > now.getTime() || expires <= now.getTime()) {
    throw new DelegateError(404, "DELEGATE_NOT_FOUND");
  }
  const receiptId = typeof (JSON.parse(receipt.payload_json) as { receipt_id?: string }).receipt_id === "string"
    ? (JSON.parse(receipt.payload_json) as { receipt_id: string }).receipt_id : "";
  if (receiptId.length === 0) throw new DelegateError(404, "DELEGATE_NOT_FOUND");
  try {
    db.db.prepare("INSERT INTO external_delegate_item_uses(receipt_id, item_digest, request_id, used_at) VALUES(?,?,?,?)").run(
      receiptId, digest, requestId, now.toISOString(),
    );
  } catch (error) {
    if (String(error).includes("UNIQUE") || String(error).includes("constraint")) throw new DelegateError(409, "DELEGATE_ITEM_USED");
    throw error;
  }
  db.db.prepare("INSERT INTO audit_facts(fact_type,subject_id,payload_json,created_at) VALUES(?,?,?,?)").run(
    "external_delegate_item_use", requestId, JSON.stringify({ item_digest: digest }), now.toISOString(),
  );
}

function auditLowRisk(db: AuthorityDb, body: Record<string, unknown>, now: Date): void {
  const kind = body.action_kind;
  const summary = body.summary;
  if (typeof kind !== "string" || kind.length < 1 || kind.length > 64) throw new DelegateError(400, "DELEGATE_INVALID");
  if (typeof summary !== "string" || summary.length > 240) throw new DelegateError(400, "DELEGATE_INVALID");
  db.db.prepare("INSERT INTO audit_facts(fact_type,subject_id,payload_json,created_at) VALUES(?,?,?,?)").run(
    "owner_inbox_attempt",
    `low-risk:${kind}`,
    JSON.stringify({ outcome: "logged", decision: "none", code: "LOW_RISK", action_kind: kind, summary }),
    now.toISOString(),
  );
}

function usedDigests(db: AuthorityDb, requestId: string): string[] {
  const table = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'external_delegate_item_uses'").get();
  if (table === undefined) return [];
  const rows = db.db.prepare("SELECT item_digest FROM external_delegate_item_uses WHERE request_id = ?").all(requestId) as Array<{ item_digest: string }>;
  return rows.map(row => row.item_digest);
}

function trustBody(db: AuthorityDb): { key_id: string; spki_pem: string } {
  const row = db.db.prepare(
    `SELECT k.key_id, k.public_key_pem FROM trusted_authority_keys k
     JOIN authority_key_purposes p ON p.key_id = k.key_id
     WHERE p.purpose = 'decision' ORDER BY k.key_id LIMIT 1`,
  ).get() as { key_id: string; public_key_pem: string } | undefined;
  if (row === undefined) throw new DelegateError(503, "DELEGATE_UNCONFIGURED");
  return { key_id: row.key_id, spki_pem: row.public_key_pem };
}

function tokenMatches(presented: string | undefined): boolean {
  const file = process.env.JARVIS_EXTERNAL_DELEGATE_TOKEN_FILE;
  if (file === undefined || presented === undefined) return false;
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return false; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) return false;
    const buffer = Buffer.alloc(stat.size);
    readSync(fd, buffer, 0, stat.size, 0);
    const expected = buffer.toString("utf8").trim();
    const given = Buffer.from(presented);
    const want = Buffer.from(expected);
    return given.length === want.length && given.length >= 32 && timingSafeEqual(given, want);
  } finally {
    closeSync(fd);
  }
}

async function readObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) throw new DelegateError(413, "DELEGATE_INVALID");
    chunks.push(buffer);
  }
  const parsed = parseSecondBrainStrictJsonBytes(Buffer.concat(chunks));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new DelegateError(400, "DELEGATE_INVALID");
  return parsed as Record<string, unknown>;
}

function requestIdOf(path: string): string | undefined {
  const match = /^\/api\/v1\/internal\/external-delegate\/([^/]+)(?:\/consume)?$/.exec(path);
  const id = match?.[1];
  if (id === undefined || id === "trust" || id === "audit") return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(id)) return undefined;
  return id;
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function notFound(input: { response: ServerResponse; requestId: string }): boolean {
  writeDashboardJson(input.response, { status: 404, requestId: input.requestId, body: { error: { code: "NOT_FOUND" } } });
  return true;
}
