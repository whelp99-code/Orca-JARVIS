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
type ReadCheckpoint = { readonly recheck: () => Date; readonly expires_at: string;
  readonly checked_at: Date; readonly context: string };
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
  async function read(method: "sb_read_page" | "sb_search" | "sb_generation_status" | "sb_request_status", arguments_: Readonly<Record<string, unknown>>, signal?: AbortSignal, artifact?: Pick<ReturnType<typeof rememberedArtifactExpectation>, "provider" | "owner" | "policy" | "projects">, historical?: { request: MemoryScopedWriteRequestMaterial; acceptance?: unknown }, capture?: (check: ReadCheckpoint) => void) {
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
    let authorizedUntil = Date.parse(bundle.access_claim.expires_at);
    const recheck = () => {
      const at = new Date(options.now().getTime());
      if (!Number.isFinite(at.getTime()) || at.getTime() < Date.parse(bundle.access_claim.issued_at)
        || at.getTime() >= Date.parse(bundle.access_claim.expires_at)) return denied();
      // Reuses current DB-key, authenticated-session and file-policy checks. The
      // new signature is request-local and is never sent or persisted.
      const renewed = issue(request, at);
      if (identity(renewed) !== original) return denied();
      authorizedUntil = Math.min(authorizedUntil, Date.parse(renewed.access_claim.expires_at));
      if (!(at.getTime() < authorizedUntil)) return denied();
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
      authorized_until: new Date(authorizedUntil).toISOString(), fence: bundle.read_fence, checked_at: checked,
      budgets: options.budgets, max_age_ms: options.max_age_ms, expiry_ms: options.expiry_ms });
    const checkpoint = () => {
      const at = recheck();
      capture?.({ recheck, get expires_at() { return new Date(authorizedUntil).toISOString(); }, checked_at: at,
        context: canonicalize({ provider: bundle.access_claim.provider_instance_id,
          principal: bundle.access_claim.principal_id, agent: bundle.access_claim.agent_id,
          session: bundle.access_claim.session_id, policy: bundle.access_claim.policy_revision }) });
    };
    if (method === "sb_request_status") {
      if (historical === undefined || !("request_status" in parsed)) return denied();
      const status = options.profile === "scoped-record-read-v5"
        ? parseSecondBrainRecoveredRequestStatus(parsed.request_status, historical.request, checked, historical.acceptance)
        : parseSecondBrainScopedRequestStatus(parsed.request_status, historical.request, historical.acceptance, checked);
      checkpoint();
      return { generation: parsed.generation, pages: [], request_status: status };
    }
    checkpoint();
    return parsed;
  }
  return {
    /** Current completion evidence, not permission to settle or a reusable grant.
     * A downstream writer must still fence its own transaction and revalidate
     * current authority at use; this does not mutate an outbox or control task. */
    readRememberedCompletion: async (request: MemoryScopedWriteRequestMaterial, signal?: AbortSignal) => {
      if (options.profile !== "scoped-record-read-v5") return denied();
      const started = new Date(options.now().getTime()), created = new Date(request.created_at);
      if (!Number.isFinite(started.getTime()) || !Number.isFinite(created.getTime()) || created > started) return denied();
      const snapshot = parseMemoryScopedWriteRequestJson(canonicalize(request), request.provider_instance_id, created);
      const scope = snapshot.preparation.binding.identity;
      const expectedScope = { provider: snapshot.provider_instance_id, owner: scope.owner,
        projects: scope.projects, policy: scope.policy_revision };
      const checkpoints: ReadCheckpoint[] = [];
      const capture = (check: ReadCheckpoint) => { checkpoints.push(check); };
      const first = await read("sb_request_status", { request: snapshot }, signal, expectedScope, { request: snapshot }, capture);
      if (!("request_status" in first) || first.request_status === undefined) return denied();
      const status = first.request_status as Readonly<Record<string, unknown>>;
      if (status.state !== "proved") return denied();
      const expected = rememberedArtifactExpectation(snapshot, status.acceptance, new Date(options.now().getTime()));
      const page = await read("sb_read_page", { id: expected.page_id }, signal, expected, undefined, capture);
      const artifact = verifyRememberedArtifactRead(expected, page);
      if (artifact.kind !== "remembered_artifact_observed") return denied();
      const last = await read("sb_request_status", { request: snapshot }, signal, expectedScope, { request: snapshot }, capture);
      if (!("request_status" in last) || canonicalize(last.request_status) !== canonicalize(status)
        || canonicalize(last.generation) !== canonicalize(artifact.generation)
        || checkpoints.length !== 3 || checkpoints.some(check => check.context !== checkpoints[0]!.context)) return denied();
      let checked = Math.max(started.getTime(), ...checkpoints.map(check => check.checked_at.getTime()));
      let until = Math.min(...checkpoints.map(check => Date.parse(check.expires_at)));
      for (const checkpoint of checkpoints) {
        const at = checkpoint.recheck().getTime();
        until = Math.min(until, ...checkpoints.map(check => Date.parse(check.expires_at)));
        if (!Number.isFinite(at) || at < checked || !(at < until)) return denied();
        checked = at;
      }
      return Object.freeze({ kind: "remembered_completion_observed" as const,
        request_id: snapshot.request_id, request_digest: snapshot.request_digest,
        status, artifact, checked_at: new Date(checked).toISOString(), valid_until: new Date(until).toISOString() });
    },
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
