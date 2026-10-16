import { describe, expect, it } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import type { CompanyFreshnessProvider } from "../../src/company-freshness.js";
import { AuthorityDb } from "../../src/db.js";
import { controlCommandDigest, signCommandApproval } from "../../src/control-plane-contract.js";
import { companyHandoffKeyV2, decodeCompanyCommandV2 } from "../../src/company-candidate-v2-contract.js";
import { importCompanyPage } from "../../src/company-candidate-import.js";
import { companyApproverKey, companyApproverProcessorContext, companyApproverV2Database } from "../fixtures/company-approver-execution.js";

const NOW = new Date("2026-10-15T00:05:00.000Z");

function nextApproval(live: Awaited<ReturnType<typeof companyApproverV2Database>>) {
  const next = decodeCompanyCommandV2(live.command);
  next.target.candidate_id += ":next";
  const key = companyHandoffKeyV2(next);
  next.request_id = `${key}:1`; next.nonce = next.request_id;
  const digest = controlCommandDigest(next);
  importCompanyPage(live.db, { handoffs: [{ idempotency_key: key, command: next, command_digest: digest }],
    count: 1, limit: 100, offset: 0 }, companyApproverProcessorContext(), NOW);
  const { signature: _signature, ...payload } = live.approval;
  void _signature;
  return signCommandApproval({ ...payload, receipt_id: "receipt:next", request_id: next.request_id,
    command_digest: digest, nonce: "nonce:next" }, companyApproverKey());
}

describe("company decision reservation recovery", () => {
  it.each(["approve", "reject"] as const)("retries %s after the receipt transaction aborts following provider reservation", async decision => {
    const live = await companyApproverV2Database(decision, false);
    let reserves = 0;
    const provider: CompanyFreshnessProvider = {
      readFreshness: request => live.provider.readFreshness(request),
      reserveProgress: request => {
        reserves++;
        return live.provider.reserveProgress(request);
      },
      finishProgress: request => live.provider.finishProgress(request),
    };
    try {
      const control = new ControlPlane(live.db, provider);
      live.db.db.exec(`CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON control_command_receipts
        BEGIN SELECT RAISE(ABORT,'TEST_ONLY post-reserve failure'); END`);
      expect(() => control.decide(live.approval, NOW)).toThrow("TEST_ONLY post-reserve failure");
      expect(reserves).toBe(1);
      expect(control.get(live.command.request_id)?.state).toBe("pending");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_progress_reservations WHERE evidence_digest IS NULL").get())
        .toEqual({ n: 1 });
      expect(live.db.db.prepare("SELECT lease_token,lease_expires_at FROM company_candidate_handoffs").get())
        .toEqual({ lease_token: null, lease_expires_at: null });
      live.db.db.exec("DROP TRIGGER fail_receipt");

      const restarted = new AuthorityDb(live.db.filename);
      try { expect(() => new ControlPlane(restarted, provider).decide(live.approval, NOW)).not.toThrow(); }
      finally { restarted.close(); }

      expect(control.get(live.command.request_id)?.state).toBe(decision === "approve" ? "approved" : "rejected");
      expect(reserves).toBe(1);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts").get()).toEqual({ n: 1 });
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_progress_reservations WHERE evidence_digest IS NULL").get())
        .toEqual({ n: 0 });
    } finally { live.close(); }
  });

  it("commits the local claim before provider I/O and blocks a competing workspace decision", async () => {
    const live = await companyApproverV2Database("approve", false);
    try {
      const next = nextApproval(live);
      const observer = new AuthorityDb(live.db.filename);
      let competingError: unknown;
      let claimed: unknown;
      const transactions: boolean[] = [];
      let reserves = 0;
      const provider: CompanyFreshnessProvider = {
        readFreshness: request => {
          transactions.push(live.db.db.inTransaction);
          return live.provider.readFreshness(request);
        },
        reserveProgress: request => {
          transactions.push(live.db.db.inTransaction);
          reserves++;
          if (reserves === 1) {
            claimed = observer.db.prepare("SELECT lease_token FROM company_candidate_handoffs WHERE request_id=?")
              .pluck().get(live.command.request_id);
            try { new ControlPlane(observer, provider).decide(next, NOW); }
            catch (error) { competingError = error; }
          }
          return live.provider.reserveProgress(request);
        },
        finishProgress: request => live.provider.finishProgress(request),
      };
      const control = new ControlPlane(live.db, provider);
      try { control.decide(live.approval, NOW); }
      finally { observer.close(); }

      expect(claimed).toEqual(expect.any(String));
      expect(transactions).toEqual([false, false]);
      expect(competingError).toMatchObject({ code: "COMPANY_EXECUTION_BUSY" });
      expect(control.get(next.request_id)?.state).toBe("pending");
      expect(reserves).toBe(1);
      control.decide(next, NOW);
      expect(control.get(next.request_id)?.state).toBe("approved");
      expect(reserves).toBe(2);
    } finally { live.close(); }
  });

  it("keeps other workspace requests blocked until the failed decision is retried", async () => {
    const live = await companyApproverV2Database("approve", false);
    try {
      const next = nextApproval(live);
      const control = new ControlPlane(live.db, live.provider);
      live.db.db.exec(`CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON control_command_receipts
        BEGIN SELECT RAISE(ABORT,'TEST_ONLY post-reserve failure'); END`);
      expect(() => control.decide(live.approval, NOW)).toThrow("TEST_ONLY post-reserve failure");
      live.db.db.exec("DROP TRIGGER fail_receipt");

      expect(() => control.decide(next, NOW)).toThrow("COMPANY_EXECUTION_BUSY");

      expect(control.get(next.request_id)?.state).toBe("pending");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_progress_reservations").get()).toEqual({ n: 1 });
      control.decide(live.approval, NOW);
      control.decide(next, NOW);
      expect(control.get(next.request_id)?.state).toBe("approved");
    } finally { live.close(); }
  });

  it("binds a recovered reservation to the original signed receipt", async () => {
    const live = await companyApproverV2Database("approve", false);
    try {
      const control = new ControlPlane(live.db, live.provider);
      live.db.db.exec(`CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON control_command_receipts
        BEGIN SELECT RAISE(ABORT,'TEST_ONLY post-reserve failure'); END`);
      expect(() => control.decide(live.approval, NOW)).toThrow("TEST_ONLY post-reserve failure");
      live.db.db.exec("DROP TRIGGER fail_receipt");
      const { signature: _signature, ...payload } = live.approval;
      void _signature;
      const replacement = signCommandApproval({ ...payload, receipt_id: "receipt:replacement", nonce: "nonce:replacement" },
        companyApproverKey());

      expect(() => control.decide(replacement, NOW)).toThrow("COMPANY_APPROVAL_INVALID");

      expect(control.get(live.command.request_id)?.state).toBe("pending");
      control.decide(live.approval, NOW);
      expect(control.get(live.command.request_id)?.state).toBe("approved");
    } finally { live.close(); }
  });

  it("does not reserve provider progress when the local claim cannot commit", async () => {
    const live = await companyApproverV2Database("approve", false);
    let reserves = 0;
    const provider: CompanyFreshnessProvider = {
      readFreshness: request => live.provider.readFreshness(request),
      reserveProgress: request => { reserves++; return live.provider.reserveProgress(request); },
      finishProgress: request => live.provider.finishProgress(request),
    };
    try {
      const control = new ControlPlane(live.db, provider);
      live.db.db.exec(`CREATE TEMP TRIGGER fail_claim BEFORE UPDATE OF lease_token ON company_candidate_handoffs
        WHEN NEW.lease_token IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'TEST_ONLY claim failure'); END`);

      expect(() => control.decide(live.approval, NOW)).toThrow("TEST_ONLY claim failure");

      expect(reserves).toBe(0);
      expect(control.get(live.command.request_id)?.state).toBe("pending");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_progress_reservations").get()).toEqual({ n: 0 });
      live.db.db.exec("DROP TRIGGER fail_claim");
      control.decide(live.approval, NOW);
      expect(control.get(live.command.request_id)?.state).toBe("approved");
    } finally { live.close(); }
  });

  it("refuses a caller-owned transaction before any company provider reservation", async () => {
    const live = await companyApproverV2Database("approve", false);
    let reserves = 0;
    const provider: CompanyFreshnessProvider = {
      readFreshness: request => live.provider.readFreshness(request),
      reserveProgress: request => { reserves++; return live.provider.reserveProgress(request); },
      finishProgress: request => live.provider.finishProgress(request),
    };
    try {
      const control = new ControlPlane(live.db, provider);

      expect(() => live.db.db.transaction(() => control.decide(live.approval, NOW))())
        .toThrow("COMPANY_PROGRESS_UNCERTAIN");

      expect(reserves).toBe(0);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_progress_reservations").get()).toEqual({ n: 0 });
      control.decide(live.approval, NOW);
      expect(control.get(live.command.request_id)?.state).toBe("approved");
    } finally { live.close(); }
  });

  it("retains the reservation when the request state races after provider reservation", async () => {
    const live = await companyApproverV2Database("approve", false);
    const provider: CompanyFreshnessProvider = {
      readFreshness: request => live.provider.readFreshness(request),
      reserveProgress: request => {
        const response = live.provider.reserveProgress(request);
        live.db.db.prepare("UPDATE control_command_requests SET state='cancelled' WHERE request_id=?").run(live.command.request_id);
        return response;
      },
      finishProgress: request => live.provider.finishProgress(request),
    };
    try {
      const control = new ControlPlane(live.db, provider);

      expect(() => control.decide(live.approval, NOW)).toThrow("CONTROL_APPROVAL_RACE");

      expect(control.get(live.command.request_id)?.state).toBe("cancelled");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts").get()).toEqual({ n: 0 });
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_progress_reservations WHERE evidence_digest IS NULL").get())
        .toEqual({ n: 1 });
      expect(live.db.db.prepare("SELECT lease_token FROM company_candidate_handoffs").get()).toEqual({ lease_token: null });
    } finally { live.close(); }
  });
});
