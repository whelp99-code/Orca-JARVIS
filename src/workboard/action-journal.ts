import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { canonicalize } from "../canonical.js";
import type { ActionOperation, ActionRequest, ActionResult, PreparedAction } from "./action-contracts.js";

export type Intent = ActionResult & { request: ActionRequest; requestDigest: string; operation: ActionOperation };

/** Dedicated isolated journal connection; never constructed by a GET or on the production authority DB. */
export class ActionJournal {
  constructor(readonly db: Database.Database) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.exec(`CREATE TABLE IF NOT EXISTS workboard_action_prepared (
      token TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workboard_action_intents (
      intent_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, source_id TEXT NOT NULL,
      request_id TEXT NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL,
      UNIQUE(source_id, request_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS workboard_action_uncertain_work
      ON workboard_action_intents(work_id) WHERE status='uncertain';`);
  }
  prepare(request: ActionRequest, requiresReceipt: boolean): PreparedAction {
    const prepared = { token: randomUUID(), request, requiresReceipt };
    this.db.prepare("INSERT INTO workboard_action_prepared VALUES(?,?)").run(prepared.token, canonicalize(prepared));
    return prepared;
  }
  prepared(token: string): PreparedAction {
    const row = this.db.prepare("SELECT value FROM workboard_action_prepared WHERE token=?").get(token) as { value: string } | undefined;
    if (!row) throw new Error("WORKBOARD_PREPARED_UNKNOWN");
    return JSON.parse(row.value) as PreparedAction;
  }
  find(request: ActionRequest): Intent | null {
    const row = this.db.prepare(`SELECT value FROM workboard_action_intents
      WHERE (source_id=? AND request_id=?) OR (work_id=? AND status='uncertain')
      ORDER BY CASE WHEN source_id=? AND request_id=? THEN 0 ELSE 1 END LIMIT 1`)
      .get(request.sourceId, request.requestId, request.workId, request.sourceId, request.requestId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as Intent : null;
  }
  pending(workId: string): Intent | null {
    const row = this.db.prepare("SELECT value FROM workboard_action_intents WHERE work_id=? AND status='uncertain'").get(workId) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as Intent : null;
  }
  reserve(request: ActionRequest, requestDigest: string, operation: ActionOperation): { intent: Intent; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.find(request);
      if (existing) return { intent: existing, created: false };
      const intent: Intent = { intentId: randomUUID(), request, requestDigest, operation, status: "uncertain", receipt: null, error: null };
      this.db.prepare("INSERT INTO workboard_action_intents VALUES(?,?,?,?,?,?)")
        .run(intent.intentId, request.workId, request.sourceId, request.requestId, intent.status, canonicalize(intent));
      return { intent, created: true };
    }).immediate();
  }
  save(intent: Intent): void {
    // A delayed failed read must not downgrade a receipt another reconciliation already persisted.
    this.db.prepare("UPDATE workboard_action_intents SET status=?,value=? WHERE intent_id=? AND status='uncertain'")
      .run(intent.status, canonicalize(intent), intent.intentId);
  }
  get(intentId: string): Intent {
    const row = this.db.prepare("SELECT value FROM workboard_action_intents WHERE intent_id=?").get(intentId) as { value: string } | undefined;
    if (!row) throw new Error("WORKBOARD_INTENT_UNKNOWN");
    return JSON.parse(row.value) as Intent;
  }
  all(): Intent[] {
    return (this.db.prepare("SELECT value FROM workboard_action_intents ORDER BY rowid").all() as { value: string }[])
      .map(row => JSON.parse(row.value) as Intent);
  }
}
