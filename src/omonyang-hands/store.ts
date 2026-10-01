import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { HandsError } from "./errors.js";
import type { ApprovalKind } from "./policy.js";

export type ApprovalRow = {
  readonly request_id: string;
  readonly batch_id: string;
  readonly action_kind: ApprovalKind;
  readonly summary: string;
  readonly payload_digest: string;
  readonly mail_draft_id: string | null;
  readonly requested_by: string;
  readonly requested_at: string;
  readonly expires_at: string;
  readonly state: "pending" | "approved" | "rejected" | "expired";
};

export type AuditRow = {
  readonly audit_id: string;
  readonly at: string;
  readonly agent: string;
  readonly tool: string;
  readonly input_digest: string;
  readonly output_digest: string | null;
  readonly error_code: string | null;
  readonly approval: string;
};

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function sha256Digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export class HandsStore {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS omonyang_audit (
        audit_id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        agent TEXT NOT NULL,
        tool TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        output_digest TEXT,
        error_code TEXT,
        approval TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS omonyang_approvals (
        request_id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        mail_draft_id TEXT,
        requested_by TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS omonyang_calendar_drafts (
        draft_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS omonyang_workboard_cards (
        card_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void { this.db.close(); }

  audit(row: AuditRow): void {
    this.db.prepare(
      `INSERT INTO omonyang_audit(audit_id,at,agent,tool,input_digest,output_digest,error_code,approval)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).run(row.audit_id, row.at, row.agent, row.tool, row.input_digest, row.output_digest, row.error_code, row.approval);
  }

  audits(): readonly AuditRow[] {
    return this.db.prepare("SELECT * FROM omonyang_audit ORDER BY at, audit_id").all() as AuditRow[];
  }

  stageApproval(input: {
    readonly request_id?: string;
    readonly batch_id: string;
    readonly action_kind: ApprovalKind;
    readonly summary: string;
    readonly payload_digest: string;
    readonly mail_draft_id?: string;
    readonly requested_by: string;
    readonly now: Date;
    readonly expires_in_seconds: number;
  }): ApprovalRow {
    if (!DIGEST.test(input.payload_digest)) throw new HandsError("VALIDATION", "payload_digest");
    if (input.summary.length < 1 || input.summary.length > 240) throw new HandsError("VALIDATION", "summary");
    if (input.expires_in_seconds < 900 || input.expires_in_seconds > 7200) throw new HandsError("VALIDATION", "expires_in_seconds");
    if (input.action_kind === "mail.send" && (input.mail_draft_id === undefined || input.mail_draft_id.length === 0)) {
      throw new HandsError("VALIDATION", "mail_draft_id");
    }
    const request_id = input.request_id ?? `req_${randomUUID()}`;
    if (!/^[A-Za-z0-9:_-]{8,80}$/.test(request_id)) throw new HandsError("VALIDATION", "request_id");
    const requested_at = input.now.toISOString();
    const expires_at = new Date(input.now.getTime() + input.expires_in_seconds * 1000).toISOString();
    const prior = this.approval(request_id);
    if (prior) {
      if (prior.payload_digest !== input.payload_digest) throw new HandsError("CONFLICT", request_id);
      return prior;
    }
    this.db.prepare(
      `INSERT INTO omonyang_approvals(request_id,batch_id,action_kind,summary,payload_digest,mail_draft_id,requested_by,requested_at,expires_at,state)
       VALUES(?,?,?,?,?,?,?,?,?,'pending')`,
    ).run(request_id, input.batch_id, input.action_kind, input.summary, input.payload_digest, input.mail_draft_id ?? null,
      input.requested_by, requested_at, expires_at);
    const stored = this.approval(request_id);
    if (!stored) throw new HandsError("AUDIT_FAILED", request_id);
    return stored;
  }

  approval(requestId: string, now = new Date()): ApprovalRow | undefined {
    const row = this.db.prepare("SELECT * FROM omonyang_approvals WHERE request_id=?").get(requestId) as ApprovalRow | undefined;
    if (!row) return undefined;
    if (row.state === "pending" && Date.parse(row.expires_at) <= now.getTime()) {
      this.db.prepare("UPDATE omonyang_approvals SET state='expired' WHERE request_id=? AND state='pending'").run(requestId);
      return { ...row, state: "expired" };
    }
    return row;
  }

  decide(requestId: string, state: "approved" | "rejected"): ApprovalRow {
    const row = this.approval(requestId);
    if (!row) throw new HandsError("NOT_FOUND", requestId);
    if (row.state === "expired") return row;
    this.db.prepare("UPDATE omonyang_approvals SET state=? WHERE request_id=?").run(state, requestId);
    const next = this.approval(requestId);
    if (!next) throw new HandsError("NOT_FOUND", requestId);
    return next;
  }
}
