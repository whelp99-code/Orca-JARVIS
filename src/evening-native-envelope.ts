import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { readEveningNativeSource } from "./evening-native-source.js";
import { closeoutHash, closeoutSigningBytes, parseCloseoutEnvelope, parseCloseoutSigningIdentity,
  verifyCloseoutSignature } from "./evening-closeout-crypto.js";
import { closedArray, closedObject, closeoutDigest, closeoutInstant, closeoutInteger, closeoutText,
  invalidCloseout } from "./evening-closeout-parse-values.js";
import type { CloseoutSigningHandle, TrustedCloseoutKey } from "./evening-closeout-types.js";
import { parseDailyLoopDate } from "./daily-loop-input.js";

const DOMAIN = "orca-jarvis/evening-closeout-native/v2\0";
const MAX_EVIDENCE_BYTES = 1048576;
// Source metadata and at most 100 record separators are outside the evidence budget.
const MAX_SOURCE_JSON_BYTES = MAX_EVIDENCE_BYTES + 4096;
// JSON string escaping can double source bytes; reserve bounded identity/scope metadata.
const MAX_ENVELOPE_BYTES = 2 * MAX_SOURCE_JSON_BYTES + 32768;
const OMISSIONS = ["open_work_unavailable", "decisions_unavailable", "memory_candidates_unavailable",
  "tomorrow_actions_unavailable", "risks_unavailable"];
type SourceOptions = Parameters<typeof readEveningNativeSource>[1];
type Core = { schema_version: 2; scope: "native_task_completions"; run_id: string; correlation_id: string;
  local_date: string; generated_at: string; repository_identities: readonly string[];
  max_source_records: number; max_source_bytes: number; source_json: string;
  source_digest: string; native_completion_count: number; source_readiness: "degraded";
  source_omissions: readonly string[] };
export type NativeEveningEnvelope = Core & { artifact_id: string; canonical_digest: string;
  envelope: ReturnType<typeof parseCloseoutEnvelope> };

function parseSourceJson(json: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return invalidCloseout(); }
  const pending: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }];
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (item.depth > 64) return invalidCloseout();
    if (typeof item.value === "number" && !Number.isFinite(item.value)) return invalidCloseout();
    if (item.value !== null && typeof item.value === "object") {
      for (const value of Object.values(item.value)) pending.push({ value, depth: item.depth + 1 });
    }
  }
  return parsed;
}

function parseCore(value: Record<string, unknown>): Core {
  if (value.schema_version !== 2 || value.scope !== "native_task_completions" || value.source_readiness !== "degraded"
    || typeof value.source_json !== "string" || Buffer.byteLength(value.source_json) > MAX_SOURCE_JSON_BYTES) return invalidCloseout();
  const scopes = closedArray(value.repository_identities, 100).map(closeoutDigest);
  const omissions = closedArray(value.source_omissions, 5).map(item => closeoutText(item));
  if (new Set(scopes).size !== scopes.length || canonicalize(omissions) !== canonicalize(OMISSIONS)) return invalidCloseout();
  const source = closedObject(parseSourceJson(value.source_json),
    ["schema_version", "local_date", "observed_at", "state", "records", "evidence_bytes", "hidden_count", "limited"]);
  const records = closedArray(source.records, 100);
  closeoutInteger(source.hidden_count, 0, 100);
  if (source.schema_version !== 1 || !["ready", "partial", "no_data"].includes(String(source.state))
    || typeof source.limited !== "boolean" || canonicalize(source) !== value.source_json
    || source.local_date !== value.local_date || source.observed_at !== value.generated_at
    || closeoutInteger(source.evidence_bytes, 0, MAX_EVIDENCE_BYTES)
      !== records.reduce<number>((n, item) => n + Buffer.byteLength(canonicalize(item)), 0)) return invalidCloseout();
  const core: Core = { schema_version: 2, scope: "native_task_completions",
    run_id: closeoutText(value.run_id), correlation_id: closeoutText(value.correlation_id),
    local_date: parseDailyLoopDate(value.local_date), generated_at: closeoutInstant(value.generated_at),
    repository_identities: scopes, max_source_records: closeoutInteger(value.max_source_records, 1, 100),
    max_source_bytes: closeoutInteger(value.max_source_bytes, 1, MAX_EVIDENCE_BYTES), source_json: value.source_json,
    source_digest: closeoutDigest(value.source_digest), native_completion_count: closeoutInteger(value.native_completion_count, 0, 100),
    source_readiness: "degraded", source_omissions: [...OMISSIONS] };
  if (core.source_digest !== closeoutHash(source) || core.native_completion_count !== records.length
    || records.length > core.max_source_records || Number(source.evidence_bytes) > core.max_source_bytes
    || (source.state === "no_data") !== (records.length === 0 && !source.limited && source.hidden_count === 0)
    || (source.state === "partial") !== (source.limited || Number(source.hidden_count) > 0)) return invalidCloseout();
  return core;
}

/** Verifies the durable outer envelope only; live use must also validate its original source. */
export function verifyNativeEveningEnvelope(value: unknown, trusted: TrustedCloseoutKey): NativeEveningEnvelope {
  const input = closedObject(value, ["schema_version", "scope", "run_id", "correlation_id", "local_date", "generated_at",
    "repository_identities", "max_source_records", "max_source_bytes", "source_json", "source_digest",
    "native_completion_count", "source_readiness", "source_omissions", "artifact_id", "canonical_digest", "envelope"]);
  const core = parseCore(input); const digest = closeoutHash(core); const envelope = parseCloseoutEnvelope(input.envelope);
  const artifactId = closeoutText(input.artifact_id); const claimedDigest = closeoutDigest(input.canonical_digest);
  if (Buffer.byteLength(canonicalize({ ...core, artifact_id: artifactId,
    canonical_digest: claimedDigest, envelope })) > MAX_ENVELOPE_BYTES) return invalidCloseout();
  const { signature, ...identity } = envelope; void signature;
  const unsigned = { ...core, artifact_id: `evening-closeout:v2:${digest.slice(7)}`, canonical_digest: digest, envelope: identity };
  if (artifactId !== unsigned.artifact_id || claimedDigest !== digest
    || !verifyCloseoutSignature(DOMAIN, unsigned, envelope, trusted)) return invalidCloseout();
  return { ...unsigned, envelope };
}

export function generateNativeEveningEnvelope(authority: AuthorityDb,
  input: SourceOptions & { readonly run_id: string; readonly correlation_id: string }, signer: CloseoutSigningHandle): NativeEveningEnvelope {
  const at = signer.clock();
  if (!Number.isFinite(at.getTime()) || at.getTime() !== input.observed_at.getTime()) return invalidCloseout();
  const source = readEveningNativeSource(authority, { local_date: input.local_date, observed_at: at,
    repository_identities: input.repository_identities, max_records: input.max_records, max_bytes: input.max_bytes });
  const core = parseCore({ schema_version: 2, scope: "native_task_completions", run_id: input.run_id,
    correlation_id: input.correlation_id, local_date: source.local_date, generated_at: source.observed_at,
    repository_identities: input.repository_identities, max_source_records: input.max_records, max_source_bytes: input.max_bytes,
    source_json: canonicalize(source), source_digest: closeoutHash(source), native_completion_count: source.records.length,
    source_readiness: "degraded", source_omissions: OMISSIONS });
  const identity = parseCloseoutSigningIdentity(signer.identity); const digest = closeoutHash(core);
  const unsigned = { ...core, artifact_id: `evening-closeout:v2:${digest.slice(7)}`, canonical_digest: digest, envelope: identity };
  const signature = signer.sign(closeoutSigningBytes(DOMAIN, unsigned));
  if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) return invalidCloseout();
  return verifyNativeEveningEnvelope({ ...unsigned, envelope: { ...identity, signature: Buffer.from(signature).toString("base64url") } }, identity);
}

export function verifyLiveNativeEveningEnvelope(authority: AuthorityDb, value: unknown, trusted: TrustedCloseoutKey,
  observedAt = new Date()): NativeEveningEnvelope {
  const artifact = verifyNativeEveningEnvelope(value, trusted);
  if (!Number.isFinite(observedAt.getTime()) || Date.parse(artifact.generated_at) > observedAt.getTime()) return invalidCloseout();
  const source = readEveningNativeSource(authority, { local_date: artifact.local_date, observed_at: new Date(artifact.generated_at),
    repository_identities: artifact.repository_identities, max_records: artifact.max_source_records, max_bytes: artifact.max_source_bytes });
  if (canonicalize(source) !== artifact.source_json) return invalidCloseout();
  return artifact;
}
