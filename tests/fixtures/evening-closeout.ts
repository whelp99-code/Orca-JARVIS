import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { canonicalize } from "../../src/canonical.js";

export const CLOSEOUT_AT = "2026-08-30T12:00:00.000Z";
export const digest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
export const closeoutKeys = generateKeyPairSync("ed25519");
export const verifierKeys = generateKeyPairSync("ed25519");
const spki = (key: KeyObject): string => key.export({ type: "spki", format: "der" }).toString("base64url");
const fingerprint = (value: string): string =>
  `sha256:${createHash("sha256").update(Buffer.from(value, "base64url")).digest("hex")}`;
export const signer = (clock = CLOSEOUT_AT) => ({
  identity: {
    schema_version: 1 as const,
    algorithm: "Ed25519" as const,
    key_id: "closeout-key-v1",
    public_key_spki: spki(closeoutKeys.publicKey),
    public_key_fingerprint: fingerprint(spki(closeoutKeys.publicKey)),
  },
  clock: () => new Date(clock),
  sign: (bytes: Uint8Array) => sign(null, bytes, closeoutKeys.privateKey),
});
export const trustedCloseoutKey = {
  key_id: "closeout-key-v1",
  public_key_spki: spki(closeoutKeys.publicKey),
};
const citation = (suffix: string) => ({
  citation_id: `citation-${suffix}`,
  source_id: `source-${suffix}`,
  evidence_id: `completion-${suffix}`,
});
function verification(
  suffix: string,
  verdict: "passed" | "failed" = "passed",
  verifiedAt = "2026-08-30T11:01:00.000Z",
) {
  const core = {
    schema_version: 1 as const,
    evidence_id: `verification-${suffix}`,
    verifier_id: "independent-verifier",
    verdict,
    machine_outcome: verdict === "passed" ? "succeeded" as const : "failed" as const,
    artifact_id: `verification-artifact-${suffix}`,
    artifact_digest: digest({ artifact: suffix }),
    completion_evidence_id: `completion-${suffix}`,
    completion_evidence_digest: digest({ completion: suffix }),
    observed_at: "2026-08-30T11:00:00.000Z",
    verified_at: verifiedAt,
    key_id: "verification-key-v1",
    public_key_spki: spki(verifierKeys.publicKey),
    public_key_fingerprint: fingerprint(spki(verifierKeys.publicKey)),
  };
  return {
    ...core,
    canonical_digest: digest(core),
    signature: sign(
      null,
      Buffer.from(`orca-jarvis/evening-closeout-verification/v1\0${canonicalize({ ...core, canonical_digest: digest(core) })}`),
      verifierKeys.privateKey,
    ).toString("base64url"),
  };
}
function record(suffix: string, outcome: "completed" | "worker_done" = "completed") {
  const core = {
    item_id: `item-${suffix}`,
    outcome,
    reason: outcome === "completed" ? null : "EVIDENCE_MISSING",
    copy: `Completed ${suffix}`,
    citations: [citation(suffix)],
    observed_at: "2026-08-30T11:00:00.000Z",
    fresh_until: "2026-08-30T13:00:00.000Z",
    trust: "trusted" as const,
    verification: outcome === "completed" ? verification(suffix) : null,
  };
  return { ...core, record_digest: digest(core) };
}
export const priority = (stableIdentity: string, customerImpact = "customer_critical") => ({
  owner_safety_gate: "pass",
  customer_impact: customerImpact,
  deadline_bucket: "today",
  dependency_blocking: "blocks_customer",
  irreversible_risk: "low",
  effort_cost: "low",
  stable_identity: stableIdentity,
});
export function closeoutInput() {
  return {
    schema_version: 1,
    run_id: "dlr:evening",
    correlation_id: "daily:2026-08-30:abcdef",
    local_date: "2026-08-30",
    generated_at: CLOSEOUT_AT,
    source_readiness: "ready",
    source_omissions: [],
    trusted_verifier: {
      verifier_id: "independent-verifier",
      key_id: "verification-key-v1",
      public_key_fingerprint: fingerprint(spki(verifierKeys.publicKey)),
    },
    records: [record("one")],
    decisions: [{
      decision_id: "decision-one", state: "owner_required", copy: "Choose release window",
      citations: [{ ...citation("decision"), evidence_id: "decision-evidence-one" }],
    }],
    memory_candidates: [{
      candidate_id: "candidate-one", verification_evidence_id: "verification-one",
      citations: [{ ...citation("candidate"), evidence_id: "verification-one" }],
    }],
    tomorrow_actions: [{
      action_id: "action-one", disposition: "executable", priority: priority("stable-one"),
      observed_at: "2026-08-30T11:00:00.000Z", fresh_until: "2026-08-30T13:00:00.000Z",
      trust: "trusted", actionable: true,
      citations: [{ ...citation("action"), evidence_id: "action-evidence-one" }],
    }],
    risks: [{
      risk_id: "risk-one", copy: "Release window unresolved",
      citations: [{ ...citation("risk"), evidence_id: "risk-evidence-one" }],
    }],
    limits: null,
  };
}
export const workerRecord = () => record("worker", "worker_done");
export const additionalVerifiedRecord = () => record("two");
export const futureVerificationRecord = () => {
  const value = record("future");
  const payload = {
    item_id: value.item_id,
    outcome: value.outcome,
    reason: value.reason,
    copy: value.copy,
    citations: value.citations,
    observed_at: value.observed_at,
    fresh_until: value.fresh_until,
    trust: value.trust,
    verification: verification("future", "passed", "2026-08-30T12:01:00.000Z"),
  };
  return { ...payload, record_digest: digest(payload) };
};
export const failedVerificationRecord = () => {
  const value = record("failed");
  const payload = {
    item_id: value.item_id,
    outcome: value.outcome,
    reason: value.reason,
    copy: value.copy,
    citations: value.citations,
    observed_at: value.observed_at,
    fresh_until: value.fresh_until,
    trust: value.trust,
    verification: verification("failed", "failed"),
  };
  return { ...payload, record_digest: digest(payload) };
};
