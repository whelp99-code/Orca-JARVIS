import { describe, expect, it } from "vitest";
import { OwnerInbox } from "../../src/owner-inbox.js";
import { ControlPlane } from "../../src/control-plane.js";
import { ControlReceiptSigner } from "../../src/remote-approval-signer.js";
import { importCompanyPage } from "../../src/company-candidate-import.js";
import { CompanyCandidateExecutor } from "../../src/company-candidate-execution.js";
import { COMPANY_CONTEXT, COMPANY_NOW, COMPANY_OWNER_KEY, companyApproval, companyClient,
  companyDatabase, companyPage, companyProposal, companyReceipt } from "../fixtures/company-candidate.js";

describe("company owner inbox first-use deadline", () => {
  it.each([
    ["approve", 599_999, false], ["reject", 599_999, false],
    ["approve", 600_000, true], ["reject", 600_000, true],
  ] as const)("exposes the original %s proof window at %i milliseconds", async (decision, elapsed, expired) => {
    const live = await companyDatabase();
    try {
      const proposal = companyProposal();
      const approval = companyApproval(proposal, decision);
      importCompanyPage(live.db, companyPage(proposal), COMPANY_CONTEXT, COMPANY_NOW);
      new ControlPlane(live.db).decide(approval, COMPANY_NOW);
      const inbox = new OwnerInbox(live.db,
        new ControlReceiptSigner(COMPANY_OWNER_KEY, "company-owner", COMPANY_CONTEXT.owner),
        true, () => new Date(COMPANY_NOW.getTime() + elapsed));
      expect(inbox.list().find(item => item.request_id === proposal.command.request_id)).toMatchObject({
        expires_at: approval.expires_at, expired, needs_review: expired, manual_wait: true,
      });
    } finally { live.close(); }
  });

  it("keeps the command deadline for a pending undecided handoff", async () => {
    const live = await companyDatabase();
    try {
      const proposal = companyProposal();
      importCompanyPage(live.db, companyPage(proposal), COMPANY_CONTEXT, COMPANY_NOW);
      const inbox = new OwnerInbox(live.db,
        new ControlReceiptSigner(COMPANY_OWNER_KEY, "company-owner", COMPANY_CONTEXT.owner),
        true, () => new Date(COMPANY_NOW.getTime() + 600_000));
      expect(inbox.list().find(item => item.request_id === proposal.command.request_id)).toMatchObject({
        expires_at: proposal.command.expires_at, expired: false, needs_review: false, manual_wait: false,
      });
    } finally { live.close(); }
  });

  it("keeps acknowledged acceptance separate from the expired first-use window", async () => {
    const live = await companyDatabase();
    try {
      const proposal = companyProposal();
      importCompanyPage(live.db, companyPage(proposal), COMPANY_CONTEXT, COMPANY_NOW);
      new ControlPlane(live.db).decide(companyApproval(proposal), COMPANY_NOW);
      await new CompanyCandidateExecutor(live.db,
        companyClient(async () => companyReceipt(proposal.command.request_id, "accept")),
        undefined, () => COMPANY_NOW).execute(proposal.command.request_id);
      const inbox = new OwnerInbox(live.db,
        new ControlReceiptSigner(COMPANY_OWNER_KEY, "company-owner", COMPANY_CONTEXT.owner),
        true, () => new Date(COMPANY_NOW.getTime() + 600_000));
      expect(inbox.list().find(item => item.request_id === proposal.command.request_id)).toMatchObject({
        expires_at: proposal.command.expires_at, expired: false, needs_review: false,
        company_candidate: { status: "accepted" },
      });
    } finally { live.close(); }
  });
});
