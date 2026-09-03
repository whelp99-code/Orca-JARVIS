import { AuthorityDb, JarvisError } from "./db.js";
import { GjcCoordinatorClient } from "./gjc.js";
import { canonicalize } from "./canonical.js";

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
/** Small in-process supervisor. It is deliberately not a launchd/launchctl integration. */
export class GjcRuntimeService {
  constructor(
    private readonly db: AuthorityDb,
    private readonly client: GjcCoordinatorClient,
    private readonly worker = "gjc-runtime",
    private readonly supervisorCycle?: () => Promise<unknown>,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  status(): Record<string, unknown> {
    const config = this.db.gjcConfig();
    const rows = this.db.db.prepare("SELECT state,COUNT(*) AS count FROM gjc_intents GROUP BY state ORDER BY state").all() as Array<{
      state: string;
      count: number;
    }>;
    const runtime = this.db.db.prepare("SELECT pid,last_heartbeat_at,last_error_code FROM gjc_runtime_status WHERE id=1").get() ?? null;
    return {
      connected: Boolean(config?.operational),
      config,
      runtime,
      intents: Object.fromEntries(rows.map((row) => [row.state, Number(row.count)])),
    };
  }
  async once(now = new Date().toISOString()): Promise<{ connected?: boolean; processed: string | null; state: string | null }> {
    const config = this.db.gjcConfig();
    const runtimeFence = this.db.claimGjcRuntimeLease(this.worker, now);
    if (runtimeFence === null) return { processed: null, state: "leased" };
    this.db.recordGjcRuntimeStatus(null, now);
    if (this.supervisorCycle) await this.supervisorCycle();
    if (!config?.operational) return { connected: false, processed: null, state: "disconnected" };
    const next = this.db.db.prepare("SELECT intent_id FROM gjc_intents WHERE state='pending' ORDER BY created_at,intent_id LIMIT 1").get() as
      { intent_id: string } | undefined;
    if (!next) return { processed: null, state: null };
    const claimed = this.db.claimGjcIntent(next.intent_id, this.worker, now) as Intent | null;
    if (!claimed) return { processed: null, state: null };
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(claimed.payload_json) as Record<string, unknown>;
    } catch {
      this.db.settleGjcIntent(claimed.intent_id, claimed.lease_fence, { status: "failed", failure_code: "GJC_PAYLOAD_MALFORMED" }, now);
      return { processed: claimed.intent_id, state: "failed" };
    }
    try {
      const coordinatorCall = async (
        tool: string,
        arguments_: Record<string, unknown>,
        mutation = false,
        idempotencyKey?: string,
      ): Promise<Record<string, unknown>> => {
        this.db.heartbeatGjcRuntimeLease(this.worker, runtimeFence, this.clock().toISOString());
        const reply = await this.client.call(String(config.canonical_cwd), {
          tool,
          arguments: arguments_,
          mutation,
          allow_mutation: mutation,
          idempotency_key: idempotencyKey,
        });
        this.db.heartbeatGjcRuntimeLease(this.worker, runtimeFence, this.clock().toISOString());
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
      if (claimed.kind === "sync") {
        const turn = effectiveReply.turn_id;
        if (typeof turn !== "string" || !turn) {
          this.db.settleGjcIntent(
            claimed.intent_id,
            claimed.lease_fence,
            { status: "uncertain", receipt: effectiveReply, failure_code: "GJC_TURN_RECEIPT_INVALID" },
            now,
          );
          return { processed: claimed.intent_id, state: "uncertain" };
        }
        const questions = await coordinatorCall("gjc_coordinator_list_questions", { session_id: config.session_id, turn_id: turn });
        if (Array.isArray(questions.questions))
          for (const question of questions.questions) {
            if (question && typeof question === "object" && typeof (question as Record<string, unknown>).question_id === "string")
              this.db.bindGjcQuestion(claimed.intent_id, String((question as Record<string, unknown>).question_id), question, now);
          }
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
        effectiveReply = {
          status: question.status,
          session_id: question.session_id,
          turn_id: question.turn_id,
          question_id: question.question_id,
          raw: reply,
        };
      }
      const status = effectiveReply.status;
      if (status === "accepted" || status === "completed") {
        if (
          claimed.kind === "dispatch" &&
          (effectiveReply.session_id !== config.session_id || typeof effectiveReply.turn_id !== "string" || !effectiveReply.turn_id)
        ) {
          this.db.settleGjcIntent(
            claimed.intent_id,
            claimed.lease_fence,
            { status: "uncertain", receipt: effectiveReply, failure_code: "GJC_DISPATCH_RECEIPT_INVALID" },
            now,
          );
          return { processed: claimed.intent_id, state: "uncertain" };
        }
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
        this.db.settleGjcIntent(claimed.intent_id, claimed.lease_fence, { status, receipt: effectiveReply }, now);
        if (claimed.kind === "answer" && status === "completed")
          this.db.answerGjcQuestion(
            String(payload.question_id),
            { answer_binding: payload.answer_binding, answer: payload.answer },
            claimed.idempotency_key,
            effectiveReply,
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
            receipt: effectiveReply,
            failure_code: typeof effectiveReply.code === "string" ? effectiveReply.code : `GJC_${String(status).toUpperCase()}`,
          },
          now,
        );
        return { processed: claimed.intent_id, state: "failed" };
      }
      this.db.settleGjcIntent(
        claimed.intent_id,
        claimed.lease_fence,
        { status: "uncertain", receipt: effectiveReply, failure_code: "GJC_UNKNOWN_STATUS" },
        now,
      );
      return { processed: claimed.intent_id, state: "uncertain" };
    } catch (error) {
      const code = error instanceof JarvisError ? error.code : "GJC_RUNTIME_ERROR";
      this.db.recordGjcRuntimeStatus(code, now);
      if (code === "GJC_STALE_LEASE") throw error;
      this.db.settleGjcIntent(claimed.intent_id, claimed.lease_fence, { status: "uncertain", failure_code: code }, now);
      return { processed: claimed.intent_id, state: "uncertain" };
    }
  }
  async cycle(now = new Date().toISOString()): Promise<{ processed: string | null; state: string | null }> {
    return this.once(now);
  }
  async run(intervalMs = 10_000, stop: () => boolean = () => false): Promise<void> {
    if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new JarvisError("GJC_INTERVAL_INVALID");
    while (!stop()) {
      await this.cycle();
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
