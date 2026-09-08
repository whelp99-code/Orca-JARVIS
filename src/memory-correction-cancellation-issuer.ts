import { createPublicKey, randomUUID, type KeyObject } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { cancellationDatabaseKeys, requireCancellationDatabaseBinding, requireUnsentCancellationEvidence } from "./memory-correction-cancellation-db.js";
import { createCorrectionCancellationFromSource, parseCorrectionCancellationSource,
  requireCorrectionCancellationIntent, type CorrectionCancellationIntentV1 } from "./memory-correction-cancellation-intent.js";

export class MemoryCorrectionCancellationIssuer {
  constructor(private readonly authority: AuthorityDb, private readonly clock: () => Date) {}

  /** Commit intent and permanent dispatch exclusion together. No transport call or cursor advance. */
  issue(correctionId: string, signingKeyId: string, privateKey: KeyObject): CorrectionCancellationIntentV1 {
    return this.authority.db.transaction(() => {
      const now = this.clock(); const at = now.toISOString();
      const stored = this.authority.db.prepare("SELECT source_json FROM memory_correction_cancellation_sources WHERE correction_id=?")
        .get(correctionId) as { source_json: string } | undefined;
      if (!stored) throw new JarvisError("MEMORY_CANCELLATION_SOURCE_MISSING");
      const source = parseCorrectionCancellationSource(JSON.parse(stored.source_json));
      if (canonicalize(source) !== stored.source_json) throw new JarvisError("MEMORY_CANCELLATION_DB_BINDING_INVALID");
      const row = requireCancellationDatabaseBinding(this.authority, correctionId, source);
      const suppression = requireUnsentCancellationEvidence(this.authority, row, now);
      const current = cancellationDatabaseKeys(this.authority, at);
      const selected = current.get(signingKeyId);
      if (!selected || privateKey.type !== "private" || !createPublicKey(privateKey).export({ type: "spki", format: "der" })
        .equals(createPublicKey(selected).export({ type: "spki", format: "der" }))) throw new JarvisError("MEMORY_CANCELLATION_KEY_UNAVAILABLE");
      const options = { provider_instance_id: source.provider_instance_id, now,
        historical_delegation_keys: cancellationDatabaseKeys(this.authority, source.original_delegation.not_before, true),
        current_cancellation_keys: current };
      const revalidate = (intent: CorrectionCancellationIntentV1) => {
        const finalNow = this.clock();
        requireCorrectionCancellationIntent(intent, { ...options, now: finalNow,
          current_cancellation_keys: cancellationDatabaseKeys(this.authority, finalNow.toISOString()) });
        const currentSuppression = requireUnsentCancellationEvidence(this.authority,
          requireCancellationDatabaseBinding(this.authority, correctionId, source), finalNow);
        if (intent.unsent_evidence.candidate_id !== row.candidate_id || currentSuppression !== intent.unsent_evidence.suppression_event_digest
          || canonicalize(Object.fromEntries(Object.keys(source).map(key => [key, Reflect.get(intent, key)]))) !== stored.source_json) {
          throw new JarvisError("MEMORY_CANCELLATION_DB_BINDING_INVALID");
        }
      };
      const prior = this.authority.db.prepare("SELECT * FROM memory_correction_cancellation_intents WHERE correction_id=?")
        .get(correctionId) as { intent_json: string; intent_id: string; intent_digest: string;
          signing_key_id: string; nonce: string; created_at: string } | undefined;
      if (prior) {
        const intent = requireCorrectionCancellationIntent(JSON.parse(prior.intent_json), options);
        if (canonicalize(intent) !== prior.intent_json || intent.unsent_evidence.suppression_event_digest !== suppression
          || intent.intent_id !== prior.intent_id || intent.intent_digest !== prior.intent_digest
          || intent.signing_key_id !== prior.signing_key_id || intent.nonce !== prior.nonce
          || intent.issued_at !== prior.created_at) throw new JarvisError("MEMORY_CANCELLATION_DB_BINDING_INVALID");
        revalidate(intent);
        return intent;
      }
      const key = this.authority.db.prepare("SELECT valid_until FROM memory_effect_delegation_keys WHERE key_id=?")
        .get(signingKeyId) as { valid_until: string };
      const expiresAt = new Date(Math.min(now.getTime() + 300_000, Date.parse(key.valid_until))).toISOString();
      const intent = createCorrectionCancellationFromSource(source, { candidate_id: row.candidate_id,
        suppression_event_digest: suppression, dispatch_fence: 0, attempt_count: 0, active_cursor: false },
      { issued_at: at, expires_at: expiresAt, nonce: randomUUID(), signing_key_id: signingKeyId }, privateKey, options);
      revalidate(intent);
      this.authority.db.prepare(`INSERT INTO memory_correction_cancellation_intents
        (correction_id,intent_id,intent_digest,signing_key_id,nonce,intent_json,created_at) VALUES(?,?,?,?,?,?,?)`)
        .run(correctionId, intent.intent_id, intent.intent_digest, intent.signing_key_id, intent.nonce, canonicalize(intent), at);
      return intent;
    }).immediate();
  }
}
