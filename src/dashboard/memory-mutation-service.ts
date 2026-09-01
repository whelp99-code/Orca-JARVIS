import { createHash } from "node:crypto";
import { canonicalize } from "../canonical.js";
import { ControlPlane, type ControlCommandRequestInput } from "../control-plane.js";
import type { AuthorityDb } from "../db.js";
import { MemoryCorrectionSpool } from "../memory-correction-spool.js";
import type { DashboardSessionStore } from "./session.js";
import { MemoryTokenCache } from "./memory-token-cache.js";

const hash = (domain: string, value: unknown): string => `sha256:${createHash("sha256")
  .update(domain).update(canonicalize(value)).digest("hex")}`;
export type MemoryMutationOptions = { readonly authority: AuthorityDb; readonly tokens: MemoryTokenCache;
  readonly session: DashboardSessionStore; readonly clock: () => Date; readonly spool_root?: string };
export class MemoryMutationService {
  private readonly control: ControlPlane; private readonly spool: MemoryCorrectionSpool | undefined;
  constructor(private readonly options: MemoryMutationOptions) {
    this.control = new ControlPlane(options.authority);
    this.spool = options.spool_root === undefined ? undefined : new MemoryCorrectionSpool(options.spool_root);
  }
  async stageEffect(input: { readonly operation: "correct" | "forget" | "export"; readonly intent_id: string;
    readonly token: string; readonly record_revision: string; readonly payload: Readonly<Record<string, unknown>> }) {
    const authority = this.options.authority.db.prepare(
      "SELECT privacy_epoch FROM memory_surface_authority WHERE singleton_id=1",
    ).get() as { readonly privacy_epoch: number };
    const selection = this.options.tokens.get(input.token, this.options.session.authenticatedSessionId(), authority.privacy_epoch);
    if (selection === undefined) return undefined;
    const payloadDigest = hash("orca-jarvis/memory-ui-effect-payload/v1\0", input.payload);
    const targetVersion = hash("orca-jarvis/memory-ui-target-version/v1\0", {
      record_id: selection.record_id, record_digest: selection.record_digest });
    const expectedPrior = hash("orca-jarvis/memory-ui-expected-prior/v1\0", selection.record_digest);
    const policyDigest = hash("orca-jarvis/memory-ui-policy/v1\0", { schema_version: 1 });
    const family = hash("orca-jarvis/memory-ui-effect-family/v1\0", { operation: input.operation,
      target_version_digest: targetVersion, expected_prior_digest: expectedPrior,
      policy_digest: policyDigest, payload_digest: payloadDigest });
    const existing = this.options.authority.db.prepare(
      `SELECT a.control_request_id FROM memory_surface_effect_attempts a
       WHERE a.family_digest=? AND a.state IN ('staged','approved','claimed','reconciling')`,
    ).get(family) as { readonly control_request_id: string } | undefined;
    if (existing !== undefined) return this.control.list().find(item => item.request_id === existing.control_request_id);
    const at = this.options.clock(); const expires = new Date(at.getTime() + 15 * 60_000);
    const requestId = `memui:control:v1:${family.slice(7)}`;
    const attempt = `memui:effect-attempt:v1:${hash("orca-jarvis/memory-ui-effect-attempt/v1\0", {
      family_digest: family, attempt_generation: 1, fresh_selection_digest: input.record_revision,
      predecessor_attempt_id: null }).slice(7)}`;
    this.options.authority.db.prepare(
      `INSERT OR IGNORE INTO memory_surface_target_versions(target_version_digest,provider_instance_id,
       generation_id,generation_manifest_digest,expected_prior_digest,target_manifest_digest,scope_digest,
       source_membership_hmac,content_membership_hmac,citation_membership_hmac,record_membership_hmac,
       membership_digest,suppression_epoch,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    ).run(targetVersion, "provider:token", "generation:token", hash("generation", selection.page_id),
      expectedPrior, hash("target", targetVersion), hash("scope", targetVersion), hash("source", targetVersion),
      hash("content", targetVersion), hash("citation", targetVersion), hash("record", targetVersion),
      hash("membership", targetVersion), at.toISOString());
    this.options.authority.db.prepare(
      `INSERT INTO memory_surface_semantic_families(family_digest,operation,target_version_digest,
       expected_prior_digest,policy_digest,payload_digest,created_at) VALUES(?,?,?,?,?,?,?)`,
    ).run(family, input.operation, targetVersion, expectedPrior, policyDigest, payloadDigest, at.toISOString());
    const command = this.control.stage(this.command({ requestId, attempt, family, targetVersion,
      expectedPrior, payloadDigest, policyDigest, input, at, expires }), at);
    this.options.authority.db.prepare(
      `INSERT INTO memory_surface_effect_attempts(attempt_id,family_digest,attempt_generation,
       fresh_selection_digest,predecessor_attempt_id,control_request_id,state,created_at,updated_at)
       VALUES(?,?,1,?,NULL,?,'staged',?,?)`,
    ).run(attempt, family, input.record_revision, requestId, at.toISOString(), at.toISOString());
    if (input.operation === "correct" && this.spool !== undefined) await this.publishCorrection(command.request_id,
      input, targetVersion, expectedPrior, payloadDigest, at, expires);
    return command;
  }
  private command(input: { readonly requestId: string; readonly attempt: string; readonly family: string;
    readonly targetVersion: string; readonly expectedPrior: string; readonly payloadDigest: string;
    readonly policyDigest: string; readonly input: { readonly operation: "correct" | "forget" | "export";
      readonly intent_id: string; readonly payload: Readonly<Record<string, unknown>> };
    readonly at: Date; readonly expires: Date }): ControlCommandRequestInput {
    const action = input.input.operation === "correct" ? "memory.outbox.dispatch"
      : input.input.operation === "forget" ? "memory.delete" : "memory.export";
    return { schema_version: 1, request_id: input.requestId, action, action_level: 3,
      target: { record_selection_digest: input.targetVersion, provider_instance_id: "provider:token",
        operation: input.input.operation }, args: { schema_version: 1, intent_digest: input.input.intent_id,
        semantic_digest: input.family, policy_digest: input.policyDigest,
        expected_prior_digest: input.expectedPrior, target_manifest_digest: hash("target", input.targetVersion),
        scope_digest: hash("scope", input.targetVersion), target_version_digest: input.targetVersion,
        suppression_epoch: 0, selection_expires_at: input.expires.toISOString(),
        payload: { kind: input.input.operation, payload_digest: input.payloadDigest } }, reversible: false,
      requested_by: "principal:owner", requested_at: input.at.toISOString(),
      expires_at: input.expires.toISOString(), nonce: input.attempt };
  }
  private async publishCorrection(requestId: string, input: { readonly intent_id: string;
    readonly payload: Readonly<Record<string, unknown>> }, target: string, prior: string,
  content: string, at: Date, expires: Date): Promise<void> {
    const replacement = input.payload["replacement"];
    if (typeof replacement !== "string" || this.spool === undefined) return;
    const published = await this.spool.publish({ control_request_id: requestId,
      intent_digest: input.intent_id, semantic_digest: content, target_manifest_digest: hash("target", target),
      scope_digest: hash("scope", target), expected_prior_digest: prior, content_digest: content,
      replacement, created_at: at.toISOString(), expires_at: expires.toISOString() });
    this.options.authority.db.prepare(
      `INSERT INTO memory_correction_spool_claims(control_request_id,intent_digest,semantic_digest,
       target_manifest_digest,scope_digest,expected_prior_digest,content_digest,content_bytes,
       spool_digest,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,'published',?,?)`,
    ).run(requestId, input.intent_id, content, hash("target", target), hash("scope", target), prior,
      content, published.content_bytes, published.digest, at.toISOString(), expires.toISOString());
  }
}
