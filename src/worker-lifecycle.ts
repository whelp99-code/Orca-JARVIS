import { JarvisError } from "./db.js";

export const WORKER_STATES = [
  "registered",
  "starting",
  "running",
  "waiting_input",
  "verifying",
  "completed",
  "failed",
  "cancelled",
  "lost",
] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

const TRANSITIONS: Record<WorkerState, readonly WorkerState[]> = {
  registered: ["starting"],
  starting: ["running", "failed", "lost"],
  running: ["waiting_input", "verifying", "cancelled", "lost", "failed"],
  waiting_input: ["running", "cancelled", "lost"],
  verifying: ["completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
  lost: [],
};

export type WorkerSignal = {
  readonly workerId: string;
  readonly sessionId: string;
  readonly generation: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly kind: "progress" | "completion" | "idle" | "cancel" | "forged";
};

export type WorkerRecord = {
  readonly workerId: string;
  readonly sessionId: string;
  readonly generation: string;
  readonly taskId: string;
  readonly state: WorkerState;
  readonly sequence: number;
  readonly completionEvidence?: string;
};

export class WorkerLifecycle {
  private readonly workers = new Map<string, WorkerRecord>();

  register(input: Omit<WorkerRecord, "state" | "sequence" | "completionEvidence">): WorkerRecord {
    const record: WorkerRecord = { ...input, state: "registered", sequence: 0 };
    this.workers.set(record.workerId, record);
    return record;
  }

  transition(workerId: string, next: WorkerState): WorkerRecord {
    const current = this.require(workerId);
    if (!TRANSITIONS[current.state].includes(next)) throw new JarvisError("WORKER_TRANSITION_ILLEGAL");
    const updated = { ...current, state: next };
    this.workers.set(workerId, updated);
    return updated;
  }

  signal(signal: WorkerSignal): WorkerRecord {
    const current = this.require(signal.workerId);
    if (signal.sessionId !== current.sessionId || signal.generation !== current.generation || signal.taskId !== current.taskId) {
      throw new JarvisError("WORKER_IDENTITY_FORGED");
    }
    if (signal.sequence <= current.sequence) throw new JarvisError("WORKER_SEQUENCE_DUPLICATE");
    if (signal.sequence > current.sequence + 1) throw new JarvisError("WORKER_SEQUENCE_GAP");
    if (signal.kind === "idle") {
      const updated = { ...current, sequence: signal.sequence };
      this.workers.set(signal.workerId, updated);
      return updated;
    }
    if (signal.kind === "cancel") return this.transition(signal.workerId, current.state === "verifying" ? "failed" : "cancelled");
    if (signal.kind === "completion") {
      if (current.state !== "verifying") throw new JarvisError("WORKER_COMPLETION_WITHOUT_VERIFIER");
      const updated = { ...this.transition(signal.workerId, "completed"), sequence: signal.sequence, completionEvidence: "pending-verifier" };
      this.workers.set(signal.workerId, updated);
      return updated;
    }
    const updated = { ...current, sequence: signal.sequence };
    this.workers.set(signal.workerId, updated);
    return updated;
  }

  settle(workerId: string, evidence: string): WorkerRecord {
    const current = this.require(workerId);
    if (current.state !== "completed" && current.state !== "verifying") throw new JarvisError("WORKER_SETTLE_INVALID");
    const updated: WorkerRecord = { ...current, state: "completed", completionEvidence: evidence };
    this.workers.set(workerId, updated);
    return updated;
  }

  get(workerId: string): WorkerRecord | undefined {
    return this.workers.get(workerId);
  }

  private require(workerId: string): WorkerRecord {
    const current = this.workers.get(workerId);
    if (!current) throw new JarvisError("WORKER_UNKNOWN");
    return current;
  }
}
