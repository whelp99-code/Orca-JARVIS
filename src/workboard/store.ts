import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { attemptKey, sessionKey, sourceKey, validateEvent, workKey, type WorkEvent } from "./contracts.js";

export class WorkboardStore {
  constructor(readonly db: Database.Database) {
    db.exec(readFileSync(resolve("migrations/099_workboard_projection.sql"), "utf8"));
  }

  ingest(input: unknown): "inserted" | "replayed" {
    validateEvent(input);
    const event: WorkEvent = input;
    // Hash the accepted event, not a mutable projection. Replay collisions remain observable.
    const digest = createHash("sha256").update(JSON.stringify(event)).digest("hex");
    return this.db.transaction(() => {
      const sk = sourceKey(event.source);
      const existing = this.db.prepare(
        "SELECT digest FROM workboard_events WHERE source_key=? AND event_id=?",
      ).get(sk, event.eventId) as { digest: string } | undefined;
      if (existing) {
        if (existing.digest !== digest) throw new Error("WORKBOARD_EVENT_CONFLICT");
        return "replayed" as const;
      }
      const session = sessionKey(event.source, event.sessionId);
      const alias = event.alias && sessionKey(event.alias.source, event.alias.sessionId);
      // Only an already-observed explicit target may be joined; no repo/path guesses.
      const target = alias
        ? this.db.prepare(
          "SELECT session_key,alias_of FROM workboard_sessions WHERE session_key=?",
        ).get(alias) as { session_key: string; alias_of: string | null } | undefined
        : undefined;
      const canonical = target ? (target.alias_of ?? target.session_key) : session;
      this.db.prepare("INSERT OR IGNORE INTO workboard_sources(source_key) VALUES(?)").run(sk);
      this.db.prepare("INSERT OR IGNORE INTO workboard_sessions(session_key,source_key,session_id,alias_of) VALUES(?,?,?,?)")
        .run(session, sk, event.sessionId, canonical === session ? null : canonical);
      const attempt = attemptKey(session, event.incarnation);
      this.db.prepare("INSERT OR IGNORE INTO workboard_attempts(attempt_key,session_key,incarnation) VALUES(?,?,?)")
        .run(attempt, session, event.incarnation);
      this.db.prepare("INSERT INTO workboard_events(source_key,event_id,digest,sequence,session_key,received_at) VALUES(?,?,?,?,?,?)")
        .run(sk, event.eventId, digest, event.sequence, session, event.receivedAt);
      const id = workKey(canonical, event.taskId);
      const parentSession = event.parent ? sessionKey(event.parent.source, event.parent.sessionId) : null;
      const parent = parentSession
        ? this.db.prepare(
          "SELECT alias_of FROM workboard_sessions WHERE session_key=?",
        ).get(parentSession) as { alias_of: string | null } | undefined
        : undefined;
      const parentId = parentSession ? workKey(parent?.alias_of ?? parentSession, null) : null;
      const old = this.db.prepare(
        "SELECT sequence,source_key FROM workboard_works WHERE work_id=?",
      ).get(id) as { sequence: number; source_key: string } | undefined;
      // A late observation remains in the event ledger but cannot roll the current state back.
      if (!old || (old.source_key === sk && event.sequence > old.sequence)) {
        this.db.prepare(`INSERT INTO workboard_works(
          work_id,session_key,session_id,task_id,parent_work_id,source_key,sequence,
          state,summary,evidence_ref,source_at,received_at,attempt_key)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET
          sequence=excluded.sequence,state=excluded.state,summary=excluded.summary,evidence_ref=excluded.evidence_ref,
          source_at=excluded.source_at,received_at=excluded.received_at,attempt_key=excluded.attempt_key,
          parent_work_id=excluded.parent_work_id`).run(id, canonical, canonical === session ? event.sessionId : event.alias!.sessionId,
          event.taskId, parentId, sk, event.sequence, event.state, event.summary, event.evidenceRef, event.sourceAt, event.receivedAt, attempt);
      }
      this.db.prepare(
        "UPDATE workboard_sources SET warning=NULL,last_successful_observation=?"
        + " WHERE source_key=? AND (last_successful_observation IS NULL OR last_successful_observation < ?)",
      ).run(event.receivedAt, sk, event.receivedAt);
      return "inserted" as const;
    })();
  }
  works(): Array<Record<string, unknown>> {
    return this.db.prepare(`SELECT w.*, s.warning, (SELECT COUNT(*) FROM workboard_attempts a
      WHERE a.session_key=w.session_key OR a.session_key IN (SELECT session_key FROM workboard_sessions WHERE alias_of=w.session_key)) AS attempt_count
      FROM workboard_works w JOIN workboard_sources s ON s.source_key=w.source_key ORDER BY w.work_id`).all() as Array<Record<string, unknown>>;
  }
  sessions(): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM workboard_sessions ORDER BY session_key").all() as Array<Record<string, unknown>>;
  }
  outage(key: string, reason: string): void {
    if (!reason || reason.length > 256) throw new Error("WORKBOARD_OUTAGE_INVALID");
    this.db.prepare("UPDATE workboard_sources SET warning=? WHERE source_key=?").run(reason, key);
  }
}
