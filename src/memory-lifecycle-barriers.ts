import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";

export const JARVIS_MEMORY_BARRIER_IDS = [
  "jarvis_suppression_tombstone_commit",
  "jarvis_proof_observation",
  "before_settlement_commit",
] as const;

export type JarvisMemoryBarrierId = (typeof JARVIS_MEMORY_BARRIER_IDS)[number];

export type JarvisMemoryBarrierEvent = {
  readonly barrier_id: JarvisMemoryBarrierId;
  readonly lane_id: string;
  readonly request_id: string;
  readonly tombstone_sequence: number;
  readonly event_digest: string;
  readonly reached_at: string;
};

export interface MemoryLifecycleBarrierSink {
  reached(event: JarvisMemoryBarrierEvent): Promise<void> | void;
}

export class NoopMemoryLifecycleBarrierSink implements MemoryLifecycleBarrierSink {
  reached(event: JarvisMemoryBarrierEvent): void {
    void event;
  }
}

export class MemoryLifecycleBarriers {
  constructor(
    private readonly authority: AuthorityDb,
    private readonly sink: MemoryLifecycleBarrierSink,
  ) {}

  async reach(input: {
    readonly barrier_id: JarvisMemoryBarrierId;
    readonly lane_id: string;
    readonly request_id: string;
    readonly tombstone_sequence: number;
    readonly now: Date;
  }): Promise<JarvisMemoryBarrierEvent> {
    const { barrier_id: barrierId, lane_id: laneId, request_id: requestId,
      tombstone_sequence: tombstoneSequence, now } = input;
    if (!JARVIS_MEMORY_BARRIER_IDS.includes(barrierId)
      || laneId.length === 0 || requestId.length === 0
      || !Number.isSafeInteger(tombstoneSequence) || tombstoneSequence < 0) {
      throw new JarvisError("MEMORY_LIFECYCLE_BARRIER_INVALID");
    }
    const prior = this.authority.db.prepare(
      `SELECT event_digest,tombstone_sequence,created_at FROM memory_lifecycle_barrier_events
       WHERE barrier_id=? AND lane_id=? AND request_id=?`,
    ).get(barrierId, laneId, requestId);
    if (prior !== undefined) {
      if (prior === null || typeof prior !== "object"
        || Reflect.get(prior, "tombstone_sequence") !== tombstoneSequence
        || typeof Reflect.get(prior, "event_digest") !== "string"
        || typeof Reflect.get(prior, "created_at") !== "string") {
        throw new JarvisError("MEMORY_LIFECYCLE_BARRIER_REPLAY_CONFLICT");
      }
      const replay = { barrier_id: barrierId, lane_id: laneId, request_id: requestId,
        tombstone_sequence: tombstoneSequence,
        event_digest: String(Reflect.get(prior, "event_digest")),
        reached_at: String(Reflect.get(prior, "created_at")) };
      await this.sink.reached(replay);
      return replay;
    }
    const body = { barrier_id: barrierId, lane_id: laneId, request_id: requestId,
      tombstone_sequence: tombstoneSequence, reached_at: now.toISOString() };
    const eventDigest = `sha256:${createHash("sha256")
      .update("orca-jarvis/memory-lifecycle-barrier/v1\0")
      .update(canonicalize(body)).digest("hex")}`;
    const event = { ...body, event_digest: eventDigest };
    const id = `membarrier:v1:${eventDigest.slice(7)}`;
    this.authority.db.prepare(
      `INSERT OR IGNORE INTO memory_lifecycle_barrier_events(
        event_id,barrier_id,lane_id,request_id,tombstone_sequence,event_digest,created_at
       ) VALUES(?,?,?,?,?,?,?)`,
    ).run(id, barrierId, laneId, requestId, tombstoneSequence,
      eventDigest, now.toISOString());
    const stored = this.authority.db.prepare(
      `SELECT event_digest FROM memory_lifecycle_barrier_events
       WHERE barrier_id=? AND lane_id=? AND request_id=?`,
    ).get(barrierId, laneId, requestId);
    if (stored === null || typeof stored !== "object"
      || Reflect.get(stored, "event_digest") !== eventDigest) {
      throw new JarvisError("MEMORY_LIFECYCLE_BARRIER_REPLAY_CONFLICT");
    }
    await this.sink.reached(event);
    return event;
  }
}
