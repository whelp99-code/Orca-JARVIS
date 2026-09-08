import { createHash } from "node:crypto";
import type { AuthorityDb } from "./db.js";
import { canonicalize } from "./canonical.js";
import { parseDailyLoopClaim, parseDailyLoopInstant, parseDailyLoopRunId } from "./daily-loop-input.js";
import { claimDailyLoop } from "./daily-loop-claim.js";
import { DailyLoopReadStore } from "./daily-loop-read.js";
import { assertDailyLoopIntegrity } from "./daily-loop-integrity.js";
import { parseFailure, parseStoreCheckpoint, parseStoreCompleteStep, parseStorePrepare, parseUncertain, type ParsedPrepareRunInput }
  from "./daily-loop-store-input.js";
import { DailyLoopError, type DailyLoopClaim, type DailyLoopPhase, type DailyLoopStep } from "./daily-loop-types.js";
import { bindDailyLoopProjection } from "./memory-projection-bindings.js";
import { canonicalDailyLoopKey, legacyDailyLoopKey } from "./daily-loop-time.js";

type Row = Record<string, unknown>;
type CheckpointInput = {
  readonly claim: DailyLoopClaim; readonly step_id: string | null;
  readonly state: "running" | "verifying" | "completed" | "failed" | "uncertain"; readonly detail: unknown; readonly at: Date;
};

const digest = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
const identity = (prefix: string, key: string): string => `${prefix}:${digest(key).slice(7)}`;
const inputDigest = (json: string): string => `sha256:${createHash("sha256")
  .update("orca-jarvis/daily-loop-input/v1\0").update(json).digest("hex")}`;

export class DailyLoopStore {
  private readonly reads: DailyLoopReadStore;
  constructor(private readonly authority: AuthorityDb) {
    this.reads = new DailyLoopReadStore(authority);
  }
  private tx<Value>(runId: string, operation: () => Value): Value {
    return this.authority.db.transaction(() => {
      assertDailyLoopIntegrity(this.authority, runId); return operation();
    }).immediate();
  }
  private current(claim: DailyLoopClaim, at: Date, terminalAtExpiry = false): Row {
    const row = this.authority.db.prepare("SELECT * FROM daily_loop_runs WHERE run_id=?").get(claim.run_id) as Row | undefined;
    const lease = row === undefined ? Number.NaN : Date.parse(String(row["lease_expires_at"]));
    const deadline = row === undefined ? Number.NaN : Date.parse(String(row["expires_at"]));
    const validTime = terminalAtExpiry ? at.getTime() <= lease && at.getTime() <= deadline : at.getTime() < lease && at.getTime() < deadline;
    if (row === undefined || row["lease_owner"] !== claim.owner_id || Number(row["lease_fence"]) !== claim.fence || !validTime) {
      throw new DailyLoopError("DAILY_LOOP_STALE_LEASE");
    }
    return row;
  }
  prepare(value: unknown): string {
    const input = parseStorePrepare(value);
    return this.authority.db.transaction(() => this.prepareInput(input)).immediate();
  }
  private eventKey(input: ParsedPrepareRunInput): string {
    const { local_date: date, phase, event_id: event } = input.due;
    const key = canonicalDailyLoopKey(date, phase, event);
    if (phase !== "in_day") return key;
    if (!this.authority.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='daily_loop_event_identity_v2'").get()) {
      throw new DailyLoopError("DAILY_LOOP_IDENTITY_CONFLICT");
    }
    const legacy = legacyDailyLoopKey(date, phase, event);
    if (this.authority.db.prepare("SELECT 1 FROM daily_loop_runs WHERE idempotency_key=? AND record_version<>1").get(legacy)) {
      throw new DailyLoopError("DAILY_LOOP_IDENTITY_CONFLICT");
    }
    const prior = this.authority.db.prepare(`SELECT run_id,idempotency_key FROM daily_loop_runs
      WHERE record_version=1 AND phase='in_day' AND loop_date=? AND json_extract(input_json,'$.event_id')=?`).get(date, event) as
      { run_id: string; idempotency_key: string } | undefined;
    if (!prior) return key;
    if (![key, legacy].includes(prior.idempotency_key)
      || prior.run_id !== identity("dlr", prior.idempotency_key)) throw new DailyLoopError("DAILY_LOOP_IDENTITY_CONFLICT");
    return prior.idempotency_key;
  }
  private prepareInput(input: ParsedPrepareRunInput): string {
    const key = this.eventKey(input);
    const runId = identity("dlr", key); const correlation = `daily:${input.due.local_date}:${digest(key).slice(7, 23)}`;
    const createdAt = input.created_at.toISOString(); const notBefore = input.due.not_before ?? input.due.scheduled_at;
    const deadlineAt = input.deadline_at.toISOString();
    const inputJson = canonicalize({
      logical_key: key, local_date: input.due.local_date, phase: input.due.phase,
      scheduled_at: input.due.phase === "in_day" ? null : input.due.scheduled_at,
      occurred_at: input.due.phase === "in_day" ? input.due.occurred_at ?? input.due.scheduled_at : null,
      event_id: input.due.event_id ?? null, critical: input.due.critical ?? false,
      critical_reason: input.due.critical_reason ?? null, event_cost: input.due.event_cost ?? null,
      not_before: notBefore, created_at: createdAt, deadline_at: deadlineAt,
      steps: input.steps.map((step) => ({ key: step.key, sequence: step.sequence })),
    });
    const immutableDigest = inputDigest(inputJson);
    return this.tx(runId, () => {
      const selectIdentity = "SELECT loop_date,idempotency_key,phase,not_before,input_json,input_digest,created_at,expires_at " +
        "FROM daily_loop_runs WHERE run_id=?";
      const existing = this.authority.db.prepare(selectIdentity).get(runId) as Row | undefined;
      if (existing !== undefined && (
        existing["loop_date"] !== input.due.local_date || existing["idempotency_key"] !== key ||
        existing["phase"] !== input.due.phase || existing["not_before"] !== notBefore ||
        existing["input_json"] !== inputJson || existing["input_digest"] !== immutableDigest ||
        existing["created_at"] !== createdAt || existing["expires_at"] !== deadlineAt
      )) throw new DailyLoopError("DAILY_LOOP_IDENTITY_CONFLICT");
      this.authority.db.prepare(
        "INSERT INTO daily_loop_runs(run_id,loop_date,correlation_id,idempotency_key,state,lease_fence,expires_at,created_at,updated_at," +
        "record_version,phase,not_before,input_json,input_digest) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
      ).run(
        runId, input.due.local_date, correlation, key, "pending", 0, deadlineAt, createdAt, createdAt, 1,
        input.due.phase, notBefore, inputJson, immutableDigest,
      );
      const row = this.authority.db.prepare(selectIdentity).get(runId) as Row | undefined;
      if (row === undefined || row["loop_date"] !== input.due.local_date || row["idempotency_key"] !== key ||
        row["phase"] !== input.due.phase || row["not_before"] !== notBefore || row["input_json"] !== inputJson ||
        row["input_digest"] !== immutableDigest || row["created_at"] !== createdAt || row["expires_at"] !== deadlineAt) {
        throw new DailyLoopError("DAILY_LOOP_IDENTITY_CONFLICT");
      }
      for (const step of input.steps) {
        const stepId = identity("dls", `${key}\0${step.sequence}\0${step.key}`);
        this.authority.db.prepare(
          "INSERT INTO daily_loop_steps(step_id,run_id,sequence,step_key,state,created_at,updated_at,record_version,transition_fence) " +
          "VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,sequence) DO NOTHING",
        ).run(stepId, runId, step.sequence, step.key, "pending", createdAt, createdAt, 1, 0);
      }
      const stored = this.authority.db.prepare("SELECT sequence,step_key FROM daily_loop_steps WHERE run_id=? ORDER BY sequence")
        .all(runId) as Row[];
      if (stored.length !== input.steps.length || stored.some((storedRow, index) =>
        storedRow["sequence"] !== input.steps[index]?.sequence || storedRow["step_key"] !== input.steps[index]?.key)) {
        throw new DailyLoopError("DAILY_LOOP_IDENTITY_CONFLICT");
      }
      return runId;
    });
  }
  omit(runIdValue: unknown, codeValue: unknown, atValue: unknown): void {
    const runId = parseDailyLoopRunId(runIdValue); const code = parseFailure(codeValue); const at = parseDailyLoopInstant(atValue);
    if (code !== "MISSED_RECOVERY_WINDOW") throw new DailyLoopError("DAILY_LOOP_EVENT_INVALID");
    this.tx(runId, () => {
      const changed = this.authority.db.prepare(
        "UPDATE daily_loop_runs SET state='failed',failure_code=?,updated_at=? WHERE run_id=? AND state='pending'",
      ).run(code, at.toISOString(), runId);
      if (changed.changes === 0) {
        const row = this.authority.db.prepare("SELECT state,failure_code FROM daily_loop_runs WHERE run_id=?").get(runId) as Row | undefined;
        if (row === undefined) throw new DailyLoopError("DAILY_LOOP_TERMINAL");
      }
    });
  }
  claim(value: unknown, recoveryWindowMs?: number): DailyLoopClaim {
    return claimDailyLoop(this.authority, value, recoveryWindowMs);
  }
  due(atValue: unknown, phase?: DailyLoopPhase, date?: string): readonly string[] {
    return this.reads.due(atValue, phase, date);
  }
  steps(runIdValue: unknown): readonly DailyLoopStep[] {
    return this.reads.steps(runIdValue);
  }
  start(claimValue: unknown, atValue: unknown): void {
    const claim = parseDailyLoopClaim(claimValue); const at = parseDailyLoopInstant(atValue);
    this.tx(claim.run_id, () => {
      const row = this.current(claim, at);
      if (row["state"] !== "claimed") return;
      this.appendInside({ claim, step_id: null, state: "running", detail: "run_started", at });
      this.authority.db.prepare("UPDATE daily_loop_runs SET state='running',updated_at=? WHERE run_id=?").run(at.toISOString(), claim.run_id);
    });
  }
  appendCheckpoint(value: unknown): string { const input = parseStoreCheckpoint(value); return this.tx(input.claim.run_id, () => this.appendInside(input)); }
  private appendInside(input: CheckpointInput): string {
    this.current(input.claim, input.at, input.state === "failed" || input.state === "uncertain");
    const previous = this.authority.db.prepare(
      "SELECT sequence,checkpoint_digest FROM daily_loop_checkpoints WHERE run_id=? ORDER BY sequence DESC LIMIT 1",
    ).get(input.claim.run_id) as Row | undefined;
    const sequence = Number(previous?.["sequence"] ?? 0) + 1;
    const previousDigest = previous === undefined ? null : String(previous["checkpoint_digest"]); const detailJson = canonicalize(input.detail);
    const checkpointDigest = digest({
      run_id: input.claim.run_id, step_id: input.step_id, sequence, state: input.state,
      previous_digest: previousDigest, lease_fence: input.claim.fence, detail: JSON.parse(detailJson),
      created_at: input.at.toISOString(),
    });
    this.authority.db.prepare(
      "INSERT INTO daily_loop_checkpoints(checkpoint_id,run_id,step_id,sequence,state,previous_digest," +
      "checkpoint_digest,lease_fence,lease_expires_at,created_at,record_version,detail_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      identity("dlc", `${input.claim.run_id}\0${sequence}\0${checkpointDigest}`), input.claim.run_id, input.step_id,
      sequence, input.state, previousDigest, checkpointDigest, input.claim.fence, input.claim.lease_expires_at,
      input.at.toISOString(), 1, detailJson,
    );
    bindDailyLoopProjection(this.authority.db, input.claim.run_id,
      input.step_id, input.detail, input.at);
    return checkpointDigest;
  }
  completeStep(value: unknown): boolean {
    const input = parseStoreCompleteStep(value);
    return this.tx(input.claim.run_id, () => {
      this.current(input.claim, input.at);
      const row = this.authority.db.prepare("SELECT state FROM daily_loop_steps WHERE step_id=? AND run_id=?")
        .get(input.step.step_id, input.claim.run_id) as Row;
      if (row["state"] === "completed") return false;
      if (row["state"] !== "pending") this.authority.db.prepare(
        "UPDATE daily_loop_steps SET transition_fence=?,updated_at=? WHERE step_id=? AND transition_fence<?",
      ).run(input.claim.fence, input.at.toISOString(), input.step.step_id, input.claim.fence);
      const detailJson = canonicalize(input.detail); const evidence = digest(input.detail);
      this.authority.db.prepare(
        "UPDATE daily_loop_steps SET state='claimed',transition_fence=?,detail_json=?,evidence_digest=?,updated_at=? " +
        "WHERE step_id=? AND state='pending'",
      ).run(input.claim.fence, detailJson, evidence, input.at.toISOString(), input.step.step_id);
      for (const next of ["running", "verifying", "completed"] as const) {
        this.appendInside({ claim: input.claim, step_id: input.step.step_id, state: next, detail: input.detail, at: input.at });
        this.authority.db.prepare("UPDATE daily_loop_steps SET state=?,result_digest=?,updated_at=? WHERE step_id=?")
          .run(next, next === "completed" ? digest({ detail: input.detail, state: next }) : null,
            input.at.toISOString(), input.step.step_id);
      }
      return true;
    });
  }
  fail(claimValue: unknown, codeValue: unknown, atValue: unknown): void {
    this.terminate(parseDailyLoopClaim(claimValue), "failed", parseFailure(codeValue), parseDailyLoopInstant(atValue));
  }
  uncertain(claimValue: unknown, reasonValue: unknown, atValue: unknown): void {
    const claim = parseDailyLoopClaim(claimValue); const at = parseDailyLoopInstant(atValue);
    this.terminate(claim, "uncertain", parseUncertain(reasonValue), at);
  }
  private terminate(claim: DailyLoopClaim, state: "failed" | "uncertain", reason: string, at: Date): void {
    this.tx(claim.run_id, () => {
      this.current(claim, at, state === "failed");
      this.appendInside({ claim, step_id: null, state, detail: reason, at });
      this.authority.db.prepare(
        "UPDATE daily_loop_runs SET state=?,failure_code=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? " +
        "WHERE run_id=? AND lease_owner=? AND lease_fence=?",
      ).run(state, reason, at.toISOString(), claim.run_id, claim.owner_id, claim.fence);
    });
  }
  complete(claimValue: unknown, atValue: unknown): void {
    const claim = parseDailyLoopClaim(claimValue); const at = parseDailyLoopInstant(atValue);
    this.tx(claim.run_id, () => {
      const row = this.current(claim, at);
      if (row["state"] === "claimed") {
        this.appendInside({ claim, step_id: null, state: "running", detail: "run_started", at });
        this.authority.db.prepare("UPDATE daily_loop_runs SET state='running',updated_at=? WHERE run_id=?")
          .run(at.toISOString(), claim.run_id);
      }
      if (row["state"] !== "verifying") {
        this.appendInside({ claim, step_id: null, state: "verifying", detail: "run_verifying", at });
        this.authority.db.prepare("UPDATE daily_loop_runs SET state='verifying',updated_at=? WHERE run_id=?")
          .run(at.toISOString(), claim.run_id);
      } else if (this.authority.db.prepare("SELECT 1 FROM daily_loop_steps WHERE run_id=? AND state<>'completed' LIMIT 1").get(claim.run_id)) {
        throw new DailyLoopError("DAILY_LOOP_IDENTITY_CONFLICT");
      }
      const result = this.appendInside({ claim, step_id: null, state: "completed", detail: "run_completed", at });
      this.authority.db.prepare(
        "UPDATE daily_loop_runs SET state='completed',result_digest=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? " +
        "WHERE run_id=? AND lease_owner=? AND lease_fence=?",
      ).run(result, at.toISOString(), claim.run_id, claim.owner_id, claim.fence);
    });
  }
}
