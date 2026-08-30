import { describe, expect, it } from "vitest";
import {
  generateEveningCloseout,
  parseEveningCloseoutInput,
  verifyEveningCloseoutArtifact,
} from "../../src/index.js";
import {
  closeoutInput,
  failedVerificationRecord,
  priority,
  signer,
  trustedCloseoutKey,
  workerRecord,
} from "../fixtures/evening-closeout.js";

const generated = () => generateEveningCloseout(parseEveningCloseoutInput(closeoutInput()), signer());

describe("evening closeout signed continuity", () => {
  it("Given independently verified evidence When generated Then emits a closed signed artifact", () => {
    const artifact = generated();
    expect(artifact.verified_completions).toHaveLength(1);
    expect(artifact.verified_completions[0]?.verification?.verdict).toBe("passed");
    expect(artifact.envelope.public_key_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyEveningCloseoutArtifact(artifact, trustedCloseoutKey)).toEqual(artifact);
  });

  it("Given an envelope mutation or unknown field When verified Then rejects the whole artifact", () => {
    const artifact = generated();
    const mutations: readonly unknown[] = [
      { ...artifact, unsigned_unknown: "rejected" },
      { ...artifact, canonical_digest: `sha256:${"0".repeat(64)}` },
      { ...artifact, envelope: { ...artifact.envelope, schema_version: 2 } },
      { ...artifact, envelope: { ...artifact.envelope, algorithm: "RSA" } },
      { ...artifact, envelope: { ...artifact.envelope, key_id: "Wrong_Key" } },
      { ...artifact, envelope: { ...artifact.envelope, public_key_spki: "AA" } },
      { ...artifact, envelope: { ...artifact.envelope, public_key_fingerprint: `sha256:${"0".repeat(64)}` } },
      { ...artifact, envelope: { ...artifact.envelope, signature: "AA" } },
    ];
    for (const mutation of mutations) {
      expect(() => verifyEveningCloseoutArtifact(mutation, trustedCloseoutKey))
        .toThrow("EVENING_CLOSEOUT_INTEGRITY_FAILURE");
    }
  });

  it("Given a malformed signing handle When generated Then rejects before emission", () => {
    const input = parseEveningCloseoutInput(closeoutInput());
    const valid = signer();
    expect(() => generateEveningCloseout(input, {
      ...valid,
      identity: Object.assign({}, valid.identity, { unknown: "field" }),
    })).toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
    expect(() => generateEveningCloseout(input, {
      ...valid,
      sign: () => new Uint8Array(63),
    })).toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
  });

  it("Given prose-only or failed verification When generated Then keeps exact uncertain reasons", () => {
    const input = closeoutInput();
    const artifact = generateEveningCloseout(
      parseEveningCloseoutInput({
        ...input,
        records: [workerRecord(), failedVerificationRecord()],
        memory_candidates: [],
      }),
      signer(),
    );
    expect(artifact.verified_completions).toEqual([]);
    expect(artifact.open_or_failed.map(item => item.reason)).toEqual([
      "VERIFICATION_FAILED",
      "EVIDENCE_MISSING",
    ]);
  });

  it("Given mismatched completion evidence When parsed Then cannot promote the claim", () => {
    const input = closeoutInput();
    const source = input.records[0];
    expect(source).toBeDefined();
    if (source === undefined) return;
    const mismatched = {
      ...source,
      citations: [{ ...source.citations[0], evidence_id: "different-evidence" }],
    };
    expect(() => parseEveningCloseoutInput({ ...input, records: [mismatched] }))
      .toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
  });

  it("Given duplicate identities across sections When parsed Then rejects collisions", () => {
    const input = closeoutInput();
    expect(() => parseEveningCloseoutInput({ ...input, risks: [...input.risks, input.risks[0]] }))
      .toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
    expect(() => parseEveningCloseoutInput({
      ...input,
      decisions: [{ ...input.decisions[0], decision_id: input.records[0]?.item_id }],
    })).toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
  });

  it("Given Task17 candidates When reordered Then uses the six-field tuple and stable identity", () => {
    const input = closeoutInput();
    const action = input.tomorrow_actions[0];
    expect(action).toBeDefined();
    if (action === undefined) return;
    const internal = {
      ...action,
      action_id: "internal",
      priority: priority("stable-z", "internal"),
      citations: [{ ...action.citations[0], citation_id: "citation-internal", source_id: "source-internal" }],
    };
    const critical = {
      ...action,
      action_id: "critical",
      priority: priority("stable-a", "customer_critical"),
      citations: [{ ...action.citations[0], citation_id: "citation-critical", source_id: "source-critical" }],
    };
    const first = generateEveningCloseout(
      parseEveningCloseoutInput({ ...input, tomorrow_actions: [internal, critical] }),
      signer(),
    );
    const reordered = generateEveningCloseout(
      parseEveningCloseoutInput({ ...input, tomorrow_actions: [critical, internal] }),
      signer(),
    );
    expect(first.tomorrow_first_action).toEqual(reordered.tomorrow_first_action);
    expect(first.tomorrow_first_action).toMatchObject({ action_id: "critical" });
  });

  it("Given hostile Unicode or private metadata When parsed Then rejects before emission", () => {
    const input = closeoutInput();
    expect(() => parseEveningCloseoutInput({ ...input, run_id: "bad\ud800" }))
      .toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
    expect(() => parseEveningCloseoutInput({ ...input, run_id: "bad\udc00" }))
      .toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
    expect(() => parseEveningCloseoutInput({ ...input, source_omissions: ["token=private"] }))
      .toThrow("EVENING_CLOSEOUT_INPUT_INVALID");
  });
});
