import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { cancellationDatabaseKeys, requireCancellationRequestBinding, requireUnsentCancellationEvidence } from "./memory-correction-cancellation-db.js";
import { parseCorrectionCancellationSource, requireCorrectionCancellationIntent } from "./memory-correction-cancellation-intent.js";
import { parseCorrectionSpool } from "./memory-correction-dispatch.js";
import { MemoryEffectSpool } from "./memory-effect-spool.js";
import { persistForbiddenContentIdentities, loadForbiddenContentIdentities } from "./memory-forbidden-content.js";
import { memoryEffectDigest } from "./second-brain-effect-v2.js";

const INVALID = "MEMORY_CANCELLATION_MATERIAL_UNPROVED";
const sha = (value: Buffer | string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
type Checkpoint = { correction_id: string; purge_id: string; spool_digest: string; payload_digest: string;
  content_digest: string; content_bytes: number; identities_json: string; identity_manifest_digest: string; created_at: string };

function binding(authority: AuthorityDb, correctionId: string) {
  const saved = authority.db.prepare(`SELECT i.intent_json,i.intent_id,i.intent_digest,s.source_json
    FROM memory_correction_cancellation_intents i JOIN memory_correction_cancellation_sources s
      ON i.correction_id=s.correction_id WHERE i.correction_id=?`).get(correctionId) as
    { intent_json: string; intent_id: string; intent_digest: string; source_json: string } | undefined;
  if (!saved) throw new JarvisError(INVALID);
  const source = parseCorrectionCancellationSource(JSON.parse(saved.source_json));
  const raw = JSON.parse(saved.intent_json);
  const intent = requireCorrectionCancellationIntent(raw, { provider_instance_id: source.provider_instance_id,
    now: new Date(raw.not_before), historical_delegation_keys: cancellationDatabaseKeys(authority, source.original_delegation.not_before, true),
    current_cancellation_keys: cancellationDatabaseKeys(authority, raw.not_before, true) });
  if (canonicalize(source) !== saved.source_json || canonicalize(intent) !== saved.intent_json
    || intent.intent_id !== saved.intent_id || intent.intent_digest !== saved.intent_digest
    || canonicalize(Object.fromEntries(Object.keys(source).map(key => [key, Reflect.get(intent, key)]))) !== saved.source_json)
    throw new JarvisError(INVALID);
  const request = requireCancellationRequestBinding(authority, correctionId, source);
  if (request.candidate_id !== intent.unsent_evidence.candidate_id) throw new JarvisError(INVALID);
  return { request, source, intent };
}

function checkpoint(authority: AuthorityDb, correctionId: string): Checkpoint | undefined {
  const saved = authority.db.prepare("SELECT * FROM memory_cancellation_material_checkpoints WHERE correction_id=?")
    .get(correctionId) as Checkpoint | undefined;
  if (!saved) return undefined;
  const { request } = binding(authority, correctionId);
  const identities: unknown = JSON.parse(saved.identities_json);
  const ids = Array.isArray(identities) ? identities.map(value => value?.identity_digest) : [];
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === "string")
    || canonicalize(identities) !== saved.identities_json || sha(saved.identities_json) !== saved.identity_manifest_digest
    || saved.spool_digest !== request.spool_digest || saved.payload_digest !== request.payload_digest) throw new JarvisError(INVALID);
  const rows = authority.db.prepare(`SELECT identity_digest,content_digest,content_bytes FROM memory_forbidden_content_identities
    WHERE purge_id=?`).all(saved.purge_id) as Array<{ identity_digest: string; content_digest: string; content_bytes: number }>;
  if (ids.some(id => !rows.some(row => row.identity_digest === id))
    || !rows.some(row => ids.includes(row.identity_digest) && row.content_digest === saved.content_digest && row.content_bytes === saved.content_bytes))
    throw new JarvisError(INVALID);
  const current = loadForbiddenContentIdentities(authority).filter(row => ids.includes(row.identity_digest));
  const unique = [...new Map(current.map(row => [row.identity_digest, row])).values()]
    .sort((a, b) => a.identity_digest.localeCompare(b.identity_digest));
  if (canonicalize(unique) !== saved.identities_json) throw new JarvisError(INVALID);
  return saved;
}

/** Capture before physical removal; returned buffers must be zeroed by the caller. */
export async function collectCancellationMaterial(authority: AuthorityDb, spoolRoot: string,
  purgeId: string, now: Date): Promise<Buffer[]> {
  const material: Buffer[] = [];
  try {
    const rows = authority.db.prepare("SELECT correction_id FROM memory_correction_cancellation_intents ORDER BY correction_id")
      .all() as Array<{ correction_id: string }>;
    const spool = new MemoryEffectSpool(spoolRoot, authority);
    for (const { correction_id: id } of rows) {
      const prior = checkpoint(authority, id);
      const before = binding(authority, id);
      if (!before.request.spool_locator) { if (prior) continue; throw new JarvisError(INVALID); }
      let raw: unknown;
      try { raw = await spool.read(before.request.spool_locator, before.request.spool_digest); }
      catch (error) {
        if (prior && error instanceof Error && "code" in error && error.code === "ENOENT") { checkpoint(authority, id); continue; }
        throw error;
      }
      const staged = parseCorrectionSpool(raw);
      const payload = { content: staged.content, content_digest: memoryEffectDigest("effect_content", { content: staged.content }),
        content_bytes: Buffer.byteLength(staged.content), disposition: "superseded" };
      if (staged.lane_id !== before.request.lane_id || staged.candidate_id !== before.request.candidate_id
        || staged.provider_instance_id !== before.source.provider_instance_id
        || canonicalize(staged.targets) !== canonicalize([before.source.target]) || canonicalize(staged.scope) !== canonicalize(before.source.scope)
        || memoryEffectDigest("effect_payload", payload) !== before.request.payload_digest || payload.content_bytes === 0) throw new JarvisError(INVALID);
      const bytes = Buffer.from(staged.content);
      material.push(bytes);
      authority.db.transaction(() => {
        const after = binding(authority, id);
        if (canonicalize(after) !== canonicalize(before)) throw new JarvisError(INVALID);
        const captured = checkpoint(authority, id);
        if (captured) {
          if (sha(bytes) !== captured.content_digest || bytes.length !== captured.content_bytes) throw new JarvisError(INVALID);
          checkpoint(authority, id);
          return;
        }
        if (requireUnsentCancellationEvidence(authority, after.request, now) !== after.intent.unsent_evidence.suppression_event_digest)
          throw new JarvisError(INVALID);
        const identities = persistForbiddenContentIdentities(authority, { purge_id: purgeId, material: [bytes], observed_at: now.toISOString() });
        const encoded = canonicalize([...identities].sort((a, b) => a.identity_digest.localeCompare(b.identity_digest)));
        authority.db.prepare(`INSERT INTO memory_cancellation_material_checkpoints VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(id, purgeId, after.request.spool_digest, after.request.payload_digest, sha(bytes), bytes.length,
            encoded, sha(encoded), now.toISOString());
      }).immediate();
    }
    return material;
  } catch (error) { material.forEach(value => value.fill(0)); throw error; }
}
