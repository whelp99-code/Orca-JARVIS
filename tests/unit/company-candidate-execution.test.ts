import { createHash, createPublicKey } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CompanyCandidateExecutor, createCompanyCompletionVerifier, type CompanyCompletionVerifier } from "../../src/company-candidate-execution.js";
import { importCompanyPage } from "../../src/company-candidate-import.js";
import { ControlPlane } from "../../src/control-plane.js";
import { controlValueDigest } from "../../src/control-plane-contract.js";
import { JarvisError } from "../../src/jarvis-error.js";
import { OwnerInbox } from "../../src/owner-inbox.js";
import { ControlReceiptSigner } from "../../src/remote-approval-signer.js";
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
  it.each([
    ["approve", 600_000], ["reject", 600_000],
    ["approve", 86_400_000], ["reject", 86_400_000],
  ] as const)("refuses expired %s first-use retry without SB acknowledgement at %i", async (decision, age) => {
    const live = await approved(decision);
    let now = new Date(COMPANY_NOW); let calls = 0;
    try {
      const client = companyClient(async () => {
        calls++;
        if (calls === 1) throw new JarvisError("COMPANY_CANDIDATE_CALL_REFUSED");
        return companyReceipt(live.proposal.command.request_id, decision === "approve" ? "accept" : "reject");
      });
      const executor = new CompanyCandidateExecutor(live.db, client, undefined, () => now);
      await expect(executor.execute(live.proposal.command.request_id)).rejects.toThrow("COMPANY_CANDIDATE_CALL_REFUSED");
      now = new Date(COMPANY_NOW.getTime() + age);
      await expect(executor.execute(live.proposal.command.request_id)).rejects.toThrow("CONTROL_APPROVAL_INVALID");
      expect(calls).toBe(1);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_candidate_sb_receipts").get()).toEqual({ n: 0 });
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_redemptions").get()).toEqual({ n: 1 });
      expect(companyState(live.db, live.proposal.command.request_id)?.lease_token).toBeNull();
    } finally { live.close(); }
  });

  it("allows completion after expiry only when SB acceptance was acknowledged", async () => {
    const live = await approved(); let now = new Date(COMPANY_NOW);
    const operations: string[] = [];
    try {
      const client = companyClient(async operation => {
        if (operation === "handoff") throw new Error("unexpected handoff");
        operations.push(operation);
        return companyReceipt(live.proposal.command.request_id, operation);
      });
      expect((await new CompanyCandidateExecutor(live.db, client, undefined, () => now)
        .execute(live.proposal.command.request_id)).state).toBe("accepted");
      now = new Date(COMPANY_NOW.getTime() + 86_400_001);
      expect((await new CompanyCandidateExecutor(live.db, client, completed, () => now)
        .execute(live.proposal.command.request_id)).state).toBe("completed");
      expect(operations).toEqual(["accept", "mark_processed"]);
    } finally { live.close(); }
  });

  it("retains a signed unforwarded rejection as a read-only inbox request until SB acknowledges it", async () => {
    const live = await approved("reject");
    try {
      const inbox = new OwnerInbox(live.db,
        new ControlReceiptSigner(COMPANY_OWNER_KEY, "company-owner", COMPANY_CONTEXT.owner), true, () => COMPANY_NOW);
      const item = inbox.list().find(value => value.request_id === live.proposal.command.request_id);
      expect(item).toMatchObject({ manual_wait: true, company_candidate: { status: "imported" } });
      expect(() => inbox.issueChallenge({
        request_id: live.proposal.command.request_id, command_digest: live.proposal.command_digest,
        decision: "approve", session_id: "test",
      })).toThrow("OWNER_INBOX_NOT_PENDING");
      const client = companyClient(async () => companyReceipt(live.proposal.command.request_id, "reject"));
      expect((await new CompanyCandidateExecutor(live.db, client, undefined, () => COMPANY_NOW)
        .execute(live.proposal.command.request_id)).state).toBe("rejected");
      expect(inbox.list().some(value => value.request_id === live.proposal.command.request_id)).toBe(false);
    } finally { live.close(); }
  });

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

  it("records the validated completion object directly in the mark_processed effect", async () => {
    const live = await approved();
    try {
      const acceptance = companyReceipt(live.proposal.command.request_id, "accept");
      const processed = companyReceipt(live.proposal.command.request_id, "mark_processed");
      const completion = {
        schema_version: 1, state: "completed", request_id: live.proposal.command.request_id,
        command_digest: live.proposal.command_digest, candidate_id: live.proposal.command.target.candidate_id,
        content_digest: live.proposal.command.target.content_digest,
        acceptance_receipt_digest: acceptance.receipt_digest, effect_digest: `sha256:${"e".repeat(64)}`,
      };
      const client = companyClient(async operation => operation === "accept" ? acceptance : processed);
      await new CompanyCandidateExecutor(live.db, client, { async verify() { return completion; } },
        () => COMPANY_NOW).execute(live.proposal.command.request_id);
      const effect = live.db.db.prepare(
        "SELECT payload_json,payload_digest FROM control_command_effects WHERE request_id=? AND effect_type=?",
      ).get(live.proposal.command.request_id, "company.candidate.mark_processed") as
        { payload_json: string; payload_digest: string };
      expect(JSON.parse(effect.payload_json)).toEqual({ receipt: processed, completion });
      expect(effect.payload_digest).toBe(controlValueDigest({ receipt: processed, completion }));
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

  it("keeps an acknowledged uncertain state on retry without a completion verifier", async () => {
    const live = await approved(); const operations: string[] = [];
    try {
      const client = companyClient(async operation => {
        operations.push(operation); return companyReceipt(live.proposal.command.request_id, "accept");
      });
      await expect(new CompanyCandidateExecutor(live.db, client, { async verify() { return { state: "failed" }; } },
        () => COMPANY_NOW).execute(live.proposal.command.request_id)).rejects.toThrow("COMPANY_COMPLETION_UNVERIFIED");
      const prior = live.db.db.prepare(
        "SELECT status,failure_code,completion_json FROM company_candidate_handoffs WHERE request_id=?",
      ).get(live.proposal.command.request_id);
      expect((await new CompanyCandidateExecutor(live.db, client, undefined, () => COMPANY_NOW)
        .execute(live.proposal.command.request_id)).state).toBe("uncertain");
      expect(live.db.db.prepare(
        "SELECT status,failure_code,completion_json FROM company_candidate_handoffs WHERE request_id=?",
      ).get(live.proposal.command.request_id)).toEqual(prior);
      expect(operations).toEqual(["accept"]);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_candidate_sb_receipts").get()).toEqual({ n: 1 });
      expect(new ControlPlane(live.db).get(live.proposal.command.request_id)?.state).toBe("approved");
    } finally { live.close(); }
  });

  it("returns accepted when an unacknowledged uncertain retry obtains fresh SB acceptance", async () => {
    const live = await approved(); let calls = 0;
    try {
      const client = companyClient(async () => {
        if (++calls === 1) throw new JarvisError("COMPANY_CANDIDATE_CALL_REFUSED");
        return companyReceipt(live.proposal.command.request_id, "accept");
      });
      const executor = new CompanyCandidateExecutor(live.db, client, undefined, () => COMPANY_NOW);
      await expect(executor.execute(live.proposal.command.request_id)).rejects.toThrow("COMPANY_CANDIDATE_CALL_REFUSED");
      expect((await executor.execute(live.proposal.command.request_id)).state).toBe("accepted");
      expect(companyState(live.db, live.proposal.command.request_id)?.status).toBe("accepted");
      expect(calls).toBe(2);
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

describe("pinned company completion executable", () => {
  it("runs a protected owned verifier and observes its durable effect", async () => {
    const live = await companyDatabase();
    try {
      const effect = join(live.root, "effect");
      const executable = join(live.root, "verify");
      writeFileSync(executable, `#!${process.execPath}
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
let data=""; process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { data+=chunk; });
process.stdin.on("end", () => {
  const input=JSON.parse(data);
  writeFileSync(${JSON.stringify(effect)}, "verified-fixture-effect", {mode:0o600});
  const bytes=readFileSync(${JSON.stringify(effect)});
  console.log(JSON.stringify({state:"completed",request_id:input.command.request_id,
    effect_digest:"sha256:"+createHash("sha256").update(bytes).digest("hex")}));
});
`, { mode: 0o700 });
      const config = join(live.root, "completion.json");
      writeFileSync(config, JSON.stringify({ schema_version: 1, executable, args: [] }), { mode: 0o600 });
      const command = companyProposal().command;
      const result = await createCompanyCompletionVerifier(config).verify(command, companyReceipt(command.request_id, "accept"));
      expect(result).toEqual({ state: "completed", request_id: command.request_id,
        effect_digest: `sha256:${createHash("sha256").update("verified-fixture-effect").digest("hex")}` });
      expect(readFileSync(effect, "utf8")).toBe("verified-fixture-effect");
    } finally { live.close(); }
  });

  it.each(["symlink", "writable-file", "writable-parent", "directory"] as const)(
    "refuses an unsafe %s before treating the verifier as pinned", async kind => {
      const live = await companyDatabase();
      try {
        const parent = join(live.root, "bin"); mkdirSync(parent, { mode: 0o700 });
        const executable = join(parent, "verify");
        if (kind === "directory") mkdirSync(executable, { mode: 0o700 });
        else {
          const target = kind === "symlink" ? join(parent, "target") : executable;
          writeFileSync(target, `#!${process.execPath}\nprocess.stdin.resume();\n`, { mode: 0o700 });
          if (kind === "symlink") symlinkSync(target, executable);
          if (kind === "writable-file") chmodSync(executable, 0o722);
          if (kind === "writable-parent") chmodSync(parent, 0o777);
        }
        const config = join(live.root, "completion.json");
        writeFileSync(config, JSON.stringify({ schema_version: 1, executable, args: [] }), { mode: 0o600 });
        expect(() => createCompanyCompletionVerifier(config)).toThrow("COMPANY_COMPLETION_CONFIG_INVALID");
      } finally { live.close(); }
    },
  );
});
