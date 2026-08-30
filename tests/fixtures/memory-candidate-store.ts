import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthorityDb,
  MemoryCandidateStore,
} from "../../src/index.js";
import { canonicalize } from "../../src/canonical.js";
import {
  decisionBindingDigest,
  memoryHash,
  memoryPolicy,
  MEMORY_NOW,
  MEMORY_OBSERVED,
  MEMORY_SOURCE_EXPIRES,
} from "./memory-candidate-fixture.js";

export type MemoryDatabase = {
  readonly authority: AuthorityDb;
  readonly root: string;
  readonly path: string;
};

export function memoryRecord(value: unknown): Record<string, unknown> {
  if (!isMemoryRecord(value)) throw new TypeError("record required");
  return value;
}

function isMemoryRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function memoryDatabase(): Promise<MemoryDatabase> {
  const root = mkdtempSync(join(tmpdir(), "jarvis-task27-memory-"));
  const path = join(root, "authority.sqlite");
  const authority = new AuthorityDb(path);
  try {
    await authority.migrate();
    return { authority, root, path };
  } catch (error) {
    authority.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function closeMemoryDatabase(value: MemoryDatabase): void {
  value.authority.close();
  rmSync(value.root, { recursive: true, force: true });
}

export function memoryTableCount(authority: AuthorityDb, table: string): number {
  const value = memoryRecord(authority.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get())["count"];
  if (typeof value !== "number") throw new TypeError("count required");
  return value;
}

export function memoryTableCounts(authority: AuthorityDb): Readonly<Record<string, number>> {
  const rows: readonly unknown[] = authority.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all();
  return Object.fromEntries(rows.map(value => {
    const name = memoryRecord(value)["name"];
    if (typeof name !== "string") throw new TypeError("table name required");
    return [name, memoryTableCount(authority, name)];
  }));
}

export function memoryTableDelta(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
  table: string,
): number {
  return (after[table] ?? 0) - (before[table] ?? 0);
}

export function memoryCandidateStore(authority: AuthorityDb, policy: unknown = memoryPolicy()): MemoryCandidateStore {
  return new MemoryCandidateStore(authority, policy, () => new Date(MEMORY_NOW));
}

export function memoryPolicyWithRetention(days: number): unknown {
  const policy = structuredClone(memoryPolicy());
  const classes = memoryRecord(memoryRecord(policy)["data_classes"]);
  memoryRecord(classes["memory"])["retention_days"] = days;
  return policy;
}

export function memorySource(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return memoryRecord(value["source"]);
}

export function seedMemoryDecision(authority: AuthorityDb, input: Readonly<Record<string, unknown>>): void {
  const provenance = memorySource(input);
  const requestId = String(provenance["request_id"]);
  const receiptId = String(provenance["receipt_id"]);
  const signer = String(provenance["signer_principal_id"]);
  const session = String(provenance["authenticated_session_id"]);
  const binding = decisionBindingDigest(input);
  const targetValue = { environment: "local", memory_candidate_binding: binding };
  const argsValue = { memory_candidate_binding: binding };
  const commandDigest = memoryHash("", {
    schema_version: 1,
    request_id: requestId,
    action: "workflow.start",
    action_level: 3,
    target: targetValue,
    args: argsValue,
    reversible: true,
    requested_by: signer,
    requested_at: MEMORY_OBSERVED,
    expires_at: MEMORY_SOURCE_EXPIRES,
    nonce: "nonce:task27:decision",
  });
  provenance["command_digest"] = commandDigest;
  authority.db.prepare(
    `INSERT INTO control_command_requests(
      request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,
      requested_at,expires_at,nonce,state,lease_fence,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(requestId, "workflow.start", 3, canonicalize(targetValue), canonicalize(argsValue), commandDigest, 1, signer,
    MEMORY_OBSERVED, MEMORY_SOURCE_EXPIRES, "nonce:task27:decision", "approved", 0, MEMORY_OBSERVED);
  authority.db.prepare(
    `INSERT INTO control_command_receipts(
      receipt_id,request_id,decision,command_digest,signer_principal_id,authenticated_session_id,key_id,
      payload_json,signature,issued_at,expires_at,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(receiptId, requestId, "approve", commandDigest, signer, session, "key:task27:owner",
    canonicalize({ binding, command_digest: commandDigest, receipt_id: receiptId, request_id: requestId }),
    "signature:task27", MEMORY_OBSERVED, MEMORY_SOURCE_EXPIRES, MEMORY_OBSERVED);
}
