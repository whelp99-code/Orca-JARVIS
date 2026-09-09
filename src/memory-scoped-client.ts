import { parseMemoryScopedWriteRequestJson } from "./memory-scoped-write-codec.js";
import { parseSecondBrainScopedWriteAccepted } from "./second-brain-scoped-write-result.js";
import { parseSecondBrainRecoveredRequestStatus, parseSecondBrainScopedRequestStatus } from "./second-brain-scoped-request-status.js";
import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import type { createProductionMemoryAccessClaim, MemoryAccessRequest } from "./memory-access-claim-production.js";
import { parseScopedSecondBrainResponse } from "./second-brain-scoped-read.js";
import type { SecondBrainAdapterBudgets } from "./second-brain-adapter-types.js";
import type { SecondBrainTransport } from "./second-brain-transport.js";

import type { MemoryScopedWriteRequestMaterial } from "./memory-scoped-write-request.js";
import { rememberedArtifactExpectation, verifyRememberedArtifactRead } from "./second-brain-remembered-artifact.js";

type Issuer = ReturnType<typeof createProductionMemoryAccessClaim>;
type Bundle = ReturnType<Issuer>;
export type MemoryScopedClientOptions = {
  readonly issue: Issuer;
  readonly status_issue?: Issuer;
  readonly profile?: "scoped-record-read-v1" | "scoped-record-read-v2" | "scoped-record-read-v3" | "scoped-record-read-v4" | "scoped-record-read-v5";
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
  async function read(method: "sb_read_page" | "sb_search" | "sb_generation_status" | "sb_request_status", arguments_: Readonly<Record<string, unknown>>, signal?: AbortSignal, artifact?: Pick<ReturnType<typeof rememberedArtifactExpectation>, "provider" | "owner" | "policy" | "projects">, historical?: { request: MemoryScopedWriteRequestMaterial; acceptance?: unknown }) {
    const request: MemoryAccessRequest = Object.freeze({ method, arguments: Object.freeze({ ...arguments_ }) });
    if (method === "sb_generation_status" && (options.profile !== "scoped-record-read-v2" && options.profile !== "scoped-record-read-v3" && options.profile !== "scoped-record-read-v4" && options.profile !== "scoped-record-read-v5")) return denied();
    if (method === "sb_request_status" && options.profile !== "scoped-record-read-v4" && options.profile !== "scoped-record-read-v5") return denied();
    const issue = ["sb_generation_status", "sb_request_status"].includes(method) ? options.status_issue : options.issue;
    if (issue === undefined) return denied();
    const bundle = issue(request, new Date(options.now().getTime()));
    if (artifact !== undefined && (bundle.access_claim.provider_instance_id !== artifact.provider
      || bundle.access_claim.principal_id !== artifact.owner || bundle.access_claim.policy_revision !== artifact.policy
      || (artifact.projects.length === 0 ? bundle.access_claim.projects.length !== 0
        : artifact.projects.some(project => !bundle.access_claim.projects.includes(project))))) return denied();
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
      method, profile: options.profile, scope: { owner: bundle.access_claim.principal_id,
        projects: bundle.access_claim.projects, policy_revision: bundle.access_claim.policy_revision }, page_id: method === "sb_read_page" ? String(request.arguments.id) : undefined,
      limit: method === "sb_search" ? Number(request.arguments.limit) : 64,
      request_digest: bundle.access_claim.request_digest,
      access_claim_digest: "sha256:" + createHash("sha256").update("orca-jarvis/memory-access-claim-binding/v1\0"
        + canonicalize(bundle.access_claim)).digest("hex"),
      authorized_until: bundle.access_claim.expires_at, fence: bundle.read_fence, checked_at: checked,
      budgets: options.budgets, max_age_ms: options.max_age_ms, expiry_ms: options.expiry_ms });
    if (method === "sb_request_status") {
      if (historical === undefined || !("request_status" in parsed)) return denied();
      const status = options.profile === "scoped-record-read-v5"
        ? parseSecondBrainRecoveredRequestStatus(parsed.request_status, historical.request, checked, historical.acceptance)
        : parseSecondBrainScopedRequestStatus(parsed.request_status, historical.request, historical.acceptance, checked);
      recheck();
      return { generation: parsed.generation, pages: [], request_status: status };
    }
    recheck();
    return parsed;
  }
  return {
    recoverRequestStatus: async (request: MemoryScopedWriteRequestMaterial, signal?: AbortSignal) => {
      if (options.profile !== "scoped-record-read-v5") return denied();
      const at = new Date(options.now().getTime());
      const created = new Date(request.created_at);
      if (!Number.isFinite(at.getTime()) || !Number.isFinite(created.getTime()) || created > at) return denied();
      const snapshot = parseMemoryScopedWriteRequestJson(canonicalize(request), request.provider_instance_id, created);
      const scope = snapshot.preparation.binding.identity;
      const response = await read("sb_request_status", { request: snapshot }, signal,
        { provider: snapshot.provider_instance_id, owner: scope.owner, projects: scope.projects, policy: scope.policy_revision },
        { request: snapshot });
      if (!("request_status" in response)) return denied();
      return { generation: response.generation, status: response.request_status };
    },
    requestStatus: async (request: MemoryScopedWriteRequestMaterial, acceptance: unknown, signal?: AbortSignal) => {
      const accepted = parseSecondBrainScopedWriteAccepted(acceptance, request, new Date(options.now().getTime()));
      const snapshot = parseMemoryScopedWriteRequestJson(canonicalize(request), request.provider_instance_id, new Date(accepted.accepted_at));
      const expected = rememberedArtifactExpectation(snapshot, accepted, new Date(options.now().getTime()));
      const response = await read("sb_request_status", { request: snapshot }, signal, expected, { request: snapshot, acceptance: accepted });
      if (!("request_status" in response)) return denied();
      return { generation: response.generation, status: response.request_status };
    },
    readRememberedArtifact: async (request: MemoryScopedWriteRequestMaterial, acceptance: unknown, signal?: AbortSignal) => {
      const expected = rememberedArtifactExpectation(request, acceptance, new Date(options.now().getTime()));
      const response = await read("sb_read_page", { id: expected.page_id }, signal, expected);
      return verifyRememberedArtifactRead(expected, response);
    },
    authorizationIdentity: () => {
      if ((options.profile !== "scoped-record-read-v2" && options.profile !== "scoped-record-read-v3" && options.profile !== "scoped-record-read-v4" && options.profile !== "scoped-record-read-v5") || options.status_issue === undefined) return denied();
      return identity(options.status_issue({ method: "sb_generation_status", arguments: {} }, new Date(options.now().getTime())));
    },
    status: (signal?: AbortSignal) => read("sb_generation_status", {}, signal),
    readPage: (id: string, signal?: AbortSignal) => read("sb_read_page", { id }, signal),
    search: (query: string, limit = 10, signal?: AbortSignal) => read("sb_search", { query, limit }, signal),
  };
}
