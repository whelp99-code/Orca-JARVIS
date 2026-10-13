import { describe, expect, it } from "vitest";
import { createPublicKey } from "node:crypto";
import { importCompanyPage, pullCompanyCandidates } from "../../src/company-candidate-import.js";
import { parseCompanyHandoff } from "../../src/company-candidate-contract.js";
import { ControlPlane } from "../../src/control-plane.js";
import { OwnerInbox } from "../../src/owner-inbox.js";
import { ControlReceiptSigner } from "../../src/remote-approval-signer.js";
import { parseCompanyJson } from "../../src/company-candidate-json.js";
import { CompanyCandidateExecutor } from "../../src/company-candidate-execution.js";
import { COMPANY_CONTEXT, COMPANY_NOW, COMPANY_OWNER_KEY, companyApproval, companyClient,
  companyDatabase, companyPage, companyProposal, companyReceipt } from "../fixtures/company-candidate.js";

describe("company-only handoff importer", () => {
  it("refuses a cancelled same-digest prestage and rolls back the fresh page item", async () => {
    const live = await companyDatabase();
    try {
      const blocked = companyProposal("cancelled-prestage");
      const fresh = companyProposal("fresh-before-cancelled");
      const control = new ControlPlane(live.db);
      control.stage(blocked.command, COMPANY_NOW);
      control.cancel({ request_id: blocked.command.request_id, reason: "fixture cancellation",
        actor: COMPANY_CONTEXT.owner, revoked_at: COMPANY_NOW.toISOString() }, COMPANY_NOW);
      const prior = control.get(blocked.command.request_id);
      expect(() => importCompanyPage(live.db, companyPage(fresh, blocked), COMPANY_CONTEXT, COMPANY_NOW))
        .toThrow("COMPANY_HANDOFF_NOT_PENDING");
      expect(control.get(blocked.command.request_id)).toEqual(prior);
      expect(control.get(fresh.command.request_id)).toBeUndefined();
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_candidate_handoffs").get()).toEqual({ n: 0 });
    } finally { live.close(); }
  });

  it("imports a pending same-digest prestage without creating another control request", async () => {
    const live = await companyDatabase();
    try {
      const proposal = companyProposal("pending-prestage");
      const control = new ControlPlane(live.db);
      control.stage(proposal.command, COMPANY_NOW);
      expect(importCompanyPage(live.db, companyPage(proposal), COMPANY_CONTEXT, COMPANY_NOW).imported).toBe(1);
      expect(control.get(proposal.command.request_id)?.state).toBe("pending");
      expect(control.list()).toHaveLength(1);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_candidate_handoffs").get()).toEqual({ n: 1 });
    } finally { live.close(); }
  });

  it.each(["pending", "accepted"] as const)("keeps an expired %s duplicate unchanged while importing a fresh candidate", async state => {
    const live = await companyDatabase();
    try {
      const old = companyProposal("repeated");
      importCompanyPage(live.db, companyPage(old), COMPANY_CONTEXT, COMPANY_NOW);
      if (state === "accepted") {
        new ControlPlane(live.db).decide(companyApproval(old), COMPANY_NOW);
        const client = companyClient(async () => companyReceipt(old.command.request_id, "accept"));
        expect((await new CompanyCandidateExecutor(live.db, client, undefined, () => COMPANY_NOW)
          .execute(old.command.request_id)).state).toBe("accepted");
      }
      const prior = live.db.db.prepare("SELECT * FROM company_candidate_handoffs WHERE request_id=?").get(old.command.request_id);
      const receipts = live.db.db.prepare("SELECT * FROM company_candidate_sb_receipts WHERE request_id=?").all(old.command.request_id);
      const control = new ControlPlane(live.db);
      const request = control.get(old.command.request_id);
      const later = new Date(COMPANY_NOW.getTime() + 86_400_000);
      const fresh = companyProposal("fresh-in-repeated-page", later);
      expect(importCompanyPage(live.db, companyPage(fresh, old), COMPANY_CONTEXT, later))
        .toMatchObject({ imported: 1, duplicate: 1, superseded: 0 });
      expect(live.db.db.prepare("SELECT * FROM company_candidate_handoffs WHERE request_id=?").get(old.command.request_id)).toEqual(prior);
      expect(live.db.db.prepare("SELECT * FROM company_candidate_sb_receipts WHERE request_id=?").all(old.command.request_id)).toEqual(receipts);
      expect(control.get(old.command.request_id)).toEqual(request);
      expect(control.get(fresh.command.request_id)?.state).toBe("pending");
      expect(control.list()).toHaveLength(2);
    } finally { live.close(); }
  });

  it("still rejects a conflicting expired replay and atomically refuses unseen expired rows", async () => {
    const live = await companyDatabase();
    try {
      const old = companyProposal("repeated");
      importCompanyPage(live.db, companyPage(old), COMPANY_CONTEXT, COMPANY_NOW);
      const later = new Date(COMPANY_NOW.getTime() + 86_400_001);
      const fresh = companyProposal("fresh", later);
      const conflict = companyProposal("repeated", new Date(COMPANY_NOW.getTime() + 1));
      expect(() => importCompanyPage(live.db, companyPage(fresh, conflict), COMPANY_CONTEXT, later))
        .toThrow("COMPANY_HANDOFF_REPLAY_CONFLICT");
      const unseenExpired = companyProposal("unseen-expired");
      expect(() => importCompanyPage(live.db, companyPage(fresh, unseenExpired), COMPANY_CONTEXT, later))
        .toThrow("COMPANY_HANDOFF_EXPIRED");
      const control = new ControlPlane(live.db);
      expect(control.get(fresh.command.request_id)).toBeUndefined();
      expect(control.list()).toHaveLength(1);
    } finally { live.close(); }
  });

  it("imports an exact request and repeated page as one inbox item", async () => {
    const live = await companyDatabase();
    try {
      const page = companyPage(companyProposal());
      expect(importCompanyPage(live.db, page, COMPANY_CONTEXT, COMPANY_NOW)).toMatchObject({ imported: 1, duplicate: 0 });
      expect(importCompanyPage(live.db, page, COMPANY_CONTEXT, COMPANY_NOW)).toMatchObject({ imported: 0, duplicate: 1 });
      expect(importCompanyPage(live.db, page,
        { ...COMPANY_CONTEXT, agent_id: "agent:handoff-rotated", session_id: "handoff-session-rotated" }, COMPANY_NOW))
        .toMatchObject({ imported: 0, duplicate: 1 });
      expect(new ControlPlane(live.db).list()).toHaveLength(1);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM memory_candidates").get()).toEqual({ n: 0 });
    } finally { live.close(); }
  });

  it("supersedes only the expired unconsumed generation and denies its proof", async () => {
    const live = await companyDatabase();
    try {
      const first = companyProposal();
      importCompanyPage(live.db, companyPage(first), COMPANY_CONTEXT, COMPANY_NOW);
      const later = new Date(COMPANY_NOW.getTime() + 86_400_000);
      const next = companyProposal("company-fixture-1", later, 2);
      expect(importCompanyPage(live.db, companyPage(next), COMPANY_CONTEXT, later)).toMatchObject({ imported: 1, superseded: 1 });
      const control = new ControlPlane(live.db);
      expect(control.get(first.command.request_id)?.state).toBe("cancelled");
      expect(() => control.decide(companyApproval(first), later)).toThrow("CONTROL_APPROVAL_REVOKED");
      expect(control.get(next.command.request_id)?.state).toBe("pending");
    } finally { live.close(); }
  });

  it("rolls back the whole page when a later scope conflicts", async () => {
    const live = await companyDatabase();
    try {
      const valid = companyProposal("valid");
      const bad = companyProposal("bad");
      live.db.db.exec(`CREATE TRIGGER fail_second_company_import BEFORE INSERT ON company_candidate_handoffs
        WHEN NEW.request_id='${bad.command.request_id}'
        BEGIN SELECT RAISE(ABORT,'forced page failure'); END`);
      expect(() => importCompanyPage(live.db, companyPage(valid, bad), COMPANY_CONTEXT, COMPANY_NOW)).toThrow("forced page failure");
      expect(new ControlPlane(live.db).list()).toEqual([]);
    } finally { live.close(); }
  });

  it("rejects unknown fields, changed digest, identity and privilege substitutions", () => {
    const valid = companyProposal();
    for (const value of [
      { ...valid, source_content: "not allowed" },
      { ...valid, command_digest: `sha256:${"b".repeat(64)}` },
      { ...valid, idempotency_key: `company-handoff:v1:${"f".repeat(64)}` },
      { ...valid, command: { ...valid.command, reversible: true } },
      { ...valid, command: { ...valid.command, action_level: 4 } },
      { ...valid, command: { ...valid.command, args: { ...valid.command.args, operations: ["accept"] } } },
    ]) expect(() => parseCompanyHandoff(value)).toThrow();
  });

  it("decodes a bounded company page larger than personal MCP node limits and refuses duplicate keys", () => {
    const projects = Array.from({ length: 64 }, (_, index) => `project:${index}`);
    const page = companyPage(...Array.from({ length: 100 }, (_, index) => companyProposal(`company-${index}`,
      COMPANY_NOW, 1, { ...COMPANY_CONTEXT, projects })));
    expect(parseCompanyJson(JSON.stringify(page))).toEqual(page);
    expect(parseCompanyJson('{"handoffs":[],"count":0,"count":1,"limit":100,"offset":0}')).toBeUndefined();
  });

  it("rejects a new generation while the current request is live or decided", async () => {
    const live = await companyDatabase();
    try {
      const first = companyProposal();
      importCompanyPage(live.db, companyPage(first), COMPANY_CONTEXT, COMPANY_NOW);
      const next = companyProposal("company-fixture-1", new Date(COMPANY_NOW.getTime() + 1), 2);
      expect(() => importCompanyPage(live.db, companyPage(next), COMPANY_CONTEXT, new Date(COMPANY_NOW.getTime() + 1)))
        .toThrow("COMPANY_HANDOFF_GENERATION_CONFLICT");
      new ControlPlane(live.db).decide(companyApproval(first), COMPANY_NOW);
      const expired = new Date(COMPANY_NOW.getTime() + 86_400_000);
      expect(() => importCompanyPage(live.db, companyPage(companyProposal("company-fixture-1", expired, 2)), COMPANY_CONTEXT, expired))
        .toThrow("COMPANY_HANDOFF_GENERATION_CONFLICT");
    } finally { live.close(); }
  });

  it("does not trust a caller page from a different company access fence", async () => {
    const live = await companyDatabase();
    try {
      expect(() => importCompanyPage(live.db, companyPage(companyProposal()), { ...COMPANY_CONTEXT, projects: [] }, COMPANY_NOW))
        .toThrow("COMPANY_CONTEXT_MISMATCH");
      expect(new ControlPlane(live.db).list()).toEqual([]);
    } finally { live.close(); }
  });

  it("preserves the narrower candidate project scope inside the enrolled caller fence", async () => {
    const live = await companyDatabase();
    try {
      const proposal = companyProposal();
      expect(importCompanyPage(live.db, companyPage(proposal),
        { ...COMPANY_CONTEXT, projects: [...COMPANY_CONTEXT.projects, "project:other"] }, COMPANY_NOW).imported).toBe(1);
      expect(new ControlPlane(live.db).get(proposal.command.request_id)?.args.projects).toEqual(COMPANY_CONTEXT.projects);
    } finally { live.close(); }
  });

  it("refuses a handoff key that aliases the owner key before any broker call", async () => {
    const live = await companyDatabase(); let calls = 0;
    try {
      const client = { ...companyClient(async () => { calls++; return {}; }),
        publicKeyPem: createPublicKey(COMPANY_OWNER_KEY).export({ type: "spki", format: "pem" }).toString() };
      await expect(pullCompanyCandidates(live.db, client, 100, 0, () => COMPANY_NOW)).rejects.toThrow("COMPANY_CREDENTIAL_NOT_SEPARATE");
      expect(calls).toBe(0);
    } finally { live.close(); }
  });

  it("imports a proposal minted during the broker call using response-time freshness", async () => {
    const live = await companyDatabase(); let now = COMPANY_NOW;
    try {
      const client = companyClient(async () => {
        now = new Date(COMPANY_NOW.getTime() + 100);
        return companyPage(companyProposal("minted-in-call", now));
      });
      expect((await pullCompanyCandidates(live.db, client, 100, 0, () => now)).imported).toBe(1);
    } finally { live.close(); }
  });

  it("does not display or start a representative ceremony for an unimported generic company request", async () => {
    const live = await companyDatabase();
    try {
      const proposal = companyProposal();
      new ControlPlane(live.db).stage(proposal.command, COMPANY_NOW);
      const inbox = new OwnerInbox(live.db,
        new ControlReceiptSigner(COMPANY_OWNER_KEY, "company-owner", COMPANY_CONTEXT.owner), true, () => COMPANY_NOW);
      expect(inbox.list()).toEqual([]);
      expect(() => inbox.issueChallenge({ request_id: proposal.command.request_id, command_digest: proposal.command_digest,
        decision: "approve", session_id: "representative-session" })).toThrow("OWNER_INBOX_NOT_PENDING");
    } finally { live.close(); }
  });
});
