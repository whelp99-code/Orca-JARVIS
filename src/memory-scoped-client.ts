import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import type { createProductionMemoryAccessClaim, MemoryAccessRequest } from "./memory-access-claim-production.js";
import { parseScopedSecondBrainResponse } from "./second-brain-scoped-read.js";
import type { SecondBrainAdapterBudgets } from "./second-brain-adapter-types.js";
import type { SecondBrainTransport } from "./second-brain-transport.js";

type Issuer = ReturnType<typeof createProductionMemoryAccessClaim>;
type Bundle = ReturnType<Issuer>;
export type MemoryScopedClientOptions = {
  readonly issue: Issuer;
  readonly status_issue?: Issuer;
  readonly profile?: "scoped-record-read-v1" | "scoped-record-read-v2";
  readonly transport: SecondBrainTransport;
  readonly now: () => Date;
  readonly budgets: SecondBrainAdapterBudgets;
  readonly max_age_ms: number;
  readonly expiry_ms: number;
};
function identity(bundle: Bundle): string {
  const claim = bundle.access_claim;
  const fence = bundle.read_fence;
  return canonicalize({ provider: claim.provider_instance_id, principal: claim.principal_id,
    agent: claim.agent_id, session: claim.session_id, projects: claim.projects, policy: claim.policy_revision,
    purpose: claim.purpose, request: claim.request_digest, key: claim.signing_key_id,
    sequence: fence.tombstone_sequence, root: fence.tombstone_set_root });
}
const denied = (): never => { throw new JarvisError("MEMORY_SCOPED_READ_UNAVAILABLE"); };
/** Connects the current authenticated scope issuer, supervised transport and record
 * consumer. Does not own sessions, cache permissions, or attest task success. */
export function createMemoryScopedClient(options: MemoryScopedClientOptions) {
  async function read(method: "sb_read_page" | "sb_search" | "sb_generation_status", arguments_: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
    const request: MemoryAccessRequest = Object.freeze({ method, arguments: Object.freeze({ ...arguments_ }) });
    if (method === "sb_generation_status" && options.profile !== "scoped-record-read-v2") return denied();
    const issue = method === "sb_generation_status" ? options.status_issue : options.issue;
    if (issue === undefined) return denied();
    const bundle = issue(request, new Date(options.now().getTime()));
    const original = identity(bundle);
    const recheck = () => {
      const at = new Date(options.now().getTime());
      if (!Number.isFinite(at.getTime()) || at.getTime() < Date.parse(bundle.access_claim.issued_at)
        || at.getTime() >= Date.parse(bundle.access_claim.expires_at)) return denied();
      // Reuses current DB-key, authenticated-session and file-policy checks. The
      // new signature is request-local and is never sent or persisted.
      if (identity(issue(request, at)) !== original) return denied();
      return at;
    };
    const outcome = await options.transport.call(method, { ...request.arguments, ...bundle }, { signal, beforeSend: recheck });
    const checked = recheck();
    if (outcome.kind !== "data") return denied();
    const parsed = parseScopedSecondBrainResponse(outcome.value, {
      method, profile: options.profile, page_id: method === "sb_read_page" ? String(request.arguments.id) : undefined,
      limit: method === "sb_search" ? Number(request.arguments.limit) : 64,
      request_digest: bundle.access_claim.request_digest,
      access_claim_digest: "sha256:" + createHash("sha256").update("orca-jarvis/memory-access-claim-binding/v1\0"
        + canonicalize(bundle.access_claim)).digest("hex"),
      authorized_until: bundle.access_claim.expires_at, fence: bundle.read_fence, checked_at: checked,
      budgets: options.budgets, max_age_ms: options.max_age_ms, expiry_ms: options.expiry_ms });
    recheck();
    return parsed;
  }
  return {
    status: (signal?: AbortSignal) => read("sb_generation_status", {}, signal),
    readPage: (id: string, signal?: AbortSignal) => read("sb_read_page", { id }, signal),
    search: (query: string, limit = 10, signal?: AbortSignal) => read("sb_search", { query, limit }, signal),
  };
}
