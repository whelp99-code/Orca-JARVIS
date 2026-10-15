import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCompanyClient } from "../../src/company-candidate-transport.js";
import { transitionRequestDigest } from "../../src/company-transition-read.js";
import { JarvisError } from "../../src/jarvis-error.js";
import {
  companyApproverFixture, companyApproverProcessorContext, startJarvisCompanyTestPeer,
} from "../fixtures/company-approver-execution.js";

const PROCESSOR_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEINyiCKGU4D8nebjrzYdRP/Z6Z+531zOwNB2AxeB3uGuw
-----END PRIVATE KEY-----
`;

describe("company transition receipt read", () => {
  it("matches the supplied accept and reject digest vectors", () => {
    const fixture = companyApproverFixture();
    expect(transitionRequestDigest("accept", fixture.transition_request_vectors.accept.arguments))
      .toBe(fixture.transition_request_vectors.accept.transition_request_digest);
    expect(transitionRequestDigest("reject", fixture.transition_request_vectors.reject.arguments))
      .toBe(fixture.transition_request_vectors.reject.transition_request_digest);
  });
  it("rejects extra transition fields, another request and the opposite approval decision", () => {
    const fixture = companyApproverFixture();
    const accept = fixture.transition_request_vectors.accept.arguments;
    expect(() => transitionRequestDigest("accept", { ...accept, extra: true })).toThrow("COMPANY_CONTRACT_INVALID");
    expect(() => transitionRequestDigest("accept", { ...accept, handoff_id: "another-request" })).toThrow("COMPANY_CONTRACT_INVALID");
    expect(() => transitionRequestDigest("accept", fixture.transition_request_vectors.reject.arguments)).toThrow("COMPANY_CONTRACT_INVALID");
  });

  it("refuses receipt lookup from the handoff role", () => {
    const root = mkdtempSync(join(tmpdir(), "jt-"));
    chmodSync(root, 0o700);
    try {
      const keyPath = join(root, "key.pem");
      const configPath = join(root, "client.json");
      writeFileSync(keyPath, PROCESSOR_PEM, { mode: 0o600 });
      writeFileSync(configPath, JSON.stringify({
        schema_version: 1, role: "handoff", context: companyApproverProcessorContext(),
        socket: join(root, "c.sock"), signing_key_id: "key:processor", signing_key_file: keyPath,
      }), { mode: 0o600 });
      const client = createCompanyClient(configPath, "handoff");
      expect(() => client.call("read_transition_receipt", { candidate_id: "candidate:1" })).toThrow(JarvisError);
      expect(() => client.call("read_transition_receipt", { candidate_id: "candidate:1" })).toThrow("COMPANY_CANDIDATE_OPERATION_DENIED");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a nonce echo mismatch at the signing client", async () => {
    const peer = await startJarvisCompanyTestPeer("bad-echo");
    const root = mkdtempSync(join(tmpdir(), "jt-"));
    chmodSync(root, 0o700);
    try {
      const keyPath = join(root, "key.pem");
      const configPath = join(root, "client.json");
      writeFileSync(keyPath, PROCESSOR_PEM, { mode: 0o600 });
      writeFileSync(configPath, JSON.stringify({
        schema_version: 1, role: "processor", context: companyApproverProcessorContext(),
        socket: peer.socketPath, signing_key_id: "key:processor", signing_key_file: keyPath,
      }), { mode: 0o600 });
      const client = createCompanyClient(configPath, "processor");
      const fixture = companyApproverFixture();
      const query = {
        candidate_id: fixture.command.target.candidate_id,
        handoff_id: fixture.command.request_id,
        operation: "accept",
        transition_request_digest: fixture.transition_request_vectors.accept.transition_request_digest,
        command_digest: fixture.command_digest,
        content_digest: fixture.command.target.content_digest,
        approval_policy_version: fixture.command.args.approval_policy_version,
        approval_binding_digest: fixture.command.args.approval_binding_digest,
      };
      await expect(client.call("read_transition_receipt", query, new Date("2026-10-15T00:05:00.000Z")))
        .rejects.toMatchObject({ code: "COMPANY_SB_RECEIPT_INVALID" });
      expect(peer.counts().accept).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      await peer.close();
    }
  });
});
