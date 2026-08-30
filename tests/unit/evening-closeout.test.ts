import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateEveningCloseout, parseEveningCloseoutInput, verifyEveningCloseout } from "../../src/index.js";

const digest = `sha256:${"a".repeat(64)}`;
const citation = { source_id: "linux-loop", evidence_id: "verify-1" };
const base = (outcome: "completed" | "worker_done" = "completed", reason: string | null = null,
  verification: { readonly outcome: "passed" | "missing"; readonly evidence_id: string | null; readonly evidence_digest: string | null }
    = { outcome: "passed", evidence_id: "verify-1", evidence_digest: digest }) => ({
  schema_version: 1, run_id: "dlr:evening", correlation_id: "daily:2026-08-30:abcdef", local_date: "2026-08-30",
  generated_at: "2026-08-30T12:00:00.000Z", source_readiness: "ready", source_omissions: [],
  records: [{ item_id: "item-1", outcome, reason, copy: "Shipped change", citations: [citation],
    observed_at: "2026-08-30T11:00:00.000Z", fresh_until: "2026-08-30T13:00:00.000Z", trust: "trusted", verification }],
  decisions: [{ decision_id: "decision-1", state: "owner_required", copy: "Choose release window", citations: [citation] }],
  memory_candidates: [{ candidate_id: "candidate-1", eligible: true, citations: [citation] }],
  tomorrow_actions: [{ action_id: "action-1", rank: 1, disposition: "executable", citations: [citation] }],
  risks: [{ risk_id: "risk-1", copy: "Release window unresolved", citations: [citation] }], limits: null,
});

describe("evening closeout", () => {
  it("Given verified cited facts When generated Then emits a verifiable deterministic artifact", () => {
    const keys = generateKeyPairSync("ed25519");
    const parsed = parseEveningCloseoutInput(base());
    const artifact = generateEveningCloseout(parsed, { key_id: "closeout-test", private_key: keys.privateKey, clock: () => new Date("2026-08-30T12:00:00.000Z") });
    expect(artifact.verified_completions).toHaveLength(1);
    expect(artifact.tomorrow_first_action).toEqual({ action_id: "action-1", citations: [citation] });
    expect(verifyEveningCloseout(artifact, { key_id: "closeout-test", public_key: keys.publicKey })).toBe(true);
    expect(generateEveningCloseout(parseEveningCloseoutInput({ ...base(), records: [...base().records].reverse() }),
      { key_id: "closeout-test", private_key: keys.privateKey, clock: () => new Date("2026-08-30T12:00:00.000Z") })).toEqual(artifact);
  });

  it("Given done prose without verification When generated Then remains uncertain", () => {
    const keys = generateKeyPairSync("ed25519");
    const artifact = generateEveningCloseout(parseEveningCloseoutInput(base("worker_done", "EVIDENCE_MISSING",
      { outcome: "missing", evidence_id: null, evidence_digest: null })), { key_id: "closeout-test", private_key: keys.privateKey, clock: () => new Date("2026-08-30T12:00:00.000Z") });
    expect(artifact.verified_completions).toEqual([]);
    expect(artifact.open_or_failed[0]?.reason).toBe("EVIDENCE_MISSING");
  });

  it("Given no data When generated Then does not invent continuity", () => {
    const keys = generateKeyPairSync("ed25519");
    const artifact = generateEveningCloseout(parseEveningCloseoutInput({ ...base(), source_readiness: "no_data",
      records: [], decisions: [], memory_candidates: [], tomorrow_actions: [], risks: [] }),
      { key_id: "closeout-test", private_key: keys.privateKey, clock: () => new Date("2026-08-30T12:00:00.000Z") });
    expect(artifact.tomorrow_first_action).toBe("none");
    expect(artifact.verified_completions).toEqual([]);
  });

  it("Given hostile or private input When parsed Then fails closed without executing accessors", () => {
    let invoked = 0; const hostile = Object.defineProperty({}, "schema_version", { enumerable: true, get: () => { invoked += 1; return 1; } });
    expect(() => parseEveningCloseoutInput(hostile)).toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
    expect(() => parseEveningCloseoutInput({ ...base(), risks: [{ risk_id: "risk", copy: "/home/alice/.ssh/id_ed25519", citations: [citation] }] }))
      .toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
    expect(invoked).toBe(0);
  });
});
