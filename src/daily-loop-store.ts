import { createHash } from "node:crypto";
import type { AuthorityDb } from "./db.js";
import { canonicalize } from "./canonical.js";
import { DAILY_LOOP_STORE_GUARDS_SQL } from "./daily-loop-store-guards.js";
import { DailyLoopError, type DailyLoopClaim, type DailyLoopDue, type DailyLoopFailureCode, type DailyLoopStep } from "./daily-loop-types.js";
import { canonicalDailyLoopKey } from "./daily-loop-time.js";

type Row = Record<string, unknown>;
type StepDefinition = { readonly key: string; readonly sequence: number };
type PrepareRunInput = {
  readonly due: DailyLoopDue;
  readonly created_at: Date;
  readonly deadline_at: Date;
  readonly steps: readonly StepDefinition[];
};
type ClaimInput = {
  readonly run_id: string;
  readonly owner_id: string;
  readonly at: Date;
  readonly lease_ms: number;
};
type CheckpointInput = {
  readonly claim: DailyLoopClaim;
  readonly step_id: string | null;
  readonly state: "running" | "verifying" | "completed" | "failed";
  readonly detail: unknown;
  readonly at: Date;
};
type CompleteStepInput = { readonly claim: DailyLoopClaim; readonly step: DailyLoopStep; readonly detail: unknown; readonly at: Date };

const digest = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
const identity = (prefix: string, key: string): string => `${prefix}:${digest(key).slice(7)}`;
const terminal = new Set(["completed", "failed", "uncertain"]);

export class DailyLoopStore {
  constructor(private readonly authority: AuthorityDb) {
    this.authority.db.exec(DAILY_LOOP_STORE_GUARDS_SQL);
  }
  private tx<Value>(operation: () => Value): Value {
    return this.authority.db.transaction(operation)();
  }
  private current(claim: DailyLoopClaim, at: Date): Row {
    const row = this.authority.db.prepare("SELECT * FROM daily_loop_runs WHERE run_id=?").get(claim.run_id) as Row | undefined;
    if (
      row === undefined ||
      row.lease_owner !== claim.owner_id ||
      Number(row.lease_fence) !== claim.fence ||
      Date.parse(String(row.lease_expires_at)) <= at.getTime() ||
      Date.parse(String(row.expires_at)) <= at.getTime()
    ) {
      throw new DailyLoopError("DAILY_LOOP_STALE_LEASE");
    }
    return row;
  }
  prepare(input: PrepareRunInput): string {
    const key = canonicalDailyLoopKey(input.due.local_date, input.due.phase, input.due.event_id);
    const runId = identity("dlr", key);
    const correlation = `daily:${input.due.local_date}:${digest(key).slice(7, 23)}`;
    const createdAt = input.created_at.toISOString();
    const deadlineAt = input.deadline_at.toISOString();
    return this.tx(() => {
      this.authority.db
        .prepare(
          "INSERT INTO daily_loop_runs(run_id,loop_date,correlation_id,idempotency_key,state,lease_fence," +
            "expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
        )
        .run(runId, input.due.local_date, correlation, key, "pending", 0, deadlineAt, createdAt, createdAt);
      const row = this.authority.db.prepare("SELECT loop_date,idempotency_key FROM daily_loop_runs WHERE run_id=?").get(runId) as Row | undefined;
      if (row === undefined || row.loop_date !== input.due.local_date || row.idempotency_key !== key) throw new DailyLoopError("DAILY_LOOP_IDENTITY_CONFLICT");
      for (const step of input.steps) {
        const stepId = identity("dls", `${key}\0${step.sequence}\0${step.key}`);
        this.authority.db
          .prepare(
            "INSERT INTO daily_loop_steps(step_id,run_id,sequence,step_key,state,created_at,updated_at) " +
              "VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,sequence) DO NOTHING",
          )
          .run(stepId, runId, step.sequence, step.key, "pending", createdAt, createdAt);
        const stored = this.authority.db.prepare("SELECT step_key FROM daily_loop_steps WHERE run_id=? AND sequence=?").get(runId, step.sequence) as Row;
        if (stored.step_key !== step.key) throw new DailyLoopError("DAILY_LOOP_IDENTITY_CONFLICT");
      }
      return runId;
    });
  }
  omit(runId: string, code: "MISSED_RECOVERY_WINDOW", at: Date): void {
    const changed = this.authority.db
      .prepare("UPDATE daily_loop_runs SET state='failed',failure_code=?,updated_at=? WHERE run_id=? AND state='pending'")
      .run(code, at.toISOString(), runId);
    if (changed.changes === 0) {
      const row = this.authority.db.prepare("SELECT state,failure_code FROM daily_loop_runs WHERE run_id=?").get(runId) as Row | undefined;
      if (row?.state !== "failed" || row.failure_code !== code) throw new DailyLoopError("DAILY_LOOP_TERMINAL");
    }
  }
  claim(input: ClaimInput): DailyLoopClaim {
    const at = input.at.toISOString();
    return this.tx(() => {
      const row = this.authority.db
        .prepare("SELECT state,lease_owner,lease_fence,lease_expires_at,expires_at FROM daily_loop_runs WHERE run_id=?")
        .get(input.run_id) as Row | undefined;
      if (row === undefined || terminal.has(String(row.state))) throw new DailyLoopError("DAILY_LOOP_TERMINAL");
      const deadline = Date.parse(String(row.expires_at));
      if (row.lease_owner !== null && Date.parse(String(row.lease_expires_at)) > input.at.getTime()) {
        throw new DailyLoopError("DAILY_LOOP_LEASE_ACTIVE");
      }
      const leaseExpires = new Date(Math.min(input.at.getTime() + input.lease_ms, deadline)).toISOString();
      if (Number(row.lease_fence) === 0) {
        this.authority.db
          .prepare(
            "UPDATE daily_loop_runs SET state='claimed',lease_owner=?,lease_fence=1,lease_expires_at=?,updated_at=? " +
              "WHERE run_id=? AND state='pending' AND lease_fence=0",
          )
          .run(input.owner_id, leaseExpires, at, input.run_id);
      } else {
        if (row.lease_owner === input.owner_id) throw new DailyLoopError("DAILY_LOOP_LEASE_ACTIVE");
        this.authority.db
          .prepare(
            "UPDATE daily_loop_runs SET lease_owner=?,lease_fence=lease_fence+1,lease_expires_at=?,updated_at=? " +
              "WHERE run_id=? AND lease_fence=?",
          )
          .run(input.owner_id, leaseExpires, at, input.run_id, Number(row.lease_fence));
      }
      const claimed = this.authority.db
        .prepare("SELECT lease_fence,lease_expires_at,expires_at FROM daily_loop_runs WHERE run_id=? AND lease_owner=?")
        .get(input.run_id, input.owner_id) as Row | undefined;
      if (claimed === undefined) throw new DailyLoopError("DAILY_LOOP_LEASE_ACTIVE");
      return {
        run_id: input.run_id,
        owner_id: input.owner_id,
        fence: Number(claimed.lease_fence),
        lease_expires_at: String(claimed.lease_expires_at),
        deadline_at: String(claimed.expires_at),
      };
    });
  }
  steps(runId: string): readonly DailyLoopStep[] {
    return (this.authority.db.prepare("SELECT step_id,sequence,step_key,state FROM daily_loop_steps WHERE run_id=? ORDER BY sequence").all(runId) as Row[]).map(
      (row) => ({
        step_id: String(row.step_id),
        sequence: Number(row.sequence),
        step_key: String(row.step_key),
        state: String(row.state) as DailyLoopStep["state"],
      }),
    );
  }
  start(claim: DailyLoopClaim, at: Date): void {
    this.tx(() => {
      const row = this.current(claim, at);
      if (row.state !== "claimed") return;
      this.authority.db.prepare("UPDATE daily_loop_runs SET state='running',updated_at=? WHERE run_id=?").run(at.toISOString(), claim.run_id);
      this.appendInside({ claim, step_id: null, state: "running", detail: "run_started", at });
    });
  }
  appendCheckpoint(input: CheckpointInput): string {
    return this.tx(() => this.appendInside(input));
  }
  private appendInside(input: CheckpointInput): string {
    this.current(input.claim, input.at);
    const previous = this.authority.db
      .prepare("SELECT sequence,checkpoint_digest FROM daily_loop_checkpoints WHERE run_id=? ORDER BY sequence DESC LIMIT 1")
      .get(input.claim.run_id) as Row | undefined;
    const sequence = Number(previous?.sequence ?? 0) + 1;
    const previousDigest = previous === undefined ? null : String(previous.checkpoint_digest);
    const checkpointDigest = digest({
      run_id: input.claim.run_id,
      step_id: input.step_id,
      sequence,
      state: input.state,
      previous_digest: previousDigest,
      lease_fence: input.claim.fence,
      detail: input.detail,
      created_at: input.at.toISOString(),
    });
    this.authority.db
      .prepare(
        "INSERT INTO daily_loop_checkpoints(checkpoint_id,run_id,step_id,sequence,state,previous_digest," +
          "checkpoint_digest,lease_fence,lease_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        identity("dlc", `${input.claim.run_id}\0${sequence}\0${checkpointDigest}`),
        input.claim.run_id,
        input.step_id,
        sequence,
        input.state,
        previousDigest,
        checkpointDigest,
        input.claim.fence,
        input.claim.lease_expires_at,
        input.at.toISOString(),
      );
    return checkpointDigest;
  }
  completeStep(input: CompleteStepInput): boolean {
    return this.tx(() => {
      this.current(input.claim, input.at);
      const state = String(
        (this.authority.db.prepare("SELECT state FROM daily_loop_steps WHERE step_id=? AND run_id=?")
          .get(input.step.step_id, input.claim.run_id) as Row).state,
      );
      if (state === "completed") return false;
      for (const next of ["claimed", "running", "verifying", "completed"] as const) {
        this.authority.db
          .prepare("UPDATE daily_loop_steps SET state=?,evidence_digest=?,result_digest=?,updated_at=? WHERE step_id=?")
          .run(
            next, digest(input.detail), next === "completed" ? digest({ detail: input.detail, state: next }) : null,
            input.at.toISOString(), input.step.step_id,
          );
        if (next !== "claimed") {
          this.appendInside({ claim: input.claim, step_id: input.step.step_id, state: next, detail: input.detail, at: input.at });
        }
      }
      return true;
    });
  }
  fail(claim: DailyLoopClaim, code: DailyLoopFailureCode, at: Date): void {
    this.tx(() => {
      this.current(claim, at);
      this.appendInside({ claim, step_id: null, state: "failed", detail: code, at });
      this.authority.db
        .prepare(
          "UPDATE daily_loop_runs SET state='failed',failure_code=?,lease_owner=NULL,lease_expires_at=NULL," +
            "updated_at=? WHERE run_id=? AND lease_owner=? AND lease_fence=?",
        )
        .run(code, at.toISOString(), claim.run_id, claim.owner_id, claim.fence);
    });
  }
  complete(claim: DailyLoopClaim, at: Date): void {
    this.tx(() => {
      const row = this.current(claim, at);
      if (row.state === "claimed")
        this.authority.db.prepare("UPDATE daily_loop_runs SET state='running',updated_at=? WHERE run_id=?").run(at.toISOString(), claim.run_id);
      this.authority.db.prepare("UPDATE daily_loop_runs SET state='verifying',updated_at=? WHERE run_id=?").run(at.toISOString(), claim.run_id);
      const result = this.appendInside({ claim, step_id: null, state: "verifying", detail: "run_verifying", at });
      this.appendInside({ claim, step_id: null, state: "completed", detail: result, at });
      this.authority.db
        .prepare(
          "UPDATE daily_loop_runs SET state='completed',result_digest=?,lease_owner=NULL,lease_expires_at=NULL," +
            "updated_at=? WHERE run_id=? AND lease_owner=? AND lease_fence=?",
        )
        .run(result, at.toISOString(), claim.run_id, claim.owner_id, claim.fence);
    });
  }
}
