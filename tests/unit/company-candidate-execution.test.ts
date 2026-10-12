import { createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CompanyCandidateExecutor, type CompanyCompletionVerifier } from "../../src/company-candidate-execution.js";
import { importCompanyPage } from "../../src/company-candidate-import.js";
import { ControlPlane } from "../../src/control-plane.js";
import { COMPANY_CONTEXT, COMPANY_NOW, COMPANY_PROCESSOR_KEY, COMPANY_OWNER_KEY, companyApproval,
  companyClient, companyDatabase, companyPage, companyProposal, companyReceipt, companyState } from "../fixtures/company-candidate.js";

const completed: CompanyCompletionVerifier = {
  async verify(command, acceptance) {
    return { schema_version: 1, state: "completed", request_id: command.request_id,
      command_digest: companyProposal(command.target.candidate_id).command_digest,
      candidate_id: command.target.candidate_id, content_digest: command.target.content_digest,
      acceptance_receipt_digest: acceptance.receipt_digest, effect_digest: `sha256:${"d".repeat(64)}` };
  },
};

async function approved(decision: "approve" | "reject" = "approve") {
  const live = await companyDatabase(); const proposal = companyProposal();
  importCompanyPage(live.db, companyPage(proposal), COMPANY_CONTEXT, COMPANY_NOW);
  new ControlPlane(live.db).decide(companyApproval(proposal, decision), COMPANY_NOW);
  return { ...live, proposal };
}

describe("restricted company candidate executor", () => {
  it("forwards the original signed decision and keeps acceptance separate from completion", async () => {
    const live = await approved(); const operations: string[] = [];
    try {
      const client = { ...companyClient(async (operation, args) => {
        operations.push(operation);
        expect(args.approval).toEqual(companyApproval(live.proposal));
        return companyReceipt(live.proposal.command.request_id, "accept");
      }), context: { ...COMPANY_CONTEXT, agent_id: "agent:separate-processor", session_id: "separate-processor-session" } };
      const result = await new CompanyCandidateExecutor(live.db, client, undefined, () => COMPANY_NOW)
        .execute(live.proposal.command.request_id);
      expect(result.state).toBe("accepted");
      expect(operations).toEqual(["accept"]);
      expect(companyState(live.db, result.request_id)).toMatchObject({ status: "accepted", completion_json: null, lease_token: null });
      expect(new ControlPlane(live.db).get(result.request_id)?.state).toBe("approved");
    } finally { live.close(); }
  });

  it("calls mark_processed only after exact downstream completion and persists both SB receipts", async () => {
    const live = await approved(); const operations: string[] = [];
    try {
      const client = companyClient(async (operation) => {
        operations.push(operation);
        if (operation === "handoff") throw new Error("unexpected handoff");
        return companyReceipt(live.proposal.command.request_id, operation);
      });
      const executor = new CompanyCandidateExecutor(live.db, client, completed, () => COMPANY_NOW);
      expect((await executor.execute(live.proposal.command.request_id)).state).toBe("completed");
      expect(operations).toEqual(["accept", "mark_processed"]);
      expect(companyState(live.db, live.proposal.command.request_id)?.completion_json).not.toBeNull();
      expect(new ControlPlane(live.db).get(live.proposal.command.request_id)?.state).toBe("completed");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_candidate_sb_receipts").get()).toEqual({ n: 2 });
      expect((await executor.execute(live.proposal.command.request_id)).state).toBe("completed");
      expect(operations).toEqual(["accept", "mark_processed"]);
    } finally { live.close(); }
  });

  it("processes a signed reject without downstream or completion operations", async () => {
    const live = await approved("reject"); const operations: string[] = [];
    try {
      const client = companyClient(async (operation, args) => {
        operations.push(operation);
        expect(args.approval).toEqual(companyApproval(live.proposal, "reject"));
        return companyReceipt(live.proposal.command.request_id, "reject");
      });
      const result = await new CompanyCandidateExecutor(live.db, client, {
        async verify() { throw new Error("must not verify rejection"); },
      }, () => COMPANY_NOW).execute(live.proposal.command.request_id);
      expect(result.state).toBe("rejected"); expect(operations).toEqual(["reject"]);
      expect(result.receipts).toHaveLength(1);
    } finally { live.close(); }
  });

  it("refuses processor-only authority without invoking SB", async () => {
    const live = await companyDatabase(); let calls = 0;
    try {
      const proposal = companyProposal();
      importCompanyPage(live.db, companyPage(proposal), COMPANY_CONTEXT, COMPANY_NOW);
      await expect(new CompanyCandidateExecutor(live.db, companyClient(async () => { calls++; return {}; }),
        completed, () => COMPANY_NOW).execute(proposal.command.request_id)).rejects.toThrow("CONTROL_APPROVAL_REQUIRED");
      expect(calls).toBe(0); expect(new ControlPlane(live.db).get(proposal.command.request_id)?.state).toBe("pending");
    } finally { live.close(); }
  });

  it("denies forged and substituted representative proofs without changing pending state", async () => {
    const live = await companyDatabase();
    try {
      const proposal = companyProposal();
      importCompanyPage(live.db, companyPage(proposal), COMPANY_CONTEXT, COMPANY_NOW);
      const control = new ControlPlane(live.db);
      expect(() => control.decide(companyApproval(proposal, "approve", {}, COMPANY_PROCESSOR_KEY), COMPANY_NOW))
        .toThrow("CONTROL_APPROVAL_INVALID");
      expect(() => control.decide(companyApproval(proposal, "approve", {
        signer_principal_id: COMPANY_CONTEXT.processor_principal_id }), COMPANY_NOW))
        .toThrow("CONTROL_APPROVAL_INVALID");
      expect(control.get(proposal.command.request_id)?.state).toBe("pending");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts").get()).toEqual({ n: 0 });
    } finally { live.close(); }
  });

  it("rejects one-use receipt reuse for another candidate atomically", async () => {
    const live = await approved();
    try {
      const other = companyProposal("company-fixture-2");
      importCompanyPage(live.db, companyPage(other), COMPANY_CONTEXT, COMPANY_NOW);
      expect(() => new ControlPlane(live.db).decide(companyApproval(other, "approve", {
        receipt_id: companyApproval(live.proposal).receipt_id,
      }), COMPANY_NOW)).toThrow();
      expect(new ControlPlane(live.db).get(other.command.request_id)?.state).toBe("pending");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts").get()).toEqual({ n: 1 });
    } finally { live.close(); }
  });

  it("does not accept direct generic staging or generic worker claims as a company import", async () => {
    const live = await companyDatabase();
    try {
      const proposal = companyProposal(); const control = new ControlPlane(live.db);
      control.stage(proposal.command, COMPANY_NOW);
      expect(() => control.decide(companyApproval(proposal), COMPANY_NOW)).toThrow("CONTROL_APPROVAL_NOT_APPLICABLE");
      importCompanyPage(live.db, companyPage(proposal), COMPANY_CONTEXT, COMPANY_NOW);
      control.decide(companyApproval(proposal), COMPANY_NOW);
      expect(control.nextApproved(COMPANY_NOW)).toBeNull();
      expect(() => control.claim(proposal.command.request_id, "generic-worker", COMPANY_NOW)).toThrow("CONTROL_ACTION_REVIEW_ONLY");
    } finally { live.close(); }
  });

  it("keeps SB acceptance but never marks completion after failed or mismatched downstream verification", async () => {
    for (const response of [{ state: "failed" }, { ...(await completed.verify(companyProposal().command,
      companyReceipt(companyProposal().command.request_id, "accept")) as Record<string, unknown>), candidate_id: "another" }]) {
      const live = await approved(); const operations: string[] = [];
      try {
        const client = companyClient(async (operation) => {
          operations.push(operation); return companyReceipt(live.proposal.command.request_id, "accept");
        });
        await expect(new CompanyCandidateExecutor(live.db, client, { async verify() { return response; } },
          () => COMPANY_NOW).execute(live.proposal.command.request_id)).rejects.toThrow("COMPANY_COMPLETION_UNVERIFIED");
        expect(operations).toEqual(["accept"]); expect(companyState(live.db, live.proposal.command.request_id)?.status).toBe("uncertain");
        expect(live.db.db.prepare("SELECT count(*) AS n FROM company_candidate_sb_receipts").get()).toEqual({ n: 1 });
        expect(new ControlPlane(live.db).get(live.proposal.command.request_id)?.state).toBe("approved");
      } finally { live.close(); }
    }
  });

  it("rolls back local acceptance evidence on insertion failure and exact-replays the same owner proof", async () => {
    const live = await approved(); const originals: unknown[] = [];
    try {
      live.db.db.exec(`CREATE TRIGGER fail_company_receipt BEFORE INSERT ON company_candidate_sb_receipts
        BEGIN SELECT RAISE(ABORT,'forced receipt persistence failure'); END`);
      const client = companyClient(async (_operation, args) => {
        originals.push(args.approval); return companyReceipt(live.proposal.command.request_id, "accept");
      });
      const executor = new CompanyCandidateExecutor(live.db, client, undefined, () => COMPANY_NOW);
      await expect(executor.execute(live.proposal.command.request_id)).rejects.toThrow("forced receipt persistence failure");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_candidate_sb_receipts").get()).toEqual({ n: 0 });
      expect(companyState(live.db, live.proposal.command.request_id)).toMatchObject({ status: "uncertain", lease_token: null });
      live.db.db.exec("DROP TRIGGER fail_company_receipt");
      expect((await executor.execute(live.proposal.command.request_id)).state).toBe("accepted");
      expect(originals).toEqual([companyApproval(live.proposal), companyApproval(live.proposal)]);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_redemptions").get()).toEqual({ n: 1 });
    } finally { live.close(); }
  });

  it("rejects wrong SB metadata without completion evidence", async () => {
    const live = await approved(); let calls = 0;
    try {
      const client = companyClient(async () => { calls++; return { ...companyReceipt(live.proposal.command.request_id, "accept"), handoff_id: "another" }; });
      await expect(new CompanyCandidateExecutor(live.db, client, completed, () => COMPANY_NOW)
        .execute(live.proposal.command.request_id)).rejects.toThrow("COMPANY_SB_RECEIPT_INVALID");
      expect(calls).toBe(1);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_candidate_sb_receipts").get()).toEqual({ n: 0 });
    } finally { live.close(); }
  });

  it("rejects an aliased owner key and revoked approval before external work", async () => {
    const live = await approved(); let calls = 0;
    try {
      const client = companyClient(async () => { calls++; return {}; });
      await expect(new CompanyCandidateExecutor(live.db, { ...client,
        publicKeyPem: createPublicKey(COMPANY_OWNER_KEY).export({ type: "spki", format: "pem" }).toString() },
      completed, () => COMPANY_NOW).execute(live.proposal.command.request_id)).rejects.toThrow("COMPANY_CREDENTIAL_NOT_SEPARATE");
      live.db.revokeAuthority(companyApproval(live.proposal).receipt_id, "withdrawn");
      await expect(new CompanyCandidateExecutor(live.db, client, completed, () => COMPANY_NOW)
        .execute(live.proposal.command.request_id)).rejects.toThrow("CONTROL_APPROVAL_REVOKED");
      expect(calls).toBe(0);
    } finally { live.close(); }
  });

  it("serializes concurrent workers using an exact broker event instead of timing", async () => {
    const live = await approved();
    let signal: (() => void) | undefined; let release: (() => void) | undefined;
    const entered = new Promise<void>(resolve => { signal = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      const client = companyClient(async () => { signal?.(); await gate; return companyReceipt(live.proposal.command.request_id, "accept"); });
      const executor = new CompanyCandidateExecutor(live.db, client, undefined, () => COMPANY_NOW);
      const first = executor.execute(live.proposal.command.request_id);
      await entered;
      await expect(executor.execute(live.proposal.command.request_id)).rejects.toThrow("COMPANY_EXECUTION_BUSY");
      release?.(); expect((await first).state).toBe("accepted");
    } finally { release?.(); live.close(); }
  });

  it("honors owner-key revocation after downstream verification before completing SB", async () => {
    const live = await approved(); const operations: string[] = [];
    try {
      const client = companyClient(async (operation) => {
        operations.push(operation); return companyReceipt(live.proposal.command.request_id, "accept");
      });
      const verifier: CompanyCompletionVerifier = {
        async verify(command, acceptance) {
          const result = await completed.verify(command, acceptance);
          live.db.revokeAuthority("company-owner", "owner key retired during downstream work");
          return result;
        },
      };
      await expect(new CompanyCandidateExecutor(live.db, client, verifier, () => COMPANY_NOW)
        .execute(live.proposal.command.request_id)).rejects.toThrow("CONTROL_APPROVAL_REVOKED");
      expect(operations).toEqual(["accept"]);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_candidate_sb_receipts").get()).toEqual({ n: 1 });
      expect(companyState(live.db, live.proposal.command.request_id)?.status).toBe("uncertain");
    } finally { live.close(); }
  });
});
