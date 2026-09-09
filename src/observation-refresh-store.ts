import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { normalizePersonalObservations } from "./personal-observations.js";
import type { PersonalObservationNormalizationInput } from "./personal-observation-input.js";
import { canonicalPersonalContractHash, parseObservationEnvelopeV1 } from "./personal-validation.js";
import { isPersistenceTime } from "./personal-persistence-values.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";

type Member = { readonly source_id: string; readonly worktree_id: string };
type Scope = { readonly members: readonly Member[] };
type Collection = { readonly source_id: string; readonly worktree_id: string; readonly state: "completed" | "failed" };
type Ref = { readonly id: string; readonly digest: string };
type Manifest = { readonly version: 1; readonly request_digest: string; readonly scope_digest: string;
  readonly checked_at: string; readonly completed_at: string; readonly capped: boolean;
  readonly collections: readonly Collection[]; readonly observations: readonly Ref[] };
type Row = { refresh_id: string; request_digest: string; scope_digest: string; receipt_digest: string;
  manifest_json: string; completed_at: string };
const hash = (value: unknown): string => `sha256:${createHash("sha256").update("orca-jarvis/observation-refresh/v1\0")
  .update(canonicalize(value)).digest("hex")}`;
const fail = (): never => { throw new JarvisError("OBSERVATION_REFRESH_INVALID"); };
function members(value: readonly Member[]): readonly Member[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return fail();
  const result = value.map(item => {
    if (!item || [item.source_id, item.worktree_id].some(id => typeof id !== "string" || !/^[A-Za-z0-9:._/-]{1,256}$/.test(id))) return fail();
    return Object.freeze({ source_id: item.source_id, worktree_id: item.worktree_id });
  }).sort((a, b) => canonicalize(a).localeCompare(canonicalize(b)));
  if (new Set(result.map(item => canonicalize(item))).size !== result.length) return fail();
  return Object.freeze(result);
}

/** Local admission only: this store does not authenticate or invoke a provider. */
export class ObservationRefreshStore {
  private readonly scope: Scope;
  private readonly scopeDigest: string;
  constructor(private readonly authority: AuthorityDb, scope: Scope) {
    this.scope = Object.freeze({ members: members(scope.members) });
    this.scopeDigest = hash(this.scope);
  }

  admit(input: { readonly key: string; readonly observations: PersonalObservationNormalizationInput;
    readonly capped: boolean; readonly collections: readonly Collection[] }, at: string) {
    if (typeof input.key !== "string" || input.key.length < 1 || Buffer.byteLength(input.key) > 1024
      || typeof input.capped !== "boolean" || !isPersistenceTime(at)) return fail();
    if (!Array.isArray(input.collections) || input.collections.length !== this.scope.members.length) return fail();
    const collections = input.collections.map(item => {
      if (!item || !this.scope.members.some(member => member.source_id === item.source_id && member.worktree_id === item.worktree_id)
        || !["completed", "failed"].includes(item.state)) return fail();
      return { source_id: item.source_id, worktree_id: item.worktree_id, state: item.state };
    }).sort((a, b) => canonicalize(a).localeCompare(canonicalize(b)));
    if (new Set(collections.map(item => `${item.source_id}\0${item.worktree_id}`)).size !== collections.length) return fail();
    const raw = input.observations;
    // This first admission contract covers configured structured Orca tasks only.
    if (!Array.isArray(raw.orca_tasks) || raw.orca_tasks.length > 256 || !Array.isArray(raw.portfolios) || raw.portfolios.length !== 0) return fail();
    const observations = normalizePersonalObservations(raw);
    if (!isPersistenceTime(raw.checked_at) || raw.checked_at > at) return fail();
    for (const observation of observations) {
      const value = observation.payload.state === "fresh" ? observation.payload.value : null;
      if (!this.scope.members.some(member => member.source_id === observation.source.source_id)
        || observation.payload.state !== "fresh" || observation.payload.kind !== "live_task"
        || typeof value !== "object" || value === null || Array.isArray(value)
        || !this.scope.members.some(member => member.source_id === observation.source.source_id
          && member.worktree_id === (value as Record<string, unknown>)["worktree_id"])) return fail();
    }
    for (const task of raw.orca_tasks) {
      // A complete receipt cannot attest a partial or temporally inconsistent timeline.
      const timeline = task.timeline;
      if (timeline.truncated || !isPersistenceTime(timeline.generated_at)
        || timeline.generated_at > raw.checked_at
        || !isPersistenceTime(timeline.task.updated_at)
        || timeline.task.updated_at > timeline.generated_at
        || timeline.events.some((event: { readonly created_at: string }) => !isPersistenceTime(event.created_at)
          || event.created_at > timeline.generated_at)) return fail();
      const source = task.environment === "mac-client" ? "src:pos:v1:mac-client:orca" : `src:pos:v1:orca:${task.environment}`;
      if (!collections.some(item => item.source_id === source && item.worktree_id === task.worktree_id && item.state === "completed")) return fail();
    }
    const refs = observations.map(observation => ({ id: observation.id, digest: canonicalPersonalContractHash(observation) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(refs.map(ref => ref.id)).size !== refs.length) return fail();
    const requestDigest = hash({ scope: this.scopeDigest, key: input.key });
    const candidate: Manifest = { version: 1, request_digest: requestDigest, scope_digest: this.scopeDigest,
      checked_at: raw.checked_at, completed_at: at, capped: input.capped, collections, observations: refs };
    if (Buffer.byteLength(canonicalize(candidate)) > 131072) return fail();
    return this.authority.db.transaction(() => {
      const prior = this.authority.db.prepare("SELECT * FROM observation_refresh_receipts WHERE request_digest=?").get(requestDigest) as Row | undefined;
      const manifest: Manifest = { version: 1, request_digest: requestDigest, scope_digest: this.scopeDigest,
        checked_at: raw.checked_at, completed_at: prior?.completed_at ?? at, capped: input.capped, collections, observations: refs };
      const digest = hash(manifest), id = `refresh:${digest}`;
      if (prior) {
        if (prior.completed_at > at || prior.receipt_digest !== digest
          || prior.manifest_json !== canonicalize(manifest) || prior.refresh_id !== id) return fail();
        return { refresh_id: id, receipt_digest: digest, inserted: false };
      }
      if (Date.parse(at) - Date.parse(raw.checked_at) >= 300000) return fail();
      const projections = new MemoryProjectionAuthority(this.authority);
      projections.assertReady();
      for (const ref of refs) if (projections.isProjectionIdSuppressed(ref.id)) return fail();
      this.authority.persistObservationBatch(observations, at);
      this.authority.db.prepare(`INSERT INTO observation_refresh_receipts
        (refresh_id,request_digest,scope_digest,receipt_digest,manifest_json,completed_at) VALUES(?,?,?,?,?,?)`)
        .run(id, requestDigest, this.scopeDigest, digest, canonicalize(manifest), at);
      return { refresh_id: id, receipt_digest: digest, inserted: true };
    }).immediate();
  }

  read(id: string, at: string) {
    if (typeof id !== "string" || !/^refresh:sha256:[0-9a-f]{64}$/.test(id) || !isPersistenceTime(at)) return fail();
    return this.authority.db.transaction(() => {
      const row = this.authority.db.prepare("SELECT * FROM observation_refresh_receipts WHERE refresh_id=? AND scope_digest=?")
        .get(id, this.scopeDigest) as Row | undefined;
      if (!row) return null;
      const manifest = JSON.parse(row.manifest_json) as Manifest;
      if (row.manifest_json !== canonicalize(manifest) || hash(manifest) !== row.receipt_digest || `refresh:${row.receipt_digest}` !== row.refresh_id
        || manifest.version !== 1 || manifest.request_digest !== row.request_digest || manifest.scope_digest !== this.scopeDigest
        || manifest.completed_at !== row.completed_at || !isPersistenceTime(manifest.checked_at)
        || !isPersistenceTime(manifest.completed_at) || manifest.checked_at > manifest.completed_at
        || typeof manifest.capped !== "boolean" || !Array.isArray(manifest.observations) || manifest.observations.length > 256) return fail();
      const unavailable = (reason: string) => ({ refresh_id: id, state: "unavailable", reason, observation_count: manifest.observations.length });
      if (manifest.completed_at > at || Date.parse(at) - Date.parse(manifest.checked_at) >= 300000) return unavailable("stale");
      if (!Array.isArray(manifest.collections) || manifest.collections.length !== this.scope.members.length
        || this.scope.members.some(member => !manifest.collections.some(item =>
          item.source_id === member.source_id && item.worktree_id === member.worktree_id))) return fail();
      if (manifest.collections.some(item => item.state !== "completed")) return unavailable("collection_failed");
      if (manifest.capped) return unavailable("capped");
      const projections = new MemoryProjectionAuthority(this.authority); projections.assertReady();
      for (const ref of manifest.observations) {
        if (projections.isProjectionIdSuppressed(ref.id)) return unavailable("suppressed");
        const stored = this.authority.db.prepare("SELECT canonical_digest,canonical_envelope_json FROM personal_observations WHERE observation_id=?")
          .get(ref.id) as { canonical_digest: string; canonical_envelope_json: string } | undefined;
        if (!stored) return unavailable("source_missing");
        const observation = parseObservationEnvelopeV1(JSON.parse(stored.canonical_envelope_json));
        if (stored.canonical_digest !== ref.digest || canonicalPersonalContractHash(observation) !== ref.digest || observation.id !== ref.id) return fail();
        if (observation.freshness.state !== "fresh" || observation.freshness.fresh_until <= at || observation.expires_at <= at) return unavailable("stale");
      }
      return { refresh_id: id, state: manifest.observations.length === 0 ? "no_data" : "ready",
        reason: "recorded_sources", observation_count: manifest.observations.length, completed_at: manifest.completed_at };
    }).deferred();
  }
}
