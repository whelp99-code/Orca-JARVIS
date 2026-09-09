import { performance } from "node:perf_hooks";
import {
  readServiceHealth, requireNoFatalObservations, recordRuntimeHeartbeat,
  recordCoordinatorAttempt, recordCoordinatorOutcome, withRuntimeHealthFence,
} from "./runtime-health.js";
import { AuthorityDb, JarvisError } from "./db.js";
import { GjcCoordinatorClient } from "./gjc.js";
import { canonicalize } from "./canonical.js";
import { GjcRuntimeLease } from "./gjc-runtime-lease.js";
import { captureDaemonRuntimeIdentity, publishDaemonRuntimeIdentity, type DaemonRuntimeSnapshot } from "./daemon-runtime-identity.js";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
function coordinatorTurn(reply: Record<string, unknown>, sessionId: unknown, turnId?: unknown): Record<string, unknown> | null {
  const turn = record(reply.turn);
  if (
    reply.ok !== true ||
    !turn ||
    typeof turn.turn_id !== "string" ||
    !turn.turn_id ||
    typeof turn.session_id !== "string" ||
    turn.session_id !== sessionId ||
    typeof turn.status !== "string" ||
    (turnId !== undefined && turn.turn_id !== turnId)
  )
    return null;
  return { status: turn.status, turn_id: turn.turn_id, session_id: turn.session_id, raw: reply };
}

type Intent = { intent_id: string; kind: "sync" | "dispatch" | "answer"; payload_json: string; idempotency_key: string; lease_fence: number };
export class GjcRuntimeService {
  private readonly lease: GjcRuntimeLease;
  private identity: DaemonRuntimeSnapshot | undefined;
  constructor(
    private readonly db: AuthorityDb,
    private readonly client: GjcCoordinatorClient,
    worker = "gjc-runtime",
    private readonly supervisorCycle?: () => Promise<unknown>,
    private readonly clock: () => Date = () => new Date(),
    private readonly captureIdentity: () => DaemonRuntimeSnapshot = captureDaemonRuntimeIdentity,
  ) { this.lease = new GjcRuntimeLease(db, worker); }
  status(): Record<string, unknown> { return readServiceHealth(this.db, this.clock()); }
  async once(now = this.clock().toISOString()): Promise<{ connected?: boolean; processed: string | null; state: string | null }> {
    const cycleStarted = performance.now();
    return this.lease.run(now, async (owner, fence) => {
      const result = await this.processOnce(now, owner, fence, cycleStarted);
      if (result.processed !== null && result.state !== null) {
        const finished = this.clock().toISOString();
        withRuntimeHealthFence(this.db, owner, fence, finished,
          () => recordCoordinatorOutcome(this.db, result.processed!, result.state!, finished));
      }
      return result;
    });
  }
  close(): void { this.lease.release(this.clock().toISOString()); }
  private async processOnce(now: string, owner: string, runtimeFence: number, cycleStarted: number) {
    const config = this.db.gjcConfig();
    this.db.recoverExpiredGjcIntents(now);
    const identity = this.identity ?? this.captureIdentity();
    // Account for synchronous file hashing without replacing an explicit cycle clock.
    const heartbeatAt = new Date(Date.parse(now) + Math.floor(performance.now() - cycleStarted)).toISOString();
    withRuntimeHealthFence(this.db, owner, runtimeFence, heartbeatAt, () => {
      publishDaemonRuntimeIdentity(this.db.db, identity, owner, runtimeFence, heartbeatAt);
      recordRuntimeHeartbeat(this.db, heartbeatAt);
    });
    this.identity ??= identity;
    if (this.supervisorCycle) await this.supervisorCycle();
    if (!config?.operational) return { connected: false, processed: null, state: "disconnected" };
    requireNoFatalObservations(this.db, this.clock());
    const next = this.db.db.prepare("SELECT intent_id FROM gjc_intents WHERE state='pending' ORDER BY created_at,intent_id LIMIT 1").get() as
      { intent_id: string } | undefined;
    if (!next) return { processed: null, state: null };
    const claimed = this.db.claimGjcIntent(next.intent_id, owner, now) as Intent | null;
    if (!claimed) return { processed: null, state: null };
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(claimed.payload_json) as Record<string, unknown>;
    } catch {
      this.db.settleGjcIntent(claimed.intent_id, claimed.lease_fence, { status: "failed", failure_code: "GJC_PAYLOAD_MALFORMED" }, now);
      return { processed: claimed.intent_id, state: "failed" };
    }
    let coordinatorInvoked = false;
    try {
      const coordinatorCall = async (
        tool: string,
        arguments_: Record<string, unknown>,
        mutation = false,
        idempotencyKey?: string,
      ): Promise<Record<string, unknown>> => {
        now = this.clock().toISOString();
        this.db.requireGjcIntentLease(claimed.intent_id, claimed.lease_fence, now);
        this.db.heartbeatGjcRuntimeLease(owner, runtimeFence, now);
        const outgoing = claimed.kind === "dispatch"
          ? this.db.gjcDispatchArguments(claimed.intent_id, claimed.lease_fence, config, now) : arguments_;
        withRuntimeHealthFence(this.db, owner, runtimeFence, now, () => recordCoordinatorAttempt(this.db, now));
        coordinatorInvoked = true;
        const reply = await this.client.call(String(config.canonical_cwd), {
          tool,
          arguments: outgoing,
          mutation,
          allow_mutation: mutation,
          idempotency_key: idempotencyKey,
        });
        now = this.clock().toISOString();
        this.db.requireGjcIntentLease(claimed.intent_id, claimed.lease_fence, now);
        this.db.heartbeatGjcRuntimeLease(owner, runtimeFence, now);
        return reply;
      };
      const tool =
        claimed.kind === "dispatch"
          ? "gjc_coordinator_send_prompt"
          : claimed.kind === "answer"
            ? "gjc_coordinator_submit_question_answer"
            : "gjc_coordinator_read_turn";
      const reply = await coordinatorCall(tool, payload, claimed.kind !== "sync", claimed.idempotency_key);
      let effectiveReply =
        claimed.kind === "answer" ? reply : coordinatorTurn(reply, config.session_id, claimed.kind === "sync" ? payload.turn_id : undefined);
      if (!effectiveReply) {
        this.db.settleGjcIntent(
          claimed.intent_id,
          claimed.lease_fence,
          { status: "uncertain", receipt: reply, failure_code: "GJC_RESPONSE_SCHEMA_INVALID" },
          now,
        );
        return { processed: claimed.intent_id, state: "uncertain" };
      }
      // Only structured coordinator states cause the bounded await transition;
      // arbitrary terminal prose cannot trigger a resend or completion.
      if (
        claimed.kind === "sync" &&
        new Set(["queued", "delivering", "active", "waiting_for_answer", "completing", "pending", "running"]).has(String(effectiveReply.status))
      ) {
        const awaited = await coordinatorCall("gjc_coordinator_await_turn", { session_id: payload.session_id, turn_id: payload.turn_id });
        effectiveReply = coordinatorTurn(awaited, config.session_id, payload.turn_id);
        if (!effectiveReply) {
          this.db.settleGjcIntent(
            claimed.intent_id,
            claimed.lease_fence,
            { status: "uncertain", receipt: awaited, failure_code: "GJC_RESPONSE_SCHEMA_INVALID" },
            now,
          );
          return { processed: claimed.intent_id, state: "uncertain" };
        }
      }
      const questions = claimed.kind === "sync"
        ? await coordinatorCall("gjc_coordinator_list_questions", { session_id: config.session_id, turn_id: effectiveReply.turn_id })
        : null;
      let settledReply = effectiveReply;
      return this.db.db.transaction(() => {
        now = this.clock().toISOString();
        this.db.requireGjcIntentLease(claimed.intent_id, claimed.lease_fence, now);
        if (Array.isArray(questions?.questions))
          for (const question of questions.questions) {
            if (question && typeof question === "object" && typeof (question as Record<string, unknown>).question_id === "string")
              this.db.bindGjcQuestion(claimed.intent_id, String((question as Record<string, unknown>).question_id), question, now);
          }
        // Status prose is never authority: only this enumerated structured set is actionable.
        if (claimed.kind === "answer") {
          const question = record(reply.question);
          const turn = record(reply.turn);
          if (
            reply.ok !== true ||
            !question ||
            !turn ||
            question.question_id !== payload.question_id ||
            question.session_id !== payload.session_id ||
            question.turn_id !== payload.turn_id ||
            turn.session_id !== payload.session_id ||
            turn.turn_id !== payload.turn_id ||
            canonicalize(question.answer) !== canonicalize(payload.answer)
          ) {
            this.db.settleGjcIntent(
              claimed.intent_id,
              claimed.lease_fence,
              { status: "uncertain", receipt: reply, failure_code: "GJC_ANSWER_RECEIPT_INVALID" },
              now,
            );
            return { processed: claimed.intent_id, state: "uncertain" };
          }
          settledReply = {
            status: question.status,
            session_id: question.session_id,
            turn_id: question.turn_id,
            question_id: question.question_id,
            raw: reply,
          };
        }
        const status = settledReply.status;
        if (status === "accepted" || status === "completed") {
          if (claimed.kind === "answer" && status === "completed") {
            const binding = payload.answer_binding;
            const questionId = payload.question_id;
            if (typeof questionId !== "string" || !binding || typeof binding !== "object") throw new JarvisError("GJC_ANSWER_SCHEMA_INVALID");
            this.db.db
              .prepare(
                "INSERT INTO gjc_answer_receipts(intent_id,session_id,turn_id,question_id,answer_binding_json,receipt_json,completed_at) VALUES(?,?,?,?,?,?,?)",
              )
              .run(claimed.intent_id, payload.session_id, payload.turn_id, questionId, canonicalize(binding), canonicalize(reply), now);
          }
          this.db.settleGjcIntent(claimed.intent_id, claimed.lease_fence, { status, receipt: settledReply }, now);
          if (claimed.kind === "answer" && status === "completed")
            this.db.answerGjcQuestion(
              String(payload.question_id),
              { answer_binding: payload.answer_binding, answer: payload.answer },
              claimed.idempotency_key,
              settledReply,
              now,
            );
          return { processed: claimed.intent_id, state: status };
        }
        if (status === "failed" || status === "cancelled" || status === "superseded") {
          this.db.settleGjcIntent(
            claimed.intent_id,
            claimed.lease_fence,
            {
              status: "failed",
              receipt: settledReply,
              failure_code: typeof settledReply.code === "string" ? settledReply.code : `GJC_${String(status).toUpperCase()}`,
            },
            now,
          );
          return { processed: claimed.intent_id, state: "failed" };
        }
        this.db.settleGjcIntent(
          claimed.intent_id,
          claimed.lease_fence,
          { status: "uncertain", receipt: settledReply, failure_code: "GJC_UNKNOWN_STATUS" },
          now,
        );
        return { processed: claimed.intent_id, state: "uncertain" };
      }).immediate();
    } catch (error) {
      now = this.clock().toISOString();
      const code = error instanceof JarvisError ? error.code : "GJC_RUNTIME_ERROR";
      if (code === "GJC_STALE_LEASE") throw error;
      withRuntimeHealthFence(this.db, owner, runtimeFence, now, () => this.db.recordGjcRuntimeStatus(code, now));
      const state = claimed.kind === "dispatch" && !coordinatorInvoked ? "failed" : "uncertain";
      this.db.settleGjcIntent(claimed.intent_id, claimed.lease_fence, { status: state, failure_code: code }, now);
      return { processed: claimed.intent_id, state };
    }
  }
  async cycle(now = this.clock().toISOString()): Promise<{ processed: string | null; state: string | null }> {
    return this.once(now);
  }
  async run(intervalMs = 10_000, stop: () => boolean = () => false, cycle: () => Promise<unknown> = () => this.cycle()): Promise<void> {
    if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new JarvisError("GJC_INTERVAL_INVALID");
    while (!stop()) {
      await cycle();
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
