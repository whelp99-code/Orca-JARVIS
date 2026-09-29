import { createHash } from "node:crypto";
import { canonicalize } from "../canonical.js";
import { ControlPlane, type ControlCommandRequestInput } from "../control-plane.js";
import { JarvisError, type AuthorityDb } from "../db.js";
import { MemoryCorrectionSpool, type MemoryCorrectionPublication } from "../memory-correction-spool.js";
import { MemoryCandidateReviewSpool } from "../memory-candidate-review-spool.js";
import { registerMemoryCandidateSpoolRoots } from "../memory-surface-authority.js";
import { stageMemoryRememberDispatch } from "../memory-remember-dispatch.js";
import { readCandidateReview } from "./memory-candidate-review.js";
import type { DashboardSessionStore } from "./session.js";
import { MemoryTokenCache, type MemoryTokenAuthority, type MemoryTokenSelection } from "./memory-token-cache.js";
import { memoryReadHighWater } from "../memory-read-fence.js";
import { stageMemoryCandidateDecision,
  type MemoryCandidateDecisionInput } from "./memory-candidate-decision-staging.js";

const hash = (domain: string, value: unknown): string => `sha256:${createHash("sha256")
  .update(domain).update(canonicalize(value)).digest("hex")}`;
export type MemoryMutationOptions = { readonly authority: AuthorityDb; readonly tokens: MemoryTokenCache;
  readonly session: DashboardSessionStore; readonly clock: () => Date; readonly spool_root?: string;
  readonly candidate_review_spool_root?: string; readonly candidate_dispatch_spool_root?: string };
export class MemoryMutationService {
  private readonly control: ControlPlane; private readonly spool: MemoryCorrectionSpool | undefined;
  private readonly candidateReview: MemoryCandidateReviewSpool | undefined;
  constructor(private readonly options: MemoryMutationOptions) {
    this.control = new ControlPlane(options.authority);
    this.spool = options.spool_root === undefined ? undefined : new MemoryCorrectionSpool(options.spool_root);
    this.candidateReview = options.candidate_review_spool_root === undefined
      ? undefined : new MemoryCandidateReviewSpool(options.candidate_review_spool_root);
    registerMemoryCandidateSpoolRoots(options.authority, {
      review_root: options.candidate_review_spool_root,
      dispatch_root: options.candidate_dispatch_spool_root,
    });
  }
  async stageEffect(input: { readonly operation: "correct" | "forget" | "export"; readonly intent_id: string;
    readonly token: string; readonly record_revision: string; readonly payload: Readonly<Record<string, unknown>> }) {
    const authority = this.tokenAuthority();
    const selection = this.options.tokens.get(input.token, authority);
    if (selection === undefined || selection.record_revision !== input.record_revision) return undefined;
    const payloadDigest = hash("orca-jarvis/memory-ui-effect-payload/v1\0", input.payload);
    const recordMembership = this.options.tokens.membership("record",
      `${selection.record_id}\0${selection.record_digest}`);
    const targetVersion = hash("orca-jarvis/memory-ui-target-version/v1\0", {
      provider_instance_id: selection.provider_instance_id, generation_id: selection.generation_id,
      generation_manifest_digest: selection.generation_manifest_digest, record_membership_hmac: recordMembership });
    const expectedPrior = hash("orca-jarvis/memory-ui-expected-prior/v1\0", recordMembership);
    const targetManifest = hash("orca-jarvis/memory-ui-target-manifest/v1\0", { targetVersion,
      generation_id: selection.generation_id, generation_manifest_digest: selection.generation_manifest_digest });
    const scopeDigest = hash("orca-jarvis/memory-ui-scope/v1\0", { targetVersion, max_records: 1 });
    const policyDigest = hash("orca-jarvis/memory-ui-policy/v1\0", { schema_version: 1 });
    const family = hash("orca-jarvis/memory-ui-effect-family/v1\0", { operation: input.operation,
      target_version_digest: targetVersion, expected_prior_digest: expectedPrior,
      policy_digest: policyDigest, payload_digest: payloadDigest });
    const prior = this.options.authority.db.prepare(
      `SELECT attempt_id,attempt_generation,control_request_id,state FROM memory_surface_effect_attempts
       WHERE family_digest=? ORDER BY attempt_generation DESC LIMIT 1`,
    ).get(family) as { readonly attempt_id: string; readonly attempt_generation: number;
      readonly control_request_id: string; readonly state: string } | undefined;
    if (prior !== undefined && ["staged", "approved", "claimed", "reconciling"].includes(prior.state)) {
      return this.control.get(prior.control_request_id);
    }
    if (prior !== undefined && prior.state !== "receipt_rejected" && prior.state !== "expired") return undefined;
    const at = this.options.clock(); const expires = new Date(at.getTime() + 15 * 60_000);
    const generation = (prior?.attempt_generation ?? 0) + 1;
    const predecessor = prior?.attempt_id ?? null;
    const freshSelection = hash("orca-jarvis/memory-ui-fresh-selection/v1\0", {
      family_digest: family, record_revision: input.record_revision, privacy_epoch: authority.privacy_epoch,
      issued_at: selection.issued_at, generation_id: selection.generation_id,
      tombstone_sequence: selection.tombstone_sequence, tombstone_set_root: selection.tombstone_set_root });
    const attempt = `memui:effect-attempt:v1:${hash("orca-jarvis/memory-ui-effect-attempt/v1\0", {
      family_digest: family, attempt_generation: generation, fresh_selection_digest: freshSelection,
      predecessor_attempt_id: predecessor }).slice(7)}`;
    const requestId = `memui:control:v1:${hash("orca-jarvis/memory-ui-control-attempt/v1\0", attempt).slice(7)}`;
    const publication = input.operation === "correct" && this.spool !== undefined
      ? await this.publishCorrection(requestId, input, targetManifest, scopeDigest,
        expectedPrior, payloadDigest, at, expires) : undefined;
    try {
      return this.options.authority.db.transaction(() => {
        this.insertTarget(selection, { targetVersion, expectedPrior, targetManifest, scopeDigest,
          recordMembership, privacyEpoch: authority.privacy_epoch, at });
        this.options.authority.db.prepare(
          `INSERT OR IGNORE INTO memory_surface_semantic_families(family_digest,operation,target_version_digest,
           expected_prior_digest,policy_digest,payload_digest,created_at) VALUES(?,?,?,?,?,?,?)`,
        ).run(family, input.operation, targetVersion, expectedPrior, policyDigest, payloadDigest, at.toISOString());
        const command = this.control.stage(this.command({ requestId, attempt, family, targetVersion,
          expectedPrior, targetManifest, scopeDigest, payloadDigest, policyDigest, selection,
          privacyEpoch: authority.privacy_epoch, input, at, expires }), at);
        this.options.authority.db.prepare(
          `INSERT INTO memory_surface_effect_attempts(attempt_id,family_digest,attempt_generation,
           fresh_selection_digest,predecessor_attempt_id,control_request_id,state,created_at,updated_at)
           VALUES(?,?,?,?,?,?,'staged',?,?)`,
        ).run(attempt, family, generation, freshSelection, predecessor,
          requestId, at.toISOString(), at.toISOString());
        if (publication !== undefined) this.insertCorrectionClaim(requestId, input.intent_id,
          payloadDigest, targetManifest, scopeDigest, expectedPrior, publication, at, expires);
        return command;
      }).immediate();
    } catch (error) {
      if (publication !== undefined && this.spool !== undefined) await this.spool.compensate(publication);
      if (error instanceof JarvisError && error.code === "MEMORY_INTENT_EXPIRED") throw error;
      throw error;
    }
  }

  stageCandidateDecision(input: MemoryCandidateDecisionInput):
  import("../control-plane.js").StoredControlCommand | undefined {
    return stageMemoryCandidateDecision({ options: this.options, control: this.control,
      review: this.candidateReview, correctionSelection: (selection, epoch) =>
        this.correctionSelection(selection, epoch),
      insertTarget: (selection, target) => { this.insertTarget(selection, target); } }, input);
  }
  stageReviewedCandidateDecision(input: MemoryCandidateDecisionInput, reviewDigest: string) {
    const review = readCandidateReview(this.options.authority, this.options.candidate_review_spool_root,
      input.candidate_id, this.options.clock());
    if (review === undefined || review.review_digest !== reviewDigest) {
      throw new JarvisError("MEMORY_SELECTION_STALE");
    }
    return this.stageCandidateDecision(input);
  }
  stageCandidateDispatch(candidateId: string) {
    return stageMemoryRememberDispatch(this.options.authority, candidateId, this.options.clock(), {
      candidate_review_spool_root: this.options.candidate_review_spool_root,
      candidate_dispatch_spool_root: this.options.candidate_dispatch_spool_root });
  }
  correctionSelection(
    input: { readonly token?: string; readonly record_revision?: string },
    privacyEpoch: number,
  ): { readonly targetVersion: string; readonly expectedPrior: string; readonly targetManifest: string;
    readonly scopeDigest: string; readonly recordMembership: string;
    readonly expectedPriorRecord: Readonly<Record<string, string>>;
    readonly selection: MemoryTokenSelection } {
    if (input.token === undefined || input.record_revision === undefined) {
      throw new JarvisError("MEMORY_SELECTION_STALE");
    }
    const authority = this.tokenAuthority(privacyEpoch);
    const selection = this.options.tokens.get(input.token, authority);
    if (selection === undefined || selection.record_revision !== input.record_revision) {
      throw new JarvisError("MEMORY_SELECTION_STALE");
    }
    const recordMembership = this.options.tokens.membership("record",
      `${selection.record_id}\0${selection.record_digest}`);
    const targetVersion = hash("orca-jarvis/memory-ui-target-version/v1\0", {
      provider_instance_id: selection.provider_instance_id, generation_id: selection.generation_id,
      generation_manifest_digest: selection.generation_manifest_digest, record_membership_hmac: recordMembership,
    });
    const expectedPrior = hash("orca-jarvis/memory-ui-expected-prior/v1\0", recordMembership);
    const expectedPriorRecord = {
      source_id: selection.page_id,
      source_version: `git:${selection.generation_manifest_digest.slice(7, 47)}`,
      source_digest: `sha256:${selection.content_identity_full}`,
    };
    const targetManifest = hash("orca-jarvis/memory-ui-target-manifest/v1\0", {
      targetVersion, generation_id: selection.generation_id,
      generation_manifest_digest: selection.generation_manifest_digest,
    });
    const scopeDigest = hash("orca-jarvis/memory-ui-scope/v1\0", { targetVersion, max_records: 1 });
    return { targetVersion, expectedPrior, targetManifest, scopeDigest, recordMembership,
      expectedPriorRecord, selection };
  }
  private tokenAuthority(privacyEpoch?: number): MemoryTokenAuthority & { readonly privacy_epoch: number } {
    const row = this.options.authority.db.prepare(
      `SELECT privacy_epoch,policy_digest FROM memory_surface_authority WHERE singleton_id=1`,
    ).get() as { readonly privacy_epoch: number; readonly policy_digest: string | null };
    const high = memoryReadHighWater(this.options.authority);
    const sessionId = this.options.session.authenticatedSessionId();
    return {
      owner_session_id: sessionId, session_incarnation: sessionId,
      privacy_epoch: privacyEpoch ?? row.privacy_epoch,
      policy_digest: row.policy_digest ?? undefined,
      tombstone_sequence: high.sequence,
      tombstone_set_root: high.set_root,
    };
  }

  insertTarget(selection: MemoryTokenSelection, input: { readonly targetVersion: string;
    readonly expectedPrior: string; readonly targetManifest: string; readonly scopeDigest: string;
    readonly recordMembership: string; readonly privacyEpoch: number; readonly at: Date }): void {
    const source = this.options.tokens.membership("source", selection.source_identity_full);
    const content = this.options.tokens.membership("content", selection.content_identity_full);
    const citation = this.options.tokens.membership("citation", selection.citation_identity_full);
    const membership = hash("orca-jarvis/memory-ui-membership/v1\0", { source, content, citation,
      record: input.recordMembership });
    this.options.authority.db.prepare(
      `INSERT OR IGNORE INTO memory_surface_target_versions(target_version_digest,provider_instance_id,
       generation_id,generation_manifest_digest,expected_prior_digest,target_manifest_digest,scope_digest,
       source_membership_hmac,content_membership_hmac,citation_membership_hmac,record_membership_hmac,
       membership_digest,suppression_epoch,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(input.targetVersion, selection.provider_instance_id, selection.generation_id,
      selection.generation_manifest_digest, input.expectedPrior, input.targetManifest, input.scopeDigest,
      source, content, citation, input.recordMembership, membership, input.privacyEpoch, input.at.toISOString());
  }
  private command(input: { readonly requestId: string; readonly attempt: string; readonly family: string;
    readonly targetVersion: string; readonly expectedPrior: string; readonly targetManifest: string;
    readonly scopeDigest: string; readonly payloadDigest: string; readonly policyDigest: string;
    readonly selection: MemoryTokenSelection; readonly privacyEpoch: number;
    readonly input: { readonly operation: "correct" | "forget" | "export";
      readonly intent_id: string; readonly payload: Readonly<Record<string, unknown>> };
    readonly at: Date; readonly expires: Date }): ControlCommandRequestInput {
    const action = input.input.operation === "correct" ? "memory.outbox.dispatch"
      : input.input.operation === "forget" ? "memory.delete" : "memory.export";
    return { schema_version: 1, request_id: input.requestId, action, action_level: 3,
      target: { record_selection_digest: input.targetVersion,
        provider_instance_id: input.selection.provider_instance_id,
        operation: input.input.operation }, args: { schema_version: 1, intent_digest: input.input.intent_id,
        semantic_digest: input.family, policy_digest: input.policyDigest,
        expected_prior_digest: input.expectedPrior, target_manifest_digest: input.targetManifest,
        scope_digest: input.scopeDigest, target_version_digest: input.targetVersion,
        suppression_epoch: input.privacyEpoch, selection_expires_at: input.expires.toISOString(),
        payload: { kind: input.input.operation, payload_digest: input.payloadDigest } }, reversible: false,
      requested_by: "principal:owner", requested_at: input.at.toISOString(),
      expires_at: input.expires.toISOString(), nonce: input.attempt };
  }
  private async publishCorrection(requestId: string, input: { readonly intent_id: string;
    readonly payload: Readonly<Record<string, unknown>> }, target: string, scope: string, prior: string,
  content: string, at: Date, expires: Date): Promise<MemoryCorrectionPublication | undefined> {
    const replacement = input.payload["replacement"];
    if (typeof replacement !== "string" || this.spool === undefined) return undefined;
    return this.spool.publish({ control_request_id: requestId,
      intent_digest: input.intent_id, semantic_digest: content, target_manifest_digest: target,
      scope_digest: scope, expected_prior_digest: prior, content_digest: content,
      replacement, created_at: at.toISOString(), expires_at: expires.toISOString() });
  }
  private insertCorrectionClaim(requestId: string, intentId: string, content: string,
    target: string, scope: string, prior: string, publication: MemoryCorrectionPublication,
    at: Date, expires: Date): void {
    this.options.authority.db.prepare(
      `INSERT INTO memory_correction_spool_claims(control_request_id,intent_digest,semantic_digest,
       target_manifest_digest,scope_digest,expected_prior_digest,content_digest,content_bytes,
       spool_digest,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,'published',?,?)`,
    ).run(requestId, intentId, content, target, scope, prior, content,
      publication.content_bytes, publication.digest, at.toISOString(), expires.toISOString());
  }
}
