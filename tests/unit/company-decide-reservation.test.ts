import { describe, expect, it } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import type { CompanyFreshnessProvider } from "../../src/company-freshness.js";
import { AuthorityDb } from "../../src/db.js";
import { CompanyProgress } from "../../src/company-progress.js";
import { OwnerInbox } from "../../src/owner-inbox.js";
import { ControlReceiptSigner } from "../../src/remote-approval-signer.js";
import { canonicalize } from "../../src/canonical.js";
import { controlCommandDigest, controlValueDigest, signCommandApproval } from "../../src/control-plane-contract.js";
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
  it("reuses the signed receipt after a consumed inbox challenge and receipt rollback", async () => {
    const live = await companyApproverV2Database("approve", false);
    try {
      const inbox = new OwnerInbox(live.db, new ControlReceiptSigner(companyApproverKey(), live.approval.key_id,
        live.approval.signer_principal_id), true, () => NOW, live.provider);
      live.db.db.prepare("INSERT INTO owner_inbox_credentials(credential_id,public_key,counter,created_at) VALUES(?,?,0,?)")
        .run("TEST_ONLY retry credential", Buffer.from("TEST_ONLY key"), NOW.toISOString());
      const input = { request_id: live.command.request_id, decision: "approve" as const,
        command_digest: live.approval.command_digest, session_id: "session:TEST_ONLY:owner" };
      const decide = (challenge_id: string, counter: number) => inbox.decide({ ...input, challenge_id,
        assertion: { id: "TEST_ONLY retry credential", clientDataJSON: "", authenticatorData: "", signature: "", userHandle: "" },
        origin: "https://TEST_ONLY.invalid", rpId: "TEST_ONLY.invalid",
        check: async () => ({ ok: true as const, newCounter: counter }),
      });
      const first = inbox.issueChallenge(input);
      live.db.db.exec(`CREATE TEMP TRIGGER fail_inbox_receipt BEFORE INSERT ON control_command_receipts
        BEGIN SELECT RAISE(ABORT,'TEST_ONLY inbox receipt rollback'); END`);
      await expect(decide(first.challenge_id, 1)).rejects.toThrow("TEST_ONLY inbox receipt rollback");
      const original = live.db.db.prepare("SELECT receipt_json FROM company_decision_receipt_intents WHERE request_id=?")
        .get(input.request_id) as { receipt_json: string };
      expect(live.db.db.prepare("SELECT used_at FROM owner_inbox_challenges WHERE challenge_id=?").get(first.challenge_id))
        .toEqual({ used_at: NOW.toISOString() });
      live.db.db.exec("DROP TRIGGER fail_inbox_receipt");
      const second = inbox.issueChallenge(input);
      expect(second.challenge_id).not.toBe(first.challenge_id);
      await expect(decide(second.challenge_id, 2)).resolves.toEqual({ request_id: input.request_id, state: "approved" });
      expect(live.db.db.prepare("SELECT payload_json FROM control_command_receipts WHERE request_id=?").get(input.request_id))
        .toEqual({ payload_json: original.receipt_json });
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_progress_reservations").get()).toEqual({ n: 1 });
      await expect(decide(first.challenge_id, 3)).rejects.toThrow("OWNER_INBOX_REPLAY");
    } finally { live.close(); }
  });

  it.each(["readFreshness", "reserveProgress"] as const)("does not expire the decision claim during slow %s", async phase => {
    const live = await companyApproverV2Database("approve", false);
    const later = new Date(NOW.getTime() + 61_000);
    try {
      const next = nextApproval(live);
      const observer = new AuthorityDb(live.db.filename);
      let competingError: unknown;
      const compete = () => {
        try { new ControlPlane(observer, live.provider).decide(next, later); }
        catch (error) { competingError = error; }
      };
      const provider: CompanyFreshnessProvider = {
        readFreshness: request => {
          if (phase === "readFreshness") compete();
          return live.provider.readFreshness(request);
        },
        reserveProgress: request => {
          if (phase === "reserveProgress") compete();
          return live.provider.reserveProgress(request);
        },
        finishProgress: request => live.provider.finishProgress(request),
      };
      try { new ControlPlane(live.db, provider).decide(live.approval, NOW); }
      finally { observer.close(); }
      expect(competingError).toMatchObject({ code: "COMPANY_EXECUTION_BUSY" });
      expect(new ControlPlane(live.db).get(next.request_id)?.state).toBe("pending");
    } finally { live.close(); }
  });

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

  it("recovers the same provider operation after the local reservation INSERT fails", async () => {
    const live = await companyApproverV2Database("approve", false);
    let reopened: AuthorityDb | undefined;
    const operations: string[] = [];
    const reserve = live.provider.reserveProgress.bind(live.provider);
    live.provider.reserveProgress = input => {
      const result = reserve(input); operations.push(input.operation_id); return result;
    };
    try {
      const control = new ControlPlane(live.db, live.provider);
      live.db.db.exec(`CREATE TEMP TRIGGER fail_reservation BEFORE INSERT ON company_progress_reservations
        BEGIN SELECT RAISE(ABORT,'TEST_ONLY reservation INSERT failure'); END`);
      expect(() => control.decide(live.approval, NOW)).toThrow("TEST_ONLY reservation INSERT failure");
      live.db.db.exec("DROP TRIGGER fail_reservation");

      reopened = new AuthorityDb(live.db.filename);
      const restarted = new ControlPlane(reopened, live.provider);
      restarted.decide(live.approval, NOW);
      expect(restarted.get(live.command.request_id)?.state).toBe("approved");
      expect(new Set(operations).size).toBe(1);
      expect(reopened.db.prepare("SELECT count(*) AS n FROM control_command_receipts").get()).toEqual({ n: 1 });
      expect(reopened.db.prepare(
        "SELECT count(*) AS n FROM company_progress_reservations WHERE finished_checkpoint_json IS NOT NULL",
      ).get()).toEqual({ n: 1 });
    } finally { reopened?.close(); live.close(); }
  });

  it("persists the exact reserve request before provider I/O and fences an unknown acknowledgement", async () => {
    const live = await companyApproverV2Database("approve", false);
    const observer = new AuthorityDb(live.db.filename);
    const reserve = live.provider.reserveProgress.bind(live.provider);
    const requests: string[] = [];
    let loseAcknowledgement = true;
    live.provider.reserveProgress = input => {
      const persisted = observer.db.prepare(
        "SELECT reserve_request_json FROM company_progress_intents WHERE operation_id=?",
      ).get(input.operation_id) as { reserve_request_json: string } | undefined;
      expect(persisted?.reserve_request_json).toBe(canonicalize(input));
      expect(live.db.db.inTransaction).toBe(false);
      requests.push(canonicalize(input));
      const result = reserve(input);
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error("TEST_ONLY lost reservation acknowledgement");
      }
      return result;
    };
    try {
      const next = nextApproval(live);
      const control = new ControlPlane(live.db, live.provider);
      expect(() => control.decide(live.approval, NOW)).toThrow("COMPANY_FRESHNESS_REQUIRED");
      expect(() => control.decide(next, NOW)).toThrow("COMPANY_EXECUTION_BUSY");
      expect(requests).toHaveLength(1);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_progress_reservations").get()).toEqual({ n: 0 });
      const { signature: _signature, ...payload } = live.approval;
      void _signature;
      const changedApproval = signCommandApproval({ ...payload, receipt_id: "receipt:changed-intent" }, companyApproverKey());
      expect(() => control.decide(changedApproval, NOW)).toThrow("COMPANY_APPROVAL_INVALID");
      expect(requests).toHaveLength(1);
      control.decide(live.approval, NOW);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toBe(requests[0]);
      expect(control.get(live.command.request_id)?.state).toBe("approved");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts").get()).toEqual({ n: 1 });
    } finally { observer.close(); live.close(); }
  });

  it("safely closes a cancelled decision reservation before admitting another workspace request", async () => {
    const live = await companyApproverV2Database("approve", false);
    const reserve = live.provider.reserveProgress.bind(live.provider);
    let first = true;
    live.provider.reserveProgress = input => {
      const result = reserve(input);
      if (first) {
        first = false;
        new ControlPlane(live.db, live.provider).cancel({
          request_id: live.command.request_id, reason: "TEST_ONLY cancelled during reserve",
          actor: "TEST_ONLY owner", revoked_at: NOW.toISOString(),
        }, NOW);
      }
      return result;
    };
    try {
      const next = nextApproval(live);
      const control = new ControlPlane(live.db, live.provider);
      expect(() => control.decide(live.approval, NOW)).toThrow("COMPANY_APPROVAL_REVOKED");
      expect(() => control.decide(live.approval, NOW)).toThrow("COMPANY_APPROVAL_REVOKED");
      expect(control.get(live.command.request_id)?.state).toBe("cancelled");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_revocations WHERE request_id=?")
        .get(live.command.request_id)).toEqual({ n: 1 });
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts WHERE request_id=?")
        .get(live.command.request_id)).toEqual({ n: 0 });

      control.decide(next, NOW);
      expect(control.get(next.request_id)?.state).toBe("approved");
      expect(live.db.db.prepare(
        "SELECT count(*) AS n,count(finished_checkpoint_json) AS finished FROM company_progress_reservations WHERE request_id=?",
      ).get(live.command.request_id)).toEqual({ n: 1, finished: 1 });
      const revocation = live.db.db.prepare("SELECT payload_digest FROM control_command_revocations WHERE request_id=?")
        .get(live.command.request_id) as { payload_digest: string };
      expect(live.db.db.prepare("SELECT terminal_state,evidence_digest FROM company_progress_reservations WHERE request_id=?")
        .get(live.command.request_id)).toEqual({ terminal_state: "cancelled", evidence_digest: revocation.payload_digest });
      expect(live.db.db.prepare("SELECT lease_fence FROM control_command_requests WHERE request_id=?")
        .get(live.command.request_id)).toEqual({ lease_fence: 0 });
    } finally { live.close(); }
  });

  it.each(["before", "after"] as const)("retries cancelled settlement after a lost %s acknowledgement", async failure => {
    const live = await companyApproverV2Database("approve", false);
    const reserve = live.provider.reserveProgress.bind(live.provider);
    const finish = live.provider.finishProgress.bind(live.provider);
    let cancel = true;
    let unavailable = true;
    const evidence: string[] = [];
    live.provider.reserveProgress = input => {
      const result = reserve(input);
      if (cancel) {
        cancel = false;
        new ControlPlane(live.db, live.provider).cancel({ request_id: live.command.request_id,
          reason: "TEST_ONLY cancelled during reserve", actor: "TEST_ONLY owner", revoked_at: NOW.toISOString() }, NOW);
      }
      return result;
    };
    live.provider.finishProgress = input => {
      if (input.terminal_state === "cancelled") {
        evidence.push(input.evidence_digest);
        if (unavailable) {
          if (failure === "after") finish(input);
          throw new Error("TEST_ONLY cancellation finish unavailable");
        }
      }
      return finish(input);
    };
    try {
      const next = nextApproval(live);
      const control = new ControlPlane(live.db, live.provider);
      expect(() => control.decide(live.approval, NOW)).toThrow("COMPANY_PROGRESS_UNCERTAIN");
      const progress = new CompanyProgress(live.db, live.provider);
      const token = progress.pending(decodeCompanyCommandV2(live.command), "decide_approve");
      if (!token) throw new Error("missing unfinished reservation");
      const calls = evidence.length;
      expect(() => progress.finish(token, controlValueDigest("TEST_ONLY wrong revocation"), "cancelled", NOW))
        .toThrow("COMPANY_PROGRESS_UNCERTAIN");
      expect(evidence).toHaveLength(calls);
      expect(() => control.decide(next, NOW)).toThrow("COMPANY_PROGRESS_UNCERTAIN");
      expect(control.get(next.request_id)?.state).toBe("pending");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts").get()).toEqual({ n: 0 });
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_progress_reservations WHERE finished_checkpoint_json IS NOT NULL")
        .get()).toEqual({ n: 0 });
      unavailable = false;
      control.decide(next, NOW);
      const revoked = live.db.db.prepare("SELECT payload_digest FROM control_command_revocations WHERE request_id=?")
        .get(live.command.request_id) as { payload_digest: string };
      expect(evidence).toHaveLength(3);
      expect(new Set(evidence)).toEqual(new Set([revoked.payload_digest]));
      expect(control.get(live.command.request_id)?.state).toBe("cancelled");
      expect(control.get(next.request_id)?.state).toBe("approved");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts WHERE request_id=?")
        .get(live.command.request_id)).toEqual({ n: 0 });
    } finally { live.close(); }
  });

  it("recovers a cancelled intent with no local reservation before another workspace decision", async () => {
    const live = await companyApproverV2Database("approve", false);
    const reserve = live.provider.reserveProgress.bind(live.provider);
    let cancel = true;
    live.provider.reserveProgress = input => {
      const result = reserve(input);
      if (cancel) {
        cancel = false;
        new ControlPlane(live.db, live.provider).cancel({ request_id: live.command.request_id,
          reason: "TEST_ONLY cancelled before INSERT", actor: "TEST_ONLY owner", revoked_at: NOW.toISOString() }, NOW);
      }
      return result;
    };
    try {
      const next = nextApproval(live);
      const control = new ControlPlane(live.db, live.provider);
      live.db.db.exec(`CREATE TEMP TRIGGER fail_cancelled_reservation BEFORE INSERT ON company_progress_reservations
        BEGIN SELECT RAISE(ABORT,'TEST_ONLY cancelled reservation INSERT failure'); END`);
      expect(() => control.decide(live.approval, NOW)).toThrow("TEST_ONLY cancelled reservation INSERT failure");
      live.db.db.exec("DROP TRIGGER fail_cancelled_reservation");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_progress_reservations").get()).toEqual({ n: 0 });
      expect(() => control.decide(live.approval, NOW)).toThrow("COMPANY_APPROVAL_REVOKED");
      control.decide(next, NOW);
      expect(control.get(next.request_id)?.state).toBe("approved");
      expect(live.db.db.prepare("SELECT terminal_state FROM company_progress_reservations WHERE request_id=?")
        .get(live.command.request_id)).toEqual({ terminal_state: "cancelled" });
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts WHERE request_id=?")
        .get(live.command.request_id)).toEqual({ n: 0 });
    } finally { live.close(); }
  });

  it("preserves a real approval fact when it is revoked before any execution claim", async () => {
    const live = await companyApproverV2Database("approve", false);
    const finish = live.provider.finishProgress.bind(live.provider);
    let cancel = true;
    live.provider.finishProgress = input => {
      if (cancel && input.terminal_state === "approved") {
        cancel = false;
        new ControlPlane(live.db, live.provider).cancel({ request_id: live.command.request_id,
          reason: "TEST_ONLY revoked before execution", actor: "TEST_ONLY owner", revoked_at: NOW.toISOString() }, NOW);
        throw new Error("TEST_ONLY original decision finish interrupted");
      }
      return finish(input);
    };
    try {
      const next = nextApproval(live);
      const control = new ControlPlane(live.db, live.provider);
      expect(() => control.decide(live.approval, NOW)).toThrow("COMPANY_PROGRESS_UNCERTAIN");
      expect(control.get(live.command.request_id)?.state).toBe("cancelled");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts WHERE request_id=?")
        .get(live.command.request_id)).toEqual({ n: 1 });
      expect(live.db.db.prepare("SELECT terminal_state FROM company_progress_reservations WHERE request_id=?")
        .get(live.command.request_id)).toEqual({ terminal_state: "cancelled" });
      expect(live.db.db.prepare("SELECT lease_fence FROM control_command_requests WHERE request_id=?")
        .get(live.command.request_id)).toEqual({ lease_fence: 0 });
      control.decide(next, NOW);
      expect(control.get(next.request_id)?.state).toBe("approved");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts WHERE request_id=?")
        .get(live.command.request_id)).toEqual({ n: 1 });
    } finally { live.close(); }
  });

  it("does not release an active company execution redemption after revocation", async () => {
    const live = await companyApproverV2Database("approve", false);
    try {
      const next = nextApproval(live);
      const control = new ControlPlane(live.db, live.provider);
      control.decide(live.approval, NOW);
      live.db.db.transaction(() => {
        live.db.db.prepare(
          "INSERT INTO control_command_redemptions(receipt_id,request_id,lease_fence,redeemed_at) VALUES(?,?,1,?)",
        ).run(live.approval.receipt_id, live.command.request_id, NOW.toISOString());
        live.db.db.prepare("UPDATE company_candidate_handoffs SET lease_token=?,lease_expires_at=? WHERE request_id=?")
          .run("TEST_ONLY active company execution", new Date(NOW.getTime() + 60_000).toISOString(), live.command.request_id);
      }).immediate();
      control.cancel({ request_id: live.command.request_id, reason: "TEST_ONLY execution already redeemed",
        actor: "TEST_ONLY owner", revoked_at: NOW.toISOString() }, NOW);
      expect(() => control.decide(next, NOW)).toThrow("COMPANY_EXECUTION_BUSY");
      expect(control.get(next.request_id)?.state).toBe("pending");
      expect(live.db.db.prepare("SELECT lease_token FROM company_candidate_handoffs WHERE request_id=?")
        .get(live.command.request_id)).toEqual({ lease_token: "TEST_ONLY active company execution" });
      expect(live.db.db.prepare("SELECT terminal_state FROM company_progress_reservations WHERE request_id=?")
        .get(live.command.request_id)).toEqual({ terminal_state: "approved" });
    } finally { live.close(); }
  });

  it("reuses the provider operation when the local workspace claim is lost during reservation", async () => {
    const live = await companyApproverV2Database("approve", false);
    const reserve = live.provider.reserveProgress.bind(live.provider);
    const operations: string[] = [];
    live.provider.reserveProgress = input => {
      const result = reserve(input); operations.push(input.operation_id);
      if (operations.length === 1) {
        live.db.db.prepare("UPDATE company_candidate_handoffs SET lease_token='TEST_ONLY lost claim',lease_expires_at=? WHERE request_id=?")
          .run(NOW.toISOString(), live.command.request_id);
      }
      return result;
    };
    try {
      const control = new ControlPlane(live.db, live.provider);
      expect(() => control.decide(live.approval, NOW)).toThrow("CONTROL_APPROVAL_RACE");
      control.decide(live.approval, NOW);
      expect(control.get(live.command.request_id)?.state).toBe("approved");
      expect(new Set(operations).size).toBe(1);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts").get()).toEqual({ n: 1 });
    } finally { live.close(); }
  });
});
