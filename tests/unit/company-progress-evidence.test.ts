import { describe, expect, it, vi } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { decodeCompanyCommandV2 } from "../../src/company-candidate-v2-contract.js";
import { CompanyPeerCalls } from "../../src/company-peer-calls.js";
import { readCompanyProgressEvidence, stageCompanyProgressEvidence } from "../../src/company-progress-evidence.js";
import type { CompanyFreshnessProvider } from "../../src/company-freshness.js";
import { transitionRequestDigest } from "../../src/company-transition-read.js";
import { ControlPlane } from "../../src/control-plane.js";
import { companyApproverV2Database } from "../fixtures/company-approver-execution.js";

const NOW = new Date("2026-10-15T00:05:00.000Z");

describe("committed company progress evidence", () => {
  it("commits the original decision and outbox together before finish outside a write transaction", async () => {
    const live = await companyApproverV2Database("approve", false);
    const calls: string[] = [];
    const provider: CompanyFreshnessProvider = {
      readFreshness(request) {
        expect(live.db.db.inTransaction).toBe(false);
        calls.push("read");
        return live.provider.readFreshness(request);
      },
      reserveProgress(request) {
        expect(live.db.db.inTransaction).toBe(false);
        calls.push("reserve");
        return live.provider.reserveProgress(request);
      },
      finishProgress(request) {
        expect(live.db.db.inTransaction).toBe(false);
        expect(readCompanyProgressEvidence(live.db, request.operation_id)).toEqual({
          kind: "jarvis_decision", command: live.command, receipt: live.approval,
        });
        calls.push("finish");
        return live.provider.finishProgress(request);
      },
    };
    try {
      new ControlPlane(live.db, provider).decide(live.approval, NOW);
      expect(calls).toEqual(["read", "reserve", "finish"]);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_progress_evidence_outbox").get()).toEqual({ n: 1 });
    } finally { live.close(); }
  });

  it("retains the reservation but commits no receipt or evidence when the handoff changes after reserve", async () => {
    const live = await companyApproverV2Database("approve", false);
    let finished = 0;
    const provider: CompanyFreshnessProvider = {
      readFreshness: request => live.provider.readFreshness(request),
      reserveProgress(request) {
        const response = live.provider.reserveProgress(request);
        live.db.db.prepare("UPDATE company_candidate_handoffs SET current=0").run();
        return response;
      },
      finishProgress(request) { finished++; return live.provider.finishProgress(request); },
    };
    try {
      expect(() => new ControlPlane(live.db, provider).decide(live.approval, NOW)).toThrow("CONTROL_APPROVAL_NOT_APPLICABLE");
      expect(finished).toBe(0);
      expect(live.db.db.prepare("SELECT request_id,evidence_digest FROM company_progress_reservations").get())
        .toEqual({ request_id: live.command.request_id, evidence_digest: null });
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts").get()).toEqual({ n: 0 });
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_progress_evidence_outbox").get()).toEqual({ n: 0 });
    } finally { live.close(); }
  });

  it("does not treat a staged original signature as proof of a committed decision", async () => {
    const live = await companyApproverV2Database("approve", false);
    try {
      const operationId = stageCompanyProgressEvidence(live.db, {
        kind: "jarvis_decision", command: decodeCompanyCommandV2(live.command), receipt: live.approval,
      });
      expect(() => readCompanyProgressEvidence(live.db, operationId)).toThrow("COMPANY_PROGRESS_UNCERTAIN");
      expect(() => live.db.db.prepare(
        "UPDATE company_progress_evidence_outbox SET evidence_digest=? WHERE operation_id=?",
      ).run(`sha256:${"b".repeat(64)}`, operationId)).toThrow();
      expect(() => live.db.db.prepare("DELETE FROM company_progress_evidence_outbox WHERE operation_id=?").run(operationId)).toThrow();
      live.db.db.prepare("UPDATE company_progress_evidence_outbox SET acknowledged=1 WHERE operation_id=?").run(operationId);
      expect(() => live.db.db.prepare(
        "UPDATE company_progress_evidence_outbox SET acknowledged=0 WHERE operation_id=?",
      ).run(operationId)).toThrow();
    } finally { live.close(); }
  });

  it("rechecks current time after reserve before committing a decision", async () => {
    const live = await companyApproverV2Database("approve", false);
    const provider: CompanyFreshnessProvider = {
      readFreshness: request => live.provider.readFreshness(request),
      reserveProgress(request) {
        const result = live.provider.reserveProgress(request);
        vi.setSystemTime(new Date("2026-10-16T00:00:00.000Z"));
        return result;
      },
      finishProgress: request => live.provider.finishProgress(request),
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      expect(() => new ControlPlane(live.db, provider).decide(live.approval)).toThrow("CONTROL_APPROVAL_NOT_APPLICABLE");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts").get()).toEqual({ n: 0 });
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_progress_reservations WHERE evidence_digest IS NULL").get()).toEqual({ n: 1 });
    } finally { vi.useRealTimers(); live.close(); }
  });

  it("keeps peer identity and the original found projection across legal CAS transitions", async () => {
    const live = await companyApproverV2Database();
    try {
      const original = { candidate_id: live.command.target.candidate_id, handoff_id: live.command.request_id, approval: live.approval };
      const intent = {
        operation_id: `sha256:${"c".repeat(64)}`, provider_instance_id: live.command.target.provider_instance_id,
        workspace_id: live.command.target.workspace_id, request_id: live.command.request_id, operation: "accept" as const,
        transition_request_digest: transitionRequestDigest("accept", original), arguments: original,
      };
      const calls = new CompanyPeerCalls(live.db);
      expect(calls.prepare(intent, NOW).state).toBe("prepared");
      expect(calls.prepare(intent, NOW).original_arguments_json).toBe(canonicalize(original));
      expect(() => calls.prepare({ ...intent, arguments: {} }, NOW)).toThrow("COMPANY_EXECUTION_UNCERTAIN");
      expect(() => calls.prepare({ ...intent, operation_id: `sha256:${"f".repeat(64)}` }, NOW))
        .toThrow(`request_id=${live.command.request_id}`);
      expect(() => live.db.db.prepare(
        `INSERT INTO company_peer_calls SELECT ?,provider_instance_id,workspace_id,request_id,operation,
         transition_request_digest,original_arguments_json,state,receipt_projection_json,created_at,updated_at
         FROM company_peer_calls WHERE operation_id=?`,
      ).run(`sha256:${"f".repeat(64)}`, intent.operation_id)).toThrow();
      calls.invoking(intent.operation_id, NOW);
      calls.uncertain(intent.operation_id, NOW);
      const projection = { receipt_id: `cmreceipt:v1:${"d".repeat(64)}`, receipt_digest: `sha256:${"d".repeat(64)}`,
        operation: "accept", state: "accepted", handoff_id: live.command.request_id };
      calls.found(intent.operation_id, projection, NOW);
      calls.found(intent.operation_id, projection, NOW);
      const found = calls.read(intent.operation_id);
      if (!found) throw new Error("missing peer call");
      expect(found.state).toBe("found");
      expect(calls.projection(found)).toEqual(projection);
      expect(() => calls.invoking(intent.operation_id, NOW)).toThrow("COMPANY_EXECUTION_UNCERTAIN");
      expect(() => calls.found(intent.operation_id, {}, NOW)).toThrow("COMPANY_EXECUTION_UNCERTAIN");
      expect(() => live.db.db.prepare("UPDATE company_peer_calls SET original_arguments_json='{}'").run()).toThrow();
      expect(() => live.db.db.prepare("DELETE FROM company_peer_calls").run()).toThrow();
    } finally { live.close(); }
  });
});
