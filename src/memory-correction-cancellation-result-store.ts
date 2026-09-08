import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { cancellationDatabaseKeys, requireCancellationDatabaseBinding, requireCancellationRequestBinding,
  requireUnsentCancellationEvidence } from "./memory-correction-cancellation-db.js";
import { parseCorrectionCancellationSource, requireCorrectionCancellationIntent } from "./memory-correction-cancellation-intent.js";
import { requireCorrectionCancellationResult, type CorrectionCancellationResultV1 } from "./memory-correction-cancellation-result.js";
import { snapshotMemoryEffectValue } from "./second-brain-effect-v2-canonical.js";

const INVALID = "MEMORY_CANCELLATION_RESULT_BINDING_INVALID";
type ResultRow = { result_id: string; result_digest: string; provider_instance_id: string;
  provider_release_sha: string; signing_key_id: string; result_json: string; recorded_at: string };

export class MemoryCorrectionCancellationResultStore {
  constructor(private readonly authority: AuthorityDb, private readonly clock: () => Date) {}

  record(correctionId: string, value: unknown): CorrectionCancellationResultV1 {
    const snapshot = snapshotMemoryEffectValue(value);
    return this.authority.db.transaction(() => {
      const { intent, source } = this.binding(correctionId);
      const result = this.verify(snapshot, intent);
      const saved = this.row(correctionId);
      if (saved) {
        const prior = this.readSaved(saved, intent);
        if (canonicalize(prior) !== canonicalize(result)) throw new JarvisError("MEMORY_CANCELLATION_RESULT_REPLAY_CONFLICT");
        return prior;
      }
      const request = requireCancellationDatabaseBinding(this.authority, correctionId, source);
      if (requireUnsentCancellationEvidence(this.authority, request, this.clock()) !== intent.unsent_evidence.suppression_event_digest)
        throw new JarvisError(INVALID);
      const verified = this.verify(result, intent);
      this.authority.db.prepare(`INSERT INTO memory_correction_cancellation_results
        (correction_id,result_id,result_digest,provider_instance_id,provider_release_sha,signing_key_id,result_json,recorded_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(correctionId, verified.result_id, verified.result_digest, verified.provider_instance_id,
          verified.provider_release_sha, verified.signing_key_id, canonicalize(verified), this.clock().toISOString());
      return verified;
    }).immediate();
  }

  get(correctionId: string): CorrectionCancellationResultV1 | undefined {
    return this.authority.db.transaction(() => {
      const saved = this.row(correctionId);
      if (!saved) return undefined;
      return this.readSaved(saved, this.binding(correctionId).intent);
    }).deferred();
  }

  private row(correctionId: string): ResultRow | undefined {
    return this.authority.db.prepare("SELECT * FROM memory_correction_cancellation_results WHERE correction_id=?")
      .get(correctionId) as ResultRow | undefined;
  }

  private binding(correctionId: string) {
    const saved = this.authority.db.prepare(`SELECT i.*,s.source_json FROM memory_correction_cancellation_intents i
      JOIN memory_correction_cancellation_sources s ON s.correction_id=i.correction_id WHERE i.correction_id=?`)
      .get(correctionId) as { intent_json: string; source_json: string; intent_id: string; intent_digest: string;
        signing_key_id: string; nonce: string; created_at: string } | undefined;
    if (!saved) throw new JarvisError(INVALID);
    const source = parseCorrectionCancellationSource(JSON.parse(saved.source_json));
    const raw = JSON.parse(saved.intent_json);
    if (typeof raw.not_before !== "string") throw new JarvisError(INVALID);
    const intent = requireCorrectionCancellationIntent(raw, { now: new Date(raw.not_before),
      provider_instance_id: source.provider_instance_id,
      historical_delegation_keys: cancellationDatabaseKeys(this.authority, source.original_delegation.not_before, true),
      current_cancellation_keys: cancellationDatabaseKeys(this.authority, raw.not_before, true) });
    const request = requireCancellationRequestBinding(this.authority, correctionId, source);
    if (canonicalize(source) !== saved.source_json || canonicalize(intent) !== saved.intent_json
      || canonicalize(Object.fromEntries(Object.keys(source).map(key => [key, Reflect.get(intent, key)]))) !== saved.source_json
      || intent.intent_id !== saved.intent_id || intent.intent_digest !== saved.intent_digest
      || intent.signing_key_id !== saved.signing_key_id || intent.nonce !== saved.nonce || intent.issued_at !== saved.created_at
      || intent.unsent_evidence.candidate_id !== request.candidate_id) throw new JarvisError(INVALID);
    return { intent, source };
  }

  private verify(value: unknown, intent: ReturnType<typeof requireCorrectionCancellationIntent>) {
    const keys = this.authority.db.prepare(`SELECT key_id,provider_instance_id,provider_release_sha,public_key_pem,valid_from,valid_until
      FROM memory_provider_proof_keys WHERE state='active' AND algorithm='Ed25519' AND provider_instance_id=?`)
      .all(intent.provider_instance_id) as Array<{ key_id: string; provider_instance_id: string; provider_release_sha: string;
        public_key_pem: string; valid_from: string; valid_until: string }>;
    const result = requireCorrectionCancellationResult(value, intent,
      { now: this.clock(), provider_keys: new Map(keys.map(key => [key.key_id, key.public_key_pem])) });
    const key = keys.find(key => key.key_id === result.signing_key_id);
    if (!key || key.provider_release_sha !== result.provider_release_sha
      || !(Date.parse(key.valid_from) <= Date.parse(result.completed_at) && Date.parse(result.completed_at) < Date.parse(key.valid_until)))
      throw new JarvisError(INVALID);
    return result;
  }

  private readSaved(saved: ResultRow, intent: ReturnType<typeof requireCorrectionCancellationIntent>) {
    const result = this.verify(JSON.parse(saved.result_json), intent);
    if (canonicalize(result) !== saved.result_json || result.result_id !== saved.result_id || result.result_digest !== saved.result_digest
      || result.provider_instance_id !== saved.provider_instance_id || result.provider_release_sha !== saved.provider_release_sha
      || result.signing_key_id !== saved.signing_key_id || !Number.isFinite(Date.parse(saved.recorded_at))
      || Date.parse(saved.recorded_at) < Date.parse(result.completed_at) || Date.parse(saved.recorded_at) > this.clock().getTime())
      throw new JarvisError(INVALID);
    return result;
  }
}
