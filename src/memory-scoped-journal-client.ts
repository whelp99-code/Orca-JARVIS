import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import type { createProductionMemoryAccessClaim } from "./memory-access-claim-production.js";
import { parseMemoryScopedWriteRequestJson } from "./memory-scoped-write-codec.js";
import type { MemoryScopedWriteRequestMaterial } from "./memory-scoped-write-request.js";
import type { SecondBrainAdapterBudgets } from "./second-brain-adapter-types.js";
import { SecondBrainReadBudget } from "./second-brain-read-budget.js";
import { parseSecondBrainRecoveredRequestStatus } from "./second-brain-scoped-request-status.js";
import type { SecondBrainTransport } from "./second-brain-transport.js";

type Issuer = ReturnType<typeof createProductionMemoryAccessClaim>;
type Bundle = ReturnType<Issuer>;
export type MemoryScopedJournalClientOptions = {
  readonly issue: Issuer;
  readonly transport: SecondBrainTransport;
  readonly now: () => Date;
  readonly budgets: SecondBrainAdapterBudgets;
};
const fail = (): never => { throw new JarvisError("MEMORY_SCOPED_JOURNAL_UNAVAILABLE"); };
function identity({ access_claim: c, read_fence: f }: Bundle): string {
  return canonicalize({ provider: c.provider_instance_id, principal: c.principal_id, agent: c.agent_id,
    session: c.session_id, projects: c.projects, policy: c.policy_revision, purpose: c.purpose,
    request: c.request_digest, key: c.signing_key_id, sequence: f.tombstone_sequence, root: f.tombstone_set_root });
}
/** Historical journal only. Never supplies a generation, current artifact or settlement evidence. */
export function createMemoryScopedJournalClient(options: MemoryScopedJournalClientOptions) {
  async function read(input: MemoryScopedWriteRequestMaterial, signal?: AbortSignal) {
    const active = () => { if (signal?.aborted) throw new JarvisError("SECOND_BRAIN_CANCELLED"); };
    active();
    const started = options.now().getTime(), created = new Date(input.created_at);
    if (!Number.isFinite(started) || !Number.isFinite(created.getTime()) || created.getTime() > started) return fail();
    const snapshot = parseMemoryScopedWriteRequestJson(canonicalize(input), input.provider_instance_id, created);
    const request = Object.freeze({ method: "sb_request_status", arguments: Object.freeze({ request: snapshot }) });
    const bundle = options.issue(request, new Date(started));
    active();
    const c = bundle.access_claim, f = bundle.read_fence, scope = snapshot.preparation.binding.identity;
    const requestDigest = "sha256:" + createHash("sha256").update("orca-jarvis/memory-access-request/v1\0" + canonicalize(request)).digest("hex");
    if (c.provider_instance_id !== snapshot.provider_instance_id || f.provider_instance_id !== snapshot.provider_instance_id
      || c.principal_id !== scope.owner || c.policy_revision !== scope.policy_revision
      || (scope.projects.length === 0 ? c.projects.length !== 0 : scope.projects.some(p => !c.projects.includes(p)))
      || c.purpose !== "memory_status" || f.purpose !== "memory_status" || f.operation !== "status"
      || c.request_digest !== requestDigest || c.read_fence_digest !== f.fence_digest
      || !Number.isSafeInteger(f.tombstone_sequence) || f.tombstone_sequence < 0) return fail();
    const original = identity(bundle);
    let last = started;
    let until = Math.min(Date.parse(c.expires_at), Date.parse(f.expires_at));
    const recheck = () => {
      active();
      const at = options.now().getTime();
      if (!Number.isFinite(at) || at < last || at < Date.parse(c.issued_at)
        || at < Date.parse(f.not_before) || !(at < until)) return fail();
      const renewed = options.issue(request, new Date(at));
      active();
      until = Math.min(until, Date.parse(renewed.access_claim.expires_at), Date.parse(renewed.read_fence.expires_at));
      if (identity(renewed) !== original || !(at < until)) return fail();
      last = at;
      return new Date(at);
    };
    const outcome = await options.transport.call("sb_request_status", { ...request.arguments, ...bundle },
      { signal, beforeSend: recheck });
    const checked = recheck();
    if (outcome.kind !== "data") return fail();
    const value = outcome.value;
    if (new SecondBrainReadBudget(options.budgets).consumeProvider(value) !== undefined
      || value === null || typeof value !== "object" || Array.isArray(value)) return fail();
    const v = value as Record<string, unknown>;
    const keys = ["profile", "request_digest", "access_claim_digest", "provider_instance_id", "tombstone_sequence", "tombstone_set_root", "request_status"];
    if (Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))
      || v.profile !== "scoped-request-status-v1" || v.request_digest !== requestDigest
      || v.access_claim_digest !== "sha256:" + createHash("sha256").update("orca-jarvis/memory-access-claim-binding/v1\0" + canonicalize(c)).digest("hex")
      || v.provider_instance_id !== snapshot.provider_instance_id
      || v.tombstone_sequence !== f.tombstone_sequence || v.tombstone_set_root !== f.tombstone_set_root) return fail();
    const status = parseSecondBrainRecoveredRequestStatus(v.request_status, snapshot, checked);
    const refresh = () => {
      const at = recheck();
      return Object.freeze({ kind: "scoped_journal_status_observed" as const, status,
        checked_at: at.toISOString(), valid_until: new Date(until).toISOString() });
    };
    return { observation: refresh(), refresh };
  }
  return Object.freeze({
    recoverRequestStatus: async (input: MemoryScopedWriteRequestMaterial, signal?: AbortSignal) => {
      const { observation } = await read(input, signal);
      return Object.freeze({ kind: observation.kind, status: observation.status });
    },
    /** Trusted synchronous transaction consumer only; refresh expires on return.
     * Refresh checks local authority, never refetches or renews the provider snapshot. */
    withRecoveredRequestStatus: async <T>(input: MemoryScopedWriteRequestMaterial,
      consume: (observation: Awaited<ReturnType<typeof read>>["observation"],
        refresh: () => Awaited<ReturnType<typeof read>>["observation"]) => T, signal?: AbortSignal): Promise<T> => {
      const result = await read(input, signal);
      let active = true;
      const refresh = () => { if (!active) return fail(); return result.refresh(); };
      try { return consume(refresh(), refresh); }
      finally { active = false; }
    },
  });
}
