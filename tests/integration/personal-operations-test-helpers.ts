import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize } from "../../src/canonical.js";
import { AuthorityDb } from "../../src/index.js";

export const T0 = "2026-08-28T00:00:00.000Z";
export const T1 = "2026-08-28T00:01:00.000Z";
export const T2 = "2026-08-28T00:02:00.000Z";
export const T3 = "2026-08-28T00:03:00.000Z";
export const T4 = "2026-08-28T00:04:00.000Z";
export const T5 = "2026-08-28T00:05:00.000Z";
export const digest = (character: string): string => `sha256:${character.repeat(64)}`;

export async function personalDb(migrationsPath = process.env.PERSONAL_OPERATIONS_MIGRATIONS): Promise<AuthorityDb> {
  const root = mkdtempSync(join(tmpdir(), "jarvis-personal-operations-"));
  const db = new AuthorityDb(join(root, "authority.sqlite"), migrationsPath);
  try {
    await db.migrate();
    return db;
  } catch (error) {
    db.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function insertDailyRun(db: AuthorityDb, input: { readonly runId: string; readonly correlation: string; readonly idempotency: string; readonly createdAt?: string; readonly expiresAt?: string; readonly loopDate?: string; readonly state?: string; readonly steps?: readonly { readonly key: string; readonly sequence: number }[] }): void {
  const createdAt = input.createdAt ?? T0;
  const expiresAt = input.expiresAt ?? T5;
  const loopDate = input.loopDate ?? "2026-08-28";
  const steps = input.steps ?? [];
  const material = canonicalize({ logical_key: input.idempotency, local_date: loopDate, phase: "morning", scheduled_at: createdAt, occurred_at: null, event_id: null, critical: false, critical_reason: null, event_cost: null, not_before: createdAt, created_at: createdAt, deadline_at: expiresAt, steps });
  const inputDigest = `sha256:${createHash("sha256").update("orca-jarvis/daily-loop-input/v1\0").update(material).digest("hex")}`;
  db.db.prepare("INSERT INTO daily_loop_runs(run_id,loop_date,correlation_id,idempotency_key,state,lease_fence,expires_at,created_at,updated_at,record_version,phase,not_before,input_json,input_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(input.runId, loopDate, input.correlation, input.idempotency, input.state ?? "pending", 0, expiresAt, createdAt, createdAt, 1, "morning", createdAt, material, inputDigest);
}

export function closePersonalDb(db: AuthorityDb): void {
  const root = join(db.filename, "..");
  db.close();
  rmSync(root, { recursive: true, force: true });
}

export function migrationCopy(include033 = true): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-personal-migrations-"));
  const directory = join(root, "migrations");
  cpSync(join(process.cwd(), "migrations"), directory, { recursive: true });
  if (!include033) {
    for (const file of readdirSync(directory)) {
      if (file.endsWith(".sql") && file > "032_personal_context.sql") rmSync(join(directory, file));
    }
  }
  return directory;
}

export function removeMigrationCopy(directory: string): void {
  rmSync(join(directory, ".."), { recursive: true, force: true });
}

export function migrationCount(directory = join(process.cwd(), "migrations")): number {
  return readdirSync(directory).filter(file => file.endsWith(".sql")).length;
}

export type ApprovalFixture = {
  readonly suffix: string;
  readonly action: string;
  readonly target: Readonly<Record<string, unknown>>;
  readonly args: Readonly<Record<string, unknown>>;
  readonly requestedBy?: string;
  readonly signer?: string;
  readonly sessionId?: string;
  readonly decision?: "approve" | "reject";
  readonly requestExpiresAt?: string;
  readonly receiptExpiresAt?: string;
};

export type StoredApproval = {
  readonly requestId: string;
  readonly receiptId: string;
  readonly receiptDigest: string;
  readonly commandDigest: string;
};

export function insertApproval(db: AuthorityDb, fixture: ApprovalFixture): StoredApproval {
  const requestId = `request:${fixture.suffix}`;
  const receiptId = `receipt:${fixture.suffix}`;
  const commandDigest = `sha256:${createHash("sha256").update(canonicalize({ action: fixture.action, args: fixture.args, requestId, target: fixture.target })).digest("hex")}`;
  const requestedBy = fixture.requestedBy ?? "local-owner";
  const signer = fixture.signer ?? requestedBy;
  const sessionId = fixture.sessionId ?? "session:local-owner";
  const receiptDigest = `sha256:${createHash("sha256").update(canonicalize({ commandDigest, receiptId, requestId, sessionId, signer })).digest("hex")}`;
  const payload = canonicalize({ receipt_digest: receiptDigest, receipt_id: receiptId, request_id: requestId });
  db.db.prepare("INSERT INTO control_command_requests(request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,requested_at,expires_at,nonce,state,lease_owner,lease_fence,lease_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(requestId, fixture.action, 3, canonicalize(fixture.target), canonicalize(fixture.args), commandDigest, 0, requestedBy, T0, fixture.requestExpiresAt ?? T5, `nonce:${fixture.suffix}`, "approved", null, 0, null, T0);
  db.db.prepare("INSERT INTO control_command_receipts(receipt_id,request_id,decision,command_digest,signer_principal_id,authenticated_session_id,key_id,payload_json,signature,issued_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(receiptId, requestId, fixture.decision ?? "approve", commandDigest, signer, sessionId, "key:owner", payload, "signature", T0, fixture.receiptExpiresAt ?? T5, T0);
  return { requestId, receiptId, receiptDigest, commandDigest };
}
