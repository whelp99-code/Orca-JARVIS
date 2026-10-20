import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CompanyCandidateExecutor } from "../../src/company-candidate-execution.js";
import type { CompanyClient, CompanyOperation } from "../../src/company-candidate-transport.js";
import type { CompanyCompletionVerifierV2 } from "../../src/company-completion-v2.js";
import { companyHandoffKeyV2, decodeCompanyCommandV2 } from "../../src/company-candidate-v2-contract.js";
import { CompanyProgress } from "../../src/company-progress.js";
import type { CompanyFreshnessProvider, CompanyProgressOperation, FinishProgressRequest } from "../../src/company-freshness.js";
import { ControlPlane } from "../../src/control-plane.js";
import { controlCommandDigest, controlValueDigest, signCommandApproval } from "../../src/control-plane-contract.js";
import { importCompanyPage } from "../../src/company-candidate-import.js";
import { AuthorityDb } from "../../src/db.js";
import { companyApproverKey, companyApproverProcessorContext, companyApproverV2Database } from "../fixtures/company-approver-execution.js";
import { COMPANY_CONTEXT, companyApproval, companyClient, companyDatabase, companyProposal } from "../fixtures/company-candidate.js";

const NOW = new Date("2026-10-15T00:05:00.000Z");
const cases = (["decide_approve", "decide_reject", "complete", "mark_processed"] as const)
  .flatMap(operation => (["before", "after"] as const).map(loss => ({ operation, loss })));
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function session(operation?: CompanyProgressOperation, loss: "before" | "after" = "before") {
  const live = await companyApproverV2Database(operation === "decide_reject" || operation === "reject" ? "reject" : "approve", false);
  const command = decodeCompanyCommandV2(live.command);
  const finishes: FinishProgressRequest[] = [];
  let lose = operation !== undefined;
  let freshnessReads = 0;
  const provider: CompanyFreshnessProvider = {
    readFreshness: request => {
      freshnessReads++;
      return live.provider.readFreshness(request);
    },
    reserveProgress: request => live.provider.reserveProgress(request),
    finishProgress: request => {
      finishes.push(structuredClone(request));
      const row = live.db.db.prepare("SELECT operation FROM company_progress_reservations WHERE operation_id=?")
        .get(request.operation_id) as { operation: string } | undefined;
      if (lose && row?.operation === operation) {
        lose = false;
        if (loss === "after") live.provider.finishProgress(request);
        throw new Error("TEST_ONLY lost finish acknowledgement");
      }
      return live.provider.finishProgress(request);
    },
  };
  const calls: Array<{ operation: CompanyOperation; request: string }> = [];
  const effects: string[] = [];
  let failEffect = false;
  let failMark = false;
  const client: CompanyClient = {
    context: companyApproverProcessorContext(), keyId: "processor:finish-retry",
    publicKeyPem: generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString(),
    async call(op, args) {
      const request = String(args.handoff_id);
      calls.push({ operation: op, request });
      if (op === "handoff" || op === "read_transition_receipt") throw new Error("unexpected operation");
      if (op === "mark_processed" && failMark) throw new Error("TEST_ONLY no committed mark receipt");
      const receiptDigest = digest(`${op}:${request}`);
      return { receipt_id: `cmreceipt:v1:${receiptDigest.slice(7)}`, receipt_digest: receiptDigest,
        operation: op, state: op === "accept" ? "accepted" : op === "reject" ? "rejected" : "processed_complete",
        handoff_id: request };
    },
  };
  const verifier: CompanyCompletionVerifierV2 = {
    version: 2,
    async verify(value, acceptance, commandDigest) {
      effects.push(value.request_id);
      if (failEffect) throw new Error("TEST_ONLY no committed completion");
      const path = join(live.root, createHash("sha256").update(value.request_id).digest("hex"));
      writeFileSync(path, `durable effect:${value.request_id}`, { flag: "wx", mode: 0o600 });
      return { schema_version: 2, state: "completed", request_id: value.request_id, command_digest: commandDigest,
        candidate_id: value.target.candidate_id, content_digest: value.target.content_digest,
        acceptance_receipt_digest: acceptance.receipt_digest, effect_digest: digest(readFileSync(path, "utf8")) };
    },
  };
  return { ...live, command, provider, client, verifier, calls, effects, finishes,
    freshnessReads: () => freshnessReads,
    failEffect: () => { failEffect = true; }, failMark: () => { failMark = true; },
    execute: (db = live.db) => new CompanyCandidateExecutor(db, client, verifier, () => NOW, provider).execute(command.request_id) };
}

describe("committed company finish retry", () => {
  it.each((["accept", "reject"] as const).flatMap(operation =>
    (["before", "after"] as const).map(loss => ({ operation, loss }))))(
    "$operation lost_$loss restores durable terminal state without a verifier", async ({ operation, loss }) => {
      const live = await session(operation, loss);
      try {
        new ControlPlane(live.db, live.provider).decide(live.approval, NOW);
        const executor = new CompanyCandidateExecutor(live.db, live.client, undefined, () => NOW, live.provider);
        await expect(executor.execute(live.command.request_id)).rejects.toThrow("COMPANY_PROGRESS_UNCERTAIN");
        expect(live.db.db.prepare("SELECT status,lease_token FROM company_candidate_handoffs").get())
          .toEqual({ status: "uncertain", lease_token: null });
        const first = live.finishes.at(-1);
        if (!first) throw new Error("Missing initial finish request");
        const restarted = new AuthorityDb(live.db.filename);
        const terminal = operation === "accept" ? "accepted" : "rejected";

        try {
          expect((await new CompanyCandidateExecutor(restarted, live.client, undefined, () => NOW, live.provider)
            .execute(live.command.request_id)).state).toBe(terminal);
        } finally { restarted.close(); }

        expect(live.db.db.prepare("SELECT status,failure_code,lease_token,lease_expires_at FROM company_candidate_handoffs").get())
          .toEqual({ status: terminal, failure_code: null, lease_token: null, lease_expires_at: null });
        const retries = live.finishes.filter(request => request.operation_id === first.operation_id);
        expect(retries).toHaveLength(2);
        expect({ ...retries[1], challenge: first.challenge }).toEqual(first);
        expect(live.calls.filter(call => call.operation === operation)).toHaveLength(1);
        expect(live.effects).toEqual([]);
      } finally { live.close(); }
    },
  );

  it.each(cases)("$operation lost_$loss repairs only the original finish and unblocks the next candidate", async ({ operation, loss }) => {
    const live = await session(operation, loss);
    try {
      const backup = join(live.root, "before.sqlite");
      await live.db.db.backup(backup);
      const control = new ControlPlane(live.db, live.provider);
      if (operation.startsWith("decide_")) {
        expect(() => control.decide(live.approval, NOW)).toThrow("COMPANY_PROGRESS_UNCERTAIN");
      } else {
        control.decide(live.approval, NOW);
        await expect(live.execute()).rejects.toThrow("COMPANY_PROGRESS_UNCERTAIN");
      }
      const original = live.db.db.prepare(
        "SELECT reservation_id,operation_id FROM company_progress_reservations WHERE operation=? AND evidence_digest IS NULL",
      ).get(operation) as { reservation_id: string; operation_id: string };
      expect(original).toBeDefined();
      const firstFinish = live.finishes.find(request => request.operation_id === original.operation_id)!;
      if (operation === "mark_processed") {
        expect(control.get(live.command.request_id)?.state).toBe("approved");
        expect(live.db.db.prepare("SELECT count(*) AS n FROM company_candidate_sb_receipts WHERE operation='mark_processed'").get())
          .toEqual({ n: 1 });
      }
      const next = structuredClone(live.command);
      next.target.candidate_id += ":next";
      const key = companyHandoffKeyV2(next);
      next.request_id = `${key}:1`; next.nonce = next.request_id;
      const nextDigest = controlCommandDigest(next);
      importCompanyPage(live.db, { handoffs: [{ idempotency_key: key, command: next, command_digest: nextDigest }],
        count: 1, limit: 100, offset: 0 }, live.client.context, NOW);
      const { signature: _signature, ...payload } = live.approval;
      void _signature;
      const nextApproval = signCommandApproval({ ...payload, decision: "approve", receipt_id: "receipt:next",
        request_id: next.request_id, command_digest: nextDigest, nonce: "nonce:next" }, companyApproverKey());
      const before = control.get(next.request_id);
      const reads = live.freshnessReads();
      let blocked: unknown;
      try { control.decide(nextApproval, NOW); }
      catch (error) { blocked = error; }
      expect(blocked).toMatchObject({
        code: "COMPANY_PROGRESS_UNCERTAIN", message: expect.stringContaining(live.command.request_id),
      });
      expect(live.freshnessReads()).toBe(reads);
      expect(control.get(next.request_id)).toEqual(before);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts WHERE request_id=?").get(next.request_id))
        .toEqual({ n: 0 });
      const restarted = new AuthorityDb(live.db.filename);
      try { expect((await live.execute(restarted)).state).toBe(operation === "decide_reject" ? "rejected" : "completed"); }
      finally { restarted.close(); }
      expect(control.get(live.command.request_id)?.state).toBe(operation === "decide_reject" ? "rejected" : "completed");
      expect(live.db.db.prepare("SELECT status FROM company_candidate_handoffs WHERE request_id=?").pluck().get(live.command.request_id))
        .toBe(operation === "decide_reject" ? "rejected" : "completed");
      const retries = live.finishes.filter(request => request.operation_id === original.operation_id);
      expect(retries).toHaveLength(2);
      expect({ ...retries[1], challenge: firstFinish.challenge }).toEqual(firstFinish);
      expect(retries[1]?.reservation_id).toBe(original.reservation_id);
      expect(live.db.db.prepare("SELECT evidence_digest FROM company_progress_reservations WHERE operation_id=?").get(original.operation_id))
        .toEqual({ evidence_digest: firstFinish.evidence_digest });
      expect(live.calls.filter(call => call.operation === (operation === "decide_reject" ? "reject" : "accept"))).toHaveLength(1);
      expect(live.calls.filter(call => call.operation === "mark_processed")).toHaveLength(operation === "decide_reject" ? 0 : 1);
      expect(live.effects).toHaveLength(operation === "decide_reject" ? 0 : 1);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts").get()).toEqual({ n: 1 });

      control.decide(nextApproval, NOW);
      expect((await new CompanyCandidateExecutor(live.db, live.client, live.verifier, () => NOW, live.provider)
        .execute(next.request_id)).state).toBe("completed");

      const restored = new AuthorityDb(backup);
      try {
        expect(() => new ControlPlane(restored, live.provider).decide(live.approval, NOW)).toThrow("COMPANY_OPERATIONAL_ROLLBACK");
        expect(restored.db.prepare("SELECT count(*) AS n FROM control_command_receipts").get()).toEqual({ n: 0 });
      } finally { restored.close(); }
    } finally { live.close(); }
  });

  it("preserves the blocking request when a preapproved candidate executes", async () => {
    const live = await session("complete", "before");
    try {
      const control = new ControlPlane(live.db, live.provider);
      control.decide(live.approval, NOW);
      const next = structuredClone(live.command);
      next.target.candidate_id += ":preapproved";
      const key = companyHandoffKeyV2(next);
      next.request_id = `${key}:1`; next.nonce = next.request_id;
      const nextDigest = controlCommandDigest(next);
      importCompanyPage(live.db, { handoffs: [{ idempotency_key: key, command: next, command_digest: nextDigest }],
        count: 1, limit: 100, offset: 0 }, live.client.context, NOW);
      const { signature: _signature, ...payload } = live.approval;
      void _signature;
      control.decide(signCommandApproval({ ...payload, receipt_id: "receipt:preapproved",
        request_id: next.request_id, command_digest: nextDigest, nonce: "nonce:preapproved" }, companyApproverKey()), NOW);
      await expect(live.execute()).rejects.toThrow("COMPANY_PROGRESS_UNCERTAIN");
      const reads = live.freshnessReads();
      await expect(new CompanyCandidateExecutor(live.db, live.client, live.verifier, () => NOW, live.provider)
        .execute(next.request_id)).rejects.toMatchObject({
        code: "COMPANY_PROGRESS_UNCERTAIN", message: expect.stringContaining(live.command.request_id),
      });
      expect(live.freshnessReads()).toBe(reads);
      expect(live.calls.filter(call => call.request === next.request_id)).toEqual([]);
      expect(live.effects).toEqual([live.command.request_id]);
    } finally { live.close(); }
  });

  it("allows another SQLite writer while processed completion waits for its provider", async () => {
    const live = await session();
    const other = new AuthorityDb(live.db.filename);
    other.db.pragma("busy_timeout = 0");
    other.db.exec("CREATE TABLE test_finish_writer(value TEXT)");
    const transactions: boolean[] = [];
    const writeErrors: unknown[] = [];
    const provider: CompanyFreshnessProvider = {
      ...live.provider,
      finishProgress(request) {
        if (request.terminal_state === "processed_complete") {
          transactions.push(live.db.db.inTransaction);
          try {
            other.db.transaction(() => other.db.prepare("INSERT INTO test_finish_writer VALUES(?)").run("provider")).immediate();
          } catch (error) { writeErrors.push(error); }
        }
        return live.provider.finishProgress(request);
      },
    };
    try {
      const control = new ControlPlane(live.db, provider);
      control.decide(live.approval, NOW);
      expect((await new CompanyCandidateExecutor(live.db, live.client, live.verifier, () => NOW, provider)
        .execute(live.command.request_id)).state).toBe("completed");
      expect(writeErrors).toEqual([]);
      expect(transactions).toEqual([false]);
      expect(other.db.prepare("SELECT count(*) AS n FROM test_finish_writer").get()).toEqual({ n: 1 });
      expect(control.get(live.command.request_id)?.state).toBe("completed");
    } finally { other.close(); live.close(); }
  });

  it.each(["checkpoint", "publication"] as const)("keeps the receipt but rolls back completion when %s fails", async phase => {
    const live = await session();
    try {
      const control = new ControlPlane(live.db, live.provider);
      control.decide(live.approval, NOW);
      live.db.db.exec(phase === "checkpoint" ? `CREATE TEMP TRIGGER fail_finished_mark_checkpoint
        BEFORE UPDATE OF checkpoint_json ON company_freshness_checkpoints
        WHEN EXISTS (SELECT 1 FROM company_progress_reservations
          WHERE operation='mark_processed' AND finished_checkpoint_json IS NOT NULL)
        BEGIN SELECT RAISE(ABORT,'TEST_ONLY checkpoint CAS failed'); END`
        : `CREATE TEMP TRIGGER fail_finished_mark_checkpoint
        BEFORE UPDATE OF state ON control_command_requests WHEN NEW.state='completed'
        BEGIN SELECT RAISE(ABORT,'TEST_ONLY terminal publication failed'); END`);
      await expect(live.execute()).rejects.toThrow(phase === "checkpoint"
        ? "TEST_ONLY checkpoint CAS failed" : "TEST_ONLY terminal publication failed");
      expect(control.get(live.command.request_id)?.state).toBe("approved");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_candidate_sb_receipts WHERE operation='mark_processed'").get())
        .toEqual({ n: 1 });
      expect(live.db.db.prepare("SELECT evidence_digest FROM company_progress_reservations WHERE operation='mark_processed'").get())
        .toEqual({ evidence_digest: null });
      expect(live.db.db.prepare("SELECT checkpoint_json FROM company_freshness_checkpoints").pluck().get())
        .toBe(live.db.db.prepare("SELECT checkpoint_json FROM company_progress_reservations WHERE operation='mark_processed'").pluck().get());
      const first = live.finishes.find(request => request.terminal_state === "processed_complete");
      live.db.db.exec("DROP TRIGGER fail_finished_mark_checkpoint");
      expect((await live.execute()).state).toBe("completed");
      expect(control.get(live.command.request_id)?.state).toBe("completed");
      expect(live.finishes.filter(request => request.operation_id === first?.operation_id)).toHaveLength(2);
      expect(live.calls.filter(call => call.operation === "mark_processed")).toHaveLength(1);
      expect(live.effects).toHaveLength(1);
    } finally { live.close(); }
  });

  it("rejects a v1 verifier for command2 before any reservation, redemption or state change", async () => {
    const live = await session();
    try {
      new ControlPlane(live.db, live.provider).decide(live.approval, NOW);
      const before = live.db.db.prepare("SELECT * FROM company_candidate_handoffs").get();
      const counts = live.db.db.prepare("SELECT count(*) AS n FROM company_progress_reservations").get();
      const executor = new CompanyCandidateExecutor(live.db, live.client,
        { version: 1, verify: async () => { throw new Error("must not run"); } }, () => NOW, live.provider);
      await expect(executor.execute(live.command.request_id)).rejects.toThrow("COMPANY_VERIFIER_INVALID");
      expect(live.calls).toEqual([]);
      expect(live.db.db.prepare("SELECT * FROM company_candidate_handoffs").get()).toEqual(before);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_progress_reservations").get()).toEqual(counts);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_redemptions").get()).toEqual({ n: 0 });
    } finally { live.close(); }
  });

  it("rejects a v2 verifier for command1 before any acceptance or redemption", async () => {
    const live = await companyDatabase();
    try {
      const proposal = companyProposal();
      const control = new ControlPlane(live.db);
      importCompanyPage(live.db, { handoffs: [proposal], count: 1, limit: 100, offset: 0 }, COMPANY_CONTEXT,
        new Date(proposal.command.requested_at));
      control.decide(companyApproval(proposal), new Date(proposal.command.requested_at));
      let calls = 0;
      const executor = new CompanyCandidateExecutor(live.db, companyClient(async () => { calls++; throw new Error("must not call"); }),
        { version: 2, verify: async () => { throw new Error("must not run"); } }, () => new Date(proposal.command.requested_at));
      await expect(executor.execute(proposal.command.request_id)).rejects.toThrow("COMPANY_COMPLETION_CONFIG_INVALID");
      expect(calls).toBe(0);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_redemptions").get()).toEqual({ n: 0 });
    } finally { live.close(); }
  });

  it.each(["decide_approve", "complete", "mark_processed"] as const)("does not finish %s without its committed evidence", async operation => {
    const live = await session();
    try {
      if (operation === "decide_approve") {
        new CompanyProgress(live.db, live.provider).reserve(live.command, operation, controlValueDigest(live.approval), NOW);
      } else {
        new ControlPlane(live.db, live.provider).decide(live.approval, NOW);
        if (operation === "complete") live.failEffect();
        else live.failMark();
        await expect(live.execute()).rejects.toThrow();
      }
      const count = live.finishes.length;
      const effects = live.effects.length;
      const calls = live.calls.length;
      await expect(live.execute()).rejects.toThrow();
      expect(live.finishes).toHaveLength(count);
      expect(live.effects).toHaveLength(effects);
      expect(live.calls).toHaveLength(calls);
      expect(live.db.db.prepare("SELECT evidence_digest FROM company_progress_reservations WHERE operation=?").get(operation))
        .toEqual({ evidence_digest: null });
    } finally { live.close(); }
  });
  it("keeps a completed handoff when finishProgress synchronously loses the lease before returning", async () => {
    const live = await session();
    try {
      new ControlPlane(live.db, live.provider).decide(live.approval, NOW);
      const provider = live.provider;
      const finish = provider.finishProgress.bind(provider);
      provider.finishProgress = request => {
        if (request.terminal_state !== "accepted") return finish(request);
        const stolen = live.db.db.prepare(
          "UPDATE company_candidate_handoffs SET lease_token='winner-lease',lease_expires_at=?,status='completing',updated_at=? WHERE request_id=?",
        ).run(new Date(NOW.getTime() + 60_000).toISOString(), NOW.toISOString(), live.command.request_id);
        expect(stolen.changes).toBe(1);
        live.db.db.prepare(
          "UPDATE control_command_requests SET state='completed',completed_at=? WHERE request_id=? AND state='approved'",
        ).run(NOW.toISOString(), live.command.request_id);
        live.db.db.prepare(
          "UPDATE company_candidate_handoffs SET status='completed',failure_code=NULL,updated_at=? WHERE request_id=?",
        ).run(NOW.toISOString(), live.command.request_id);
        return finish(request);
      };
      await expect(live.execute()).rejects.toMatchObject({ code: "COMPANY_EXECUTION_BUSY" });
      expect(live.db.db.prepare("SELECT status,lease_token FROM company_candidate_handoffs WHERE request_id=?").get(live.command.request_id))
        .toEqual({ status: "completed", lease_token: "winner-lease" });
      expect(live.db.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(live.command.request_id))
        .toEqual({ state: "completed" });
      expect(live.finishes.filter(request => request.terminal_state === "accepted")).toHaveLength(1);
      expect(live.db.db.prepare(
        "SELECT evidence_digest FROM company_progress_reservations WHERE operation='accept'",
      ).get()).toEqual({ evidence_digest: null });
    } finally { live.close(); }
  });
  it("does not publish accepted over a winner completing handoff after a synchronous lease steal", async () => {
    const live = await session();
    try {
      new ControlPlane(live.db, live.provider).decide(live.approval, NOW);
      const provider = live.provider;
      const finish = provider.finishProgress.bind(provider);
      provider.finishProgress = request => {
        if (request.terminal_state !== "accepted") return finish(request);
        const stolen = live.db.db.prepare(
          "UPDATE company_candidate_handoffs SET lease_token='winner-lease',lease_expires_at=?,status='completing',updated_at=? WHERE request_id=?",
        ).run(new Date(NOW.getTime() + 60_000).toISOString(), NOW.toISOString(), live.command.request_id);
        expect(stolen.changes).toBe(1);
        return finish(request);
      };
      await expect(live.execute()).rejects.toMatchObject({ code: "COMPANY_EXECUTION_BUSY" });
      expect(live.db.db.prepare("SELECT status,lease_token FROM company_candidate_handoffs WHERE request_id=?").get(live.command.request_id))
        .toEqual({ status: "completing", lease_token: "winner-lease" });
      expect(live.db.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(live.command.request_id))
        .toEqual({ state: "approved" });
      expect(live.db.db.prepare("SELECT evidence_digest FROM company_progress_reservations WHERE operation='accept'").get())
        .toEqual({ evidence_digest: null });
    } finally { live.close(); }
  });

  it("refuses a stale lease before publishing an already_recorded accept and preserves completed", async () => {
    const live = await session();
    try {
      new ControlPlane(live.db, live.provider).decide(live.approval, NOW);
      const reserved = new CompanyProgress(live.db, live.provider).reserve(
        live.command, "accept", digest("stale-lease-event"), NOW,
      );
      live.db.db.prepare(
        "UPDATE company_candidate_handoffs SET status='completed',lease_token='expired-lease',lease_expires_at=?,failure_code=NULL,updated_at=? WHERE request_id=?",
      ).run(new Date(NOW.getTime() - 1_000).toISOString(), NOW.toISOString(), live.command.request_id);
      live.db.db.prepare(
        "UPDATE control_command_requests SET state='completed',completed_at=? WHERE request_id=?",
      ).run(NOW.toISOString(), live.command.request_id);
      const before = live.finishes.length;
      const executor = new CompanyCandidateExecutor(live.db, live.client, live.verifier, () => NOW, live.provider);
      const finish = executor["finishV2"].bind(executor) as (
        progress: CompanyProgress, reservation: typeof reserved, evidenceDigest: string,
        terminalState: "accepted", token: string,
      ) => void;
      expect(() => finish(new CompanyProgress(live.db, live.provider), reserved, digest("stale-evidence"), "accepted", "expired-lease"))
        .toThrow("COMPANY_EXECUTION_BUSY");
      expect(live.finishes).toHaveLength(before);
      expect(live.db.db.prepare("SELECT status,lease_token FROM company_candidate_handoffs").get())
        .toEqual({ status: "completed", lease_token: "expired-lease" });
      expect(live.db.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(live.command.request_id))
        .toEqual({ state: "completed" });
    } finally { live.close(); }
  });

  it("publishes an owned accept and leaves an already_recorded duplicate on the same terminal state", async () => {
    const live = await session();
    try {
      new ControlPlane(live.db, live.provider).decide(live.approval, NOW);
      const token = "owned-lease";
      live.db.db.prepare(
        "UPDATE company_candidate_handoffs SET lease_token=?,lease_expires_at=?,updated_at=? WHERE request_id=?",
      ).run(token, new Date(NOW.getTime() + 60_000).toISOString(), NOW.toISOString(), live.command.request_id);
      const progress = new CompanyProgress(live.db, live.provider);
      const reserved = progress.reserve(live.command, "accept", digest("owned-event"), NOW);
      const executor = new CompanyCandidateExecutor(live.db, live.client, live.verifier, () => NOW, live.provider);
      const finish = executor["finishV2"].bind(executor) as (
        progress: CompanyProgress, reservation: typeof reserved, evidenceDigest: string,
        terminalState: "accepted", token: string,
      ) => void;
      finish(progress, reserved, digest("owned-evidence"), "accepted", token);
      expect(live.db.db.prepare("SELECT status FROM company_candidate_handoffs").get()).toEqual({ status: "accepted" });
      expect(live.finishes.at(-1)?.terminal_state).toBe("accepted");
      const again = structuredClone(live.finishes.at(-1)!);
      again.challenge = "challenge:TEST_ONLY:already-recorded";
      expect(live.provider.finishProgress(again).outcome).toBe("already_recorded");
      finish(progress, reserved, digest("owned-evidence"), "accepted", token);
      expect(live.db.db.prepare("SELECT status FROM company_candidate_handoffs").get()).toEqual({ status: "accepted" });
      expect(live.db.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(live.command.request_id))
        .toEqual({ state: "approved" });
    } finally { live.close(); }
  });
  it.each(["complete", "mark_processed"] as const)(
    "tokenless %s recovery keeps the current lease and does not regress a foreign completed handoff",
    async operation => {
      const live = await session();
      try {
        new ControlPlane(live.db, live.provider).decide(live.approval, NOW);
        const progress = new CompanyProgress(live.db, live.provider);
        const event = digest(`${operation}-recovery-event`);
        const reserved = progress.reserve(live.command, operation, event, NOW);
        const evidence = digest(`${operation}-recovery-evidence`);
        const holder = "current-holder";
        live.db.db.prepare(
          "UPDATE company_candidate_handoffs SET status='completed',lease_token=?,lease_expires_at=?,failure_code=NULL,updated_at=? WHERE request_id=?",
        ).run(holder, new Date(NOW.getTime() + 60_000).toISOString(), NOW.toISOString(), live.command.request_id);
        live.db.db.prepare(
          "UPDATE control_command_requests SET state='completed',completed_at=? WHERE request_id=?",
        ).run(NOW.toISOString(), live.command.request_id);
        const before = {
          handoff: live.db.db.prepare("SELECT status,lease_token FROM company_candidate_handoffs").get(),
          control: live.db.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(live.command.request_id),
          finishes: live.finishes.length,
        };
        const executor = new CompanyCandidateExecutor(live.db, live.client, live.verifier, () => NOW, live.provider);
        const finish = executor["finishV2"].bind(executor) as (
          progress: CompanyProgress, reservation: typeof reserved, evidenceDigest: string,
          terminalState: "completed" | "processed_complete",
        ) => void;
        finish(progress, reserved, evidence, operation === "complete" ? "completed" : "processed_complete");
        expect(live.provider.finishProgress({
          ...live.finishes.at(-1)!, challenge: `challenge:TEST_ONLY:${operation}-already`,
        }).outcome).toBe("already_recorded");
        expect(live.db.db.prepare("SELECT status,lease_token FROM company_candidate_handoffs").get()).toEqual(before.handoff);
        expect(live.db.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(live.command.request_id))
          .toEqual(before.control);
        expect(before.handoff).toEqual({ status: "completed", lease_token: holder });
        expect(before.control).toEqual({ state: "completed" });
        expect(live.finishes.length).toBeGreaterThan(before.finishes);
      } finally { live.close(); }
    },
  );
  it("tokenless processed_complete refuses a non-completed handoff after finishProgress loses the lease", async () => {
    const live = await session();
    try {
      new ControlPlane(live.db, live.provider).decide(live.approval, NOW);
      const progress = new CompanyProgress(live.db, live.provider);
      const reserved = progress.reserve(live.command, "mark_processed", digest("foreign-processed-event"), NOW);
      live.db.db.prepare(
        "UPDATE company_candidate_handoffs SET status='completing',lease_token='holder-lease',lease_expires_at=?,updated_at=? WHERE request_id=?",
      ).run(new Date(NOW.getTime() + 60_000).toISOString(), NOW.toISOString(), live.command.request_id);
      const executor = new CompanyCandidateExecutor(live.db, live.client, live.verifier, () => NOW, live.provider);
      const finish = executor["finishV2"].bind(executor) as (
        progress: CompanyProgress, reservation: typeof reserved, evidenceDigest: string,
        terminalState: "processed_complete",
      ) => void;
      const provider = live.provider;
      const recorded = provider.finishProgress.bind(provider);
      let stolenDuringFinish = false;
      provider.finishProgress = request => {
        if (request.terminal_state === "processed_complete") {
          const stolen = live.db.db.prepare(
            "UPDATE company_candidate_handoffs SET lease_token='other-lease',status='completing',lease_expires_at=?,updated_at=? WHERE request_id=? AND lease_token='holder-lease'",
          ).run(new Date(NOW.getTime() + 60_000).toISOString(), NOW.toISOString(), live.command.request_id);
          expect(stolen.changes).toBe(1);
          stolenDuringFinish = true;
        }
        return recorded(request);
      };
      expect(stolenDuringFinish).toBe(false);
      expect(() => finish(progress, reserved, digest("foreign-processed-evidence"), "processed_complete"))
        .toThrow("COMPANY_EXECUTION_BUSY");
      expect(stolenDuringFinish).toBe(true);
      expect(live.db.db.prepare("SELECT status,lease_token FROM company_candidate_handoffs").get())
        .toEqual({ status: "completing", lease_token: "other-lease" });
      expect(live.db.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(live.command.request_id))
        .toEqual({ state: "approved" });
      expect(live.db.db.prepare("SELECT evidence_digest FROM company_progress_reservations WHERE operation='mark_processed'").get())
        .toEqual({ evidence_digest: null });
    } finally { live.close(); }
  });
  it.each(["equal", "past"] as const)(
    "refuses publish when the lease expires during finishProgress and the clock is %s to expiry",
    async boundary => {
      const opened = await session();
      const clock = { at: NOW };
      try {
        new ControlPlane(opened.db, opened.provider).decide(opened.approval, NOW);
        const command = decodeCompanyCommandV2(opened.command);
        const token = "delayed-lease";
        const expiry = new Date(NOW.getTime() + 60_000);
        opened.db.db.prepare(
          "UPDATE company_candidate_handoffs SET status='invoking',lease_token=?,lease_expires_at=?,updated_at=? WHERE request_id=?",
        ).run(token, expiry.toISOString(), NOW.toISOString(), command.request_id);
        const reserved = new CompanyProgress(opened.db, opened.provider).reserve(command, "accept", digest("delayed-event"), NOW);
        let observed = 0;
        const delaying: CompanyFreshnessProvider = {
          readFreshness: request => opened.provider.readFreshness(request),
          reserveProgress: request => opened.provider.reserveProgress(request),
          finishProgress: request => {
            observed++;
            clock.at = boundary === "equal" ? new Date(expiry) : new Date(expiry.getTime() + 1);
            return opened.provider.finishProgress(request);
          },
        };
        const executor = new CompanyCandidateExecutor(opened.db, opened.client, undefined, () => clock.at, delaying);
        const finish = executor["finishV2"].bind(executor) as (
          progress: CompanyProgress, reservation: typeof reserved, evidenceDigest: string,
          terminalState: "accepted", token: string,
        ) => void;
        expect(() => finish(new CompanyProgress(opened.db, delaying), reserved, digest("delayed-evidence"), "accepted", token))
          .toThrow("COMPANY_EXECUTION_BUSY");
        expect(observed).toBe(1);
        expect(clock.at.getTime()).toBeGreaterThanOrEqual(expiry.getTime());
        expect(opened.db.db.prepare("SELECT status,lease_token,lease_expires_at FROM company_candidate_handoffs").get())
          .toEqual({ status: "invoking", lease_token: token, lease_expires_at: expiry.toISOString() });
        expect(opened.db.db.prepare("SELECT evidence_digest FROM company_progress_reservations WHERE operation='accept'").get())
          .toEqual({ evidence_digest: null });
        expect(opened.db.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(command.request_id))
          .toEqual({ state: "approved" });
      } finally { opened.close(); }
    },
  );
});
