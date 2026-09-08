import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";

export type DestructiveDispatchClaim = {
  readonly kind: "claimed" | "reconcile";
  readonly fence: number;
  readonly lane_id: string;
  readonly sequence: number;
};

export type DestructiveDispatchInput = {
  readonly lane_id: string;
  readonly lane: "correction" | "deletion";
  readonly sequence: number;
  readonly request_digest: string;
};

type CursorRow = {
  readonly fence: number;
  readonly active_lane_id: string | null;
  readonly active_lane: "correction" | "deletion" | null;
  readonly active_sequence: number | null;
  readonly active_request_digest: string | null;
  readonly accepted_through_sequence: number;
};

type PreparationRow = {
  readonly lane: "correction" | "deletion";
  readonly request_tombstone_sequence: number;
  readonly request_digest: string;
  readonly state: string;
};

export class MemoryDestructiveDispatchCursor {
  constructor(private readonly authority: AuthorityDb) {}

  claim(input: DestructiveDispatchInput, now: Date): DestructiveDispatchClaim {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1
      || !/^sha256:[0-9a-f]{64}$/.test(input.request_digest)) {
      throw new JarvisError("MEMORY_DESTRUCTIVE_DISPATCH_INVALID");
    }
    return this.authority.db.transaction((): DestructiveDispatchClaim => {
      if (this.authority.db.prepare(`SELECT 1 FROM memory_correction_cancellation_intents i
        JOIN memory_correction_requests c ON c.correction_id=i.correction_id WHERE c.lane_id=?`).get(input.lane_id)) {
        throw new JarvisError("MEMORY_REQUEST_CANCELLED");
      }
      const cursor = this.cursor();
      if (cursor.active_lane_id !== null) return this.reconcileClaim(cursor, input);
      const preparation = this.authority.db.prepare(
        `SELECT lane,request_tombstone_sequence,request_digest,state
         FROM memory_effect_preparations WHERE lane_id=?`,
      ).get(input.lane_id) as PreparationRow | undefined;
      if (preparation === undefined || preparation.lane !== input.lane
        || preparation.request_tombstone_sequence !== input.sequence
        || preparation.request_digest !== input.request_digest || preparation.state !== "approved") {
        throw new JarvisError("MEMORY_DESTRUCTIVE_DISPATCH_INVALID");
      }
      const next = this.authority.db.prepare(
        `SELECT MIN(request_tombstone_sequence) AS sequence FROM memory_effect_preparations
         WHERE lane IN ('correction','deletion') AND state='approved'
           AND request_tombstone_sequence>?`,
      ).get(cursor.accepted_through_sequence) as { readonly sequence: number | null };
      if (next.sequence !== input.sequence) throw new JarvisError("MEMORY_DESTRUCTIVE_ORDER_BLOCKED");
      const changed = this.authority.db.prepare(
        `UPDATE memory_effect_dispatch_cursor SET fence=fence+1,active_lane_id=?,active_lane=?,
         active_sequence=?,active_request_digest=?,updated_at=?
         WHERE singleton_id=1 AND active_lane_id IS NULL AND accepted_through_sequence=?`,
      ).run(input.lane_id, input.lane, input.sequence, input.request_digest,
        now.toISOString(), cursor.accepted_through_sequence);
      if (changed.changes !== 1) throw new JarvisError("MEMORY_DESTRUCTIVE_DISPATCH_RACE");
      return { kind: "claimed", fence: cursor.fence + 1, lane_id: input.lane_id,
        sequence: input.sequence };
    }).immediate();
  }

  accepted(laneId: string, now: Date): void {
    this.authority.db.transaction(() => {
      const cursor = this.cursor();
      if (cursor.active_lane_id === null) {
        const preparation = this.authority.db.prepare(
          "SELECT request_tombstone_sequence FROM memory_effect_preparations WHERE lane_id=?",
        ).get(laneId) as { readonly request_tombstone_sequence: number | null } | undefined;
        if (preparation?.request_tombstone_sequence !== null
          && preparation?.request_tombstone_sequence !== undefined
          && preparation.request_tombstone_sequence <= cursor.accepted_through_sequence) return;
        throw new JarvisError("MEMORY_DESTRUCTIVE_CURSOR_INVALID");
      }
      if (cursor.active_lane_id !== laneId || cursor.active_sequence === null) {
        throw new JarvisError("MEMORY_DESTRUCTIVE_CURSOR_INVALID");
      }
      const changed = this.authority.db.prepare(
        `UPDATE memory_effect_dispatch_cursor SET active_lane_id=NULL,active_lane=NULL,
         active_sequence=NULL,active_request_digest=NULL,accepted_through_sequence=?,updated_at=?
         WHERE singleton_id=1 AND active_lane_id=? AND active_sequence=?`,
      ).run(cursor.active_sequence, now.toISOString(), laneId, cursor.active_sequence);
      if (changed.changes !== 1) throw new JarvisError("MEMORY_DESTRUCTIVE_DISPATCH_RACE");
    }).immediate();
  }

  active(): Readonly<CursorRow> {
    return Object.freeze({ ...this.cursor() });
  }

  private reconcileClaim(cursor: CursorRow, input: DestructiveDispatchInput): DestructiveDispatchClaim {
    if (cursor.active_lane_id !== input.lane_id) throw new JarvisError("MEMORY_DESTRUCTIVE_ORDER_BLOCKED");
    if (cursor.active_lane !== input.lane || cursor.active_sequence !== input.sequence
      || cursor.active_request_digest !== input.request_digest) {
      throw new JarvisError("MEMORY_DESTRUCTIVE_CURSOR_INVALID");
    }
    return { kind: "reconcile", fence: cursor.fence, lane_id: input.lane_id,
      sequence: input.sequence };
  }

  private cursor(): CursorRow {
    const row = this.authority.db.prepare(
      `SELECT fence,active_lane_id,active_lane,active_sequence,active_request_digest,
              accepted_through_sequence FROM memory_effect_dispatch_cursor WHERE singleton_id=1`,
    ).get() as CursorRow | undefined;
    if (row === undefined) throw new JarvisError("MEMORY_DESTRUCTIVE_CURSOR_INVALID");
    return row;
  }
}
