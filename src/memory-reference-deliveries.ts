import { randomUUID } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { memoryReadPrivacyState, type MemoryMembership } from "./memory-read-privacy.js";

/** Trusted client adapter observations, not end-user scope/authorization claims. */
export type MemoryReferenceSession = {
  readonly client_id: string; readonly session_id: string; readonly epoch_id: string;
};
export type MemoryReferenceAttempt = {
  readonly attempt_id: string;
  readonly state: "dispatching" | "callback_completed" | "unconfirmed" | "invalidated";
};

/** Durable metadata in the existing authority DB. Does not certify native client receipt. */
export class MemoryReferenceDeliveries {
  constructor(private readonly authority: AuthorityDb, private readonly membership: MemoryMembership) {}

  claim(session: MemoryReferenceSession, binding: string, recordSet: string, payload: string, now: Date,
    privacy: string, assertCurrent?: () => void): string {
    if (!session || Object.keys(session).sort().join(",") !== "client_id,epoch_id,session_id"
      || Object.values(session).some(value => typeof value !== "string" || !/^[a-zA-Z0-9:._/-]{1,256}$/.test(value))
      || !Number.isFinite(now.getTime())) throw new JarvisError("MEMORY_REFERENCE_SESSION_INVALID");
    const key = (kind: string, value: unknown): string => this.membership("record",
      `reference-delivery/${kind}/v1\0${canonicalize(value)}`);
    const sessionKey = key("session", [session.client_id, session.session_id]);
    const bindingKey = key("binding", binding);
    const keyBinding = key("key-binding", "authority-journal");
    const at = now.toISOString();
    const attemptId = `memsend:v1:${randomUUID()}`;
    const error = this.authority.db.transaction(() => {
      assertCurrent?.();
      const identity = this.authority.db.prepare(
        "SELECT key_binding FROM personal_context_reference_identity WHERE singleton_id=1",
      ).get() as { key_binding: string } | undefined;
      if (identity === undefined && this.authority.db.prepare(
        "SELECT 1 FROM personal_context_reference_sessions LIMIT 1",
      ).get()) return "MEMORY_REFERENCE_KEY_CHANGED";
      if (identity !== undefined && identity.key_binding !== keyBinding) return "MEMORY_REFERENCE_KEY_CHANGED";
      if (canonicalize(memoryReadPrivacyState(this.authority)) !== privacy) {
        return "MEMORY_REFERENCE_PRIVACY_CHANGED";
      }
      const prior = this.authority.db.prepare(
        "SELECT binding_key,state FROM personal_context_reference_sessions WHERE session_key=?",
      ).get(sessionKey) as { binding_key: string; state: string } | undefined;
      if (prior !== undefined && (prior.state !== "active" || prior.binding_key !== bindingKey)) {
        this.authority.db.prepare("UPDATE personal_context_reference_sessions SET state='invalidated',binding_key=NULL,updated_at=MAX(updated_at,?) WHERE session_key=?").run(at, sessionKey);
        this.authority.db.prepare("UPDATE personal_context_reference_attempts SET state='invalidated',epoch_key=NULL,record_set_key=NULL,payload_key=NULL,updated_at=MAX(updated_at,?) WHERE session_key=?").run(at, sessionKey);
        return "MEMORY_REFERENCE_SESSION_INVALIDATED";
      }
      if (this.authority.db.prepare(`SELECT 1 FROM personal_context_reference_attempts
        WHERE session_key=? AND state IN ('dispatching','unconfirmed') LIMIT 1`).get(sessionKey)) {
        return "MEMORY_REFERENCE_DELIVERY_UNCONFIRMED";
      }
      const epochKey = key("epoch", session.epoch_id); const recordKey = key("records", recordSet);
      if (this.authority.db.prepare(`SELECT 1 FROM personal_context_reference_attempts
        WHERE session_key=? AND epoch_key=? AND record_set_key=?`).get(sessionKey, epochKey, recordKey)) {
        return "MEMORY_REFERENCE_ALREADY_SUBMITTED";
      }
      if (identity === undefined) this.authority.db.prepare(
        "INSERT INTO personal_context_reference_identity VALUES(1,?)",
      ).run(keyBinding);
      if (prior === undefined) this.authority.db.prepare(`INSERT INTO personal_context_reference_sessions
        VALUES(?,?,'active',?,?)`).run(sessionKey, bindingKey, at, at);
      this.authority.db.prepare(`INSERT INTO personal_context_reference_attempts
        VALUES(?,?,?,?,?,'dispatching',?,?)`).run(attemptId, sessionKey, epochKey, recordKey, key("payload", payload), at, at);
      return null;
    }).immediate();
    if (error !== null) throw new JarvisError(error);
    return attemptId;
  }

  finish(attemptId: string, state: "callback_completed" | "unconfirmed", now: Date, assertCurrent?: () => void): void {
    const at = this.timestamp(now);
    this.authority.db.transaction(() => {
    this.assertKey();
    assertCurrent?.();
    const changed = this.authority.db.prepare(`UPDATE personal_context_reference_attempts SET state=?,updated_at=MAX(updated_at,?)
      WHERE attempt_id=? AND state='dispatching' AND session_key IN (
        SELECT session_key FROM personal_context_reference_sessions WHERE state='active')`).run(state, at, attemptId);
    if (changed.changes !== 1) throw new JarvisError("MEMORY_REFERENCE_SESSION_INVALIDATED");
    }).immediate();
  }

  status(attemptId: string): MemoryReferenceAttempt | null {
    this.assertKey();
    return this.authority.db.prepare("SELECT attempt_id,state FROM personal_context_reference_attempts WHERE attempt_id=?")
      .get(attemptId) as MemoryReferenceAttempt | undefined ?? null;
  }

  invalidate(attemptId: string, now: Date): void {
    const at = this.timestamp(now);
    this.authority.db.transaction(() => {
      this.assertKey();
      this.authority.db.prepare(`UPDATE personal_context_reference_sessions SET state='invalidated',binding_key=NULL,updated_at=MAX(updated_at,?)
        WHERE session_key IN (SELECT session_key FROM personal_context_reference_attempts WHERE attempt_id=?)`)
        .run(at, attemptId);
      this.authority.db.prepare(`UPDATE personal_context_reference_attempts SET state='invalidated',epoch_key=NULL,record_set_key=NULL,payload_key=NULL,updated_at=MAX(updated_at,?)
        WHERE session_key IN (SELECT session_key FROM personal_context_reference_attempts WHERE attempt_id=?)`)
        .run(at, attemptId);
    }).immediate();
  }
  private timestamp(now: Date): string {
    if (!Number.isFinite(now.getTime())) throw new JarvisError("MEMORY_REFERENCE_SESSION_INVALID");
    return now.toISOString();
  }

  private assertKey(): void {
    const expected = this.membership("record",
      `reference-delivery/key-binding/v1\0${canonicalize("authority-journal")}`);
    const row = this.authority.db.prepare(
      "SELECT key_binding FROM personal_context_reference_identity WHERE singleton_id=1",
    ).get() as { key_binding: string } | undefined;
    if (row === undefined || row.key_binding !== expected) throw new JarvisError("MEMORY_REFERENCE_KEY_CHANGED");
  }

}
