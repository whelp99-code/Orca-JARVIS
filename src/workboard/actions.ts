import type Database from "better-sqlite3";
import { canonicalize } from "../canonical.js";
import { controlValueDigest } from "../control-plane-contract.js";
import type { ActionJournal, Intent } from "./action-journal.js";
import { receiptSchema, requestSchema, type ActionBinding, type ActionCapability, type ActionOperation,
  type ActionRequest, type ActionResult, type PreparedAction, type WorkboardActionAdapter } from "./action-contracts.js";

export function actionBinding(request: ActionBinding): ActionBinding {
  const { sourceId, workId, taskId, sessionId, attemptId, purposeVersion, specVersion } = request;
  return { sourceId, workId, taskId, sessionId, attemptId, purposeVersion, specVersion };
}
const same = (a: unknown, b: unknown): boolean => canonicalize(a) === canonicalize(b);
const result = ({ intentId, status, receipt, error }: Intent): ActionResult => ({ intentId, status, receipt, error });

/** Local authenticated owner routes are the only mutation callers. Adapters are explicitly registered by work.
 * Reserve before send, never retry a reserved intent. Recovery only reads the original source receipt.
 */
export class WorkboardActions {
  constructor(readonly journal: ActionJournal, readonly adapters: ReadonlyMap<string, WorkboardActionAdapter>,
    readonly binding: (workId: string) => ActionBinding, readonly clock: () => Date) {}

  capability(workId: string): ActionCapability {
    const adapter = this.adapters.get(workId);
    const pending = this.journal.pending(workId);
    return { available: adapter !== undefined && pending === null,
      reason: pending ? "전달 결과 확인 중" : adapter ? "" : "검증된 구조화 처리 프로토콜이 연결되지 않았습니다",
      location: adapter?.location ?? "카드의 앱·작업공간·세션 근거에서 원천 요청을 여세요",
      effects: adapter?.effects ?? [], pending: pending ? result(pending) : null };
  }
  async prepare(workId: string): Promise<PreparedAction> {
    if (this.journal.pending(workId)) throw new Error("WORKBOARD_DELIVERY_UNCERTAIN");
    const adapter = this.adapter(workId);
    const request = await this.read(adapter, workId);
    this.assertCurrent(request);
    if (this.journal.find(request)) throw new Error("WORKBOARD_REQUEST_CONSUMED");
    return this.journal.prepare(request, adapter.requiresReceipt);
  }
  async submit(token: string, operation: ActionOperation, authorityReceipt?: unknown): Promise<ActionResult> {
    const { request } = this.journal.prepared(token);
    const prior = this.journal.find(request);
    if (prior) return this.replay(prior, request, operation);
    const adapter = this.adapter(request.workId);
    const current = await this.read(adapter, request.workId);
    if (!same(current, request)) throw new Error("WORKBOARD_REQUEST_CHANGED");
    this.assertCurrent(request); // Recheck local purpose/spec/session after the source round-trip, not before it.
    if (!request.effects.some(effect => effect.operation === operation)) throw new Error("WORKBOARD_ACTION_UNSUPPORTED");
    if (adapter.requiresReceipt && authorityReceipt === undefined) throw new Error("WORKBOARD_AUTHORITY_RECEIPT_REQUIRED");
    const reserved = this.journal.reserve(request, controlValueDigest(request), operation);
    if (!reserved.created) return this.replay(reserved.intent, request, operation);
    // SQLite FULL synchronous commit has completed. Even a crash before the next line is uncertain, never replayed.
    try {
      await adapter.send({ intentId: reserved.intent.intentId, request, requestDigest: reserved.intent.requestDigest, operation, authorityReceipt });
    } catch {
      this.journal.save({ ...reserved.intent, error: "WORKBOARD_SEND_UNCONFIRMED" });
    }
    return this.reconcile(reserved.intent.intentId);
  }
  async reconcile(intentId: string): Promise<ActionResult> {
    const intent = this.journal.get(intentId);
    if (intent.status === "settled") return result(intent);
    try {
      const adapter = this.adapter(intent.request.workId);
      if (adapter.sourceId !== intent.request.sourceId) throw new Error("WORKBOARD_SOURCE_CHANGED");
      const raw = await adapter.readReceipt(intent.intentId, intent.request);
      if (raw !== null) {
        const receipt = receiptSchema.parse(raw);
        if (receipt.intentId !== intent.intentId || receipt.requestId !== intent.request.requestId
          || receipt.requestDigest !== intent.requestDigest || receipt.operation !== intent.operation
          || !same(receipt.binding, actionBinding(intent.request))) throw new Error("WORKBOARD_RECEIPT_MISMATCH");
        const completion = receipt.completion;
        if (completion && (completion.taskId !== intent.request.taskId || completion.specVersion !== intent.request.specVersion
          || completion.attemptId !== intent.request.attemptId)) throw new Error("WORKBOARD_COMPLETION_MISMATCH");
        this.journal.save({ ...intent, status: "settled", receipt, error: null });
      }
    } catch {
      this.journal.save({ ...intent, error: "WORKBOARD_RECEIPT_UNCONFIRMED" });
    }
    return result(this.journal.get(intentId));
  }
  private replay(intent: Intent, request: ActionRequest, operation: ActionOperation): Promise<ActionResult> {
    if (!same(intent.request, request)) throw new Error(intent.request.sourceId === request.sourceId
      && intent.request.requestId === request.requestId ? "WORKBOARD_REQUEST_CHANGED" : "WORKBOARD_DELIVERY_UNCERTAIN");
    if (intent.operation !== operation) throw new Error("WORKBOARD_DECISION_CONFLICT");
    return this.reconcile(intent.intentId);
  }
  private adapter(workId: string): WorkboardActionAdapter {
    const adapter = this.adapters.get(workId);
    if (!adapter) throw new Error("WORKBOARD_ACTION_UNSUPPORTED");
    return adapter;
  }
  private async read(adapter: WorkboardActionAdapter, workId: string): Promise<ActionRequest> {
    const parsed = requestSchema.safeParse(await adapter.readRequest(workId));
    if (!parsed.success) throw new Error("WORKBOARD_STRUCTURED_REQUEST_REQUIRED");
    const request = parsed.data;
    if (request.sourceId !== adapter.sourceId || request.workId !== workId
      || request.payloadDigest !== controlValueDigest(request.payload)
      || !same(request.effects, adapter.effects)) throw new Error("WORKBOARD_SOURCE_CONTRACT_MISMATCH");
    return request;
  }
  private assertCurrent(request: ActionRequest): void {
    if (!same(actionBinding(request), this.binding(request.workId))) throw new Error("WORKBOARD_BINDING_CHANGED");
    const now = this.clock().getTime();
    if (!Number.isFinite(now) || Date.parse(request.expiresAt) <= now) throw new Error("WORKBOARD_REQUEST_EXPIRED");
  }
}

/** Read-only preflight over collector-owned rows. No migration, action digest rewrite, or implicit purpose confirmation. */
export function readActionBinding(db: Database.Database, workId: string, now: Date): ActionBinding {
  const row = db.prepare(`SELECT w.source_key,w.work_id,w.task_id,w.session_id,w.attempt_key,
      b.work_spec_revision,b.purpose_version,b.evidence_kind,s.last_successful_observation,s.warning,
      (SELECT MAX(version) FROM workboard_purposes WHERE project_id=b.project_id) AS latest_version
    FROM workboard_works w JOIN workboard_purpose_bindings b ON b.work_id=w.work_id
    JOIN workboard_sources s ON s.source_key=w.source_key WHERE w.work_id=?`).get(workId) as {
      source_key: string; work_id: string; task_id: string | null; session_id: string; attempt_key: string;
      work_spec_revision: string; purpose_version: number | null; latest_version: number | null; evidence_kind: string;
      last_successful_observation: string | null; warning: string | null;
    } | undefined;
  if (!row || row.purpose_version === null || row.purpose_version !== row.latest_version || row.evidence_kind === "agent_summary")
    throw new Error("WORKBOARD_BINDING_CHANGED");
  const observed = Date.parse(row.last_successful_observation ?? "");
  if (!Number.isFinite(observed) || row.warning !== null || now.getTime() - observed >= 180_000)
    throw new Error("WORKBOARD_OBSERVATION_STALE");
  return { sourceId: row.source_key, workId, taskId: row.task_id ?? workId, sessionId: row.session_id,
    attemptId: row.attempt_key, purposeVersion: row.purpose_version, specVersion: row.work_spec_revision };
}
