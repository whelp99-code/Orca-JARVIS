import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { CompanyCandidateExecutor } from "../../src/company-candidate-execution.js";
import { decodeCompanyCommandV2 } from "../../src/company-candidate-v2-contract.js";
import type { CompanyClient } from "../../src/company-candidate-transport.js";
import type { CompanyCompletionVerifierV2 } from "../../src/company-completion-v2.js";
import { companyCheckpointSchema, companyOperationId, reserveProgressRequestSchema, type CompanyCheckpoint, type CompanyFreshnessProvider } from "../../src/company-freshness.js";
import { CompanyProgress } from "../../src/company-progress.js";
import { companyMemoryRequestDigest, transitionReadArgumentsSchema, transitionRequestDigest,
  type TransitionReadArguments, type TransitionReceiptProjection } from "../../src/company-transition-read.js";
import { ControlPlane } from "../../src/control-plane.js";
import { controlValueDigest } from "../../src/control-plane-contract.js";
import { AuthorityDb } from "../../src/db.js";
import { TestOnlyCompanyDbProtocol } from "../fixtures/company-db-protocol.js";
import { companyApproverProcessorContext, companyApproverV2Database } from "../fixtures/company-approver-execution.js";

const NOW = new Date("2026-10-15T00:05:00.000Z");
const EXPIRED = new Date("2026-10-16T00:00:00.000Z");
const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
const PROCESSOR_PUBLIC_KEY = createPublicKey(createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]),
  format: "der", type: "pkcs8",
})).export({ type: "spki", format: "pem" }).toString();

async function consumer(recordDecision = true, decision: "approve" | "reject" = "approve") {
  const live = await companyApproverV2Database(decision, false);
  const command = decodeCompanyCommandV2(live.command);
  const scope = { provider_instance_id: command.target.provider_instance_id, workspace_id: command.target.workspace_id };
  const initial = companyCheckpointSchema.parse(JSON.parse(String(live.db.db.prepare(
    "SELECT checkpoint_json FROM company_freshness_checkpoints",
  ).pluck().get())));
  const provider = new TestOnlyCompanyDbProtocol(scope, initial);
  if (recordDecision) new ControlPlane(live.db, provider).decide(live.approval, NOW);
  return { ...live, command, scope, provider };
}

/** Models the other owner's phase around real JARVIS SQL; not real SB or anchor integration. */
function peer(live: Awaited<ReturnType<typeof consumer>>) {
  const counts = { accept: 0, reject: 0, mark_processed: 0, read: 0 };
  const originals = new Map<string, { selector: TransitionReadArguments; receipt: TransitionReceiptProjection }>();
  let lose: "accept" | "reject" | "mark_processed" | undefined;
  const client: CompanyClient = {
    context: companyApproverProcessorContext(), keyId: "key:TEST_ONLY:processor", publicKeyPem: PROCESSOR_PUBLIC_KEY,
    async call(operation, args, at = NOW, nonce) {
      if (operation === "handoff") throw new Error("TEST_ONLY_OPERATION_DENIED");
      if (operation === "read_transition_receipt") {
        counts.read++;
        const selector = transitionReadArgumentsSchema.parse(args);
        const original = originals.get(selector.operation);
        const found = original && canonicalize(original.selector) === canonicalize(selector);
        return { schema_version: 2, ...live.scope, selector, lookup_nonce: nonce,
          lookup_request_digest: companyMemoryRequestDigest("read_transition_receipt", args),
          outcome: found ? "found" : "not_found", receipt: found ? structuredClone(original.receipt) : null };
      }
      counts[operation]++;
      const operationId = companyOperationId({ scope: live.scope, request_id: live.command.request_id,
        command_digest: live.digest, operation });
      const reserved = live.provider.reserveProgress({ schema_version: 2, scope: live.scope, operation_id: operationId,
        operation, expected_checkpoint: live.provider.checkpoint, event_digest: transitionRequestDigest(operation, args),
        challenge: `server:${operation}` });
      if (reserved.outcome !== "reserved") throw new Error("TEST_ONLY_DUPLICATE_PHASE_RESERVATION");
      const receiptDigest = digest({ operation, arguments: args, original_at: at.toISOString() });
      const receipt: TransitionReceiptProjection = {
        receipt_id: `cmreceipt:v1:${receiptDigest.slice(7)}`, receipt_digest: receiptDigest, operation,
        state: operation === "accept" ? "accepted" : operation === "reject" ? "rejected" : "processed_complete",
        handoff_id: live.command.request_id, receipt_created_at: at.toISOString(), decision_at: NOW.toISOString(),
        accepted_at: operation === "reject" ? null : NOW.toISOString(),
      };
      originals.set(operation, { receipt, selector: {
        candidate_id: live.command.target.candidate_id, handoff_id: live.command.request_id, operation,
        transition_request_digest: transitionRequestDigest(operation, args), command_digest: live.digest,
        content_digest: live.command.target.content_digest, approval_policy_version: live.command.args.approval_policy_version,
        approval_binding_digest: live.command.args.approval_binding_digest,
      } });
      const finished = live.provider.finishProgress({ schema_version: 2, scope: live.scope, operation_id: operationId,
        reservation_id: reserved.reservation_id, expected_checkpoint: reserved.checkpoint, evidence_digest: receiptDigest,
        terminal_state: receipt.state, challenge: `server:finish:${operation}` });
      if (finished.outcome !== "recorded") throw new Error("TEST_ONLY_PHASE_FINISH_FAILED");
      if (lose === operation) { lose = undefined; throw new Error("TEST_ONLY_PEER_ACK_LOST"); }
      return structuredClone(receipt);
    },
  };
  return { client, counts, originals, loseNext(operation: "accept" | "reject" | "mark_processed") { lose = operation; } };
}

function verifier(path: string): CompanyCompletionVerifierV2 {
  return { version: 2, async verify(command, acceptance, commandDigest) {
    writeFileSync(path, "consumer-effect", { mode: 0o600, flag: "wx" });
    return { schema_version: 2, state: "completed", request_id: command.request_id, command_digest: commandDigest,
      candidate_id: command.target.candidate_id, content_digest: command.target.content_digest,
      acceptance_receipt_digest: acceptance.receipt_digest,
      effect_digest: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}` };
  } };
}

describe("new-kind consumer ownership and original-fact recovery", () => {
  it("retires a definitive SB CAS conflict while preserving the original call identity", async () => {
    const live = await consumer(false);
    const reserve = live.provider.reserveProgress.bind(live.provider);
    let calls = 0;
    live.provider.reserveProgress = request => {
      calls++;
      const next = live.provider.checkpoint;
      next.intent_sequence++;
      next.intent_root = digest("TEST_ONLY other-store intent");
      next.stores.second_brain.receipt_sequence++;
      next.stores.second_brain.receipt_root = digest("TEST_ONLY other-store receipt");
      live.provider.attest(next);
      return reserve(request);
    };
    try {
      const control = new ControlPlane(live.db, live.provider);
      expect(() => control.decide(live.approval, NOW)).toThrow("COMPANY_RESERVATION_CONFLICT");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_progress_intent_refusals").get()).toEqual({ n: 1 });
      expect(live.db.db.prepare("SELECT count(*) AS n FROM company_peer_calls").get()).toEqual({ n: 1 });
      const progress = new CompanyProgress(live.db, live.provider);
      expect(progress.synchronize(live.scope, NOW)).toEqual(live.provider.checkpoint);
      expect(() => control.decide(live.approval, NOW)).toThrow("COMPANY_RESERVATION_CONFLICT");
      expect(calls).toBe(1);
      control.cancel({ request_id: live.command.request_id, reason: "restage definitively refused operation",
        actor: "test-operator", revoked_at: NOW.toISOString() }, NOW);
      progress.settleCancelled(live.scope, NOW);
      expect(live.db.db.prepare("SELECT lease_token FROM company_candidate_handoffs").get()).toEqual({ lease_token: null });
      expect(live.provider.publications).toEqual([]);
    } finally { live.close(); }
  });

  it("publishes the preserved decision after a validated SB reserve ACK and receipt rollback", async () => {
    const live = await consumer(false);
    try {
      const control = new ControlPlane(live.db, live.provider);
      live.db.db.exec(`CREATE TEMP TRIGGER fail_reserved_receipt BEFORE INSERT ON control_command_receipts
        BEGIN SELECT RAISE(ABORT,'TEST_ONLY receipt rollback after SB ACK'); END`);
      expect(() => control.decide(live.approval, NOW)).toThrow("TEST_ONLY receipt rollback after SB ACK");
      live.db.db.exec("DROP TRIGGER fail_reserved_receipt");
      control.decide(live.approval, NOW);
      expect(control.get(live.command.request_id)?.state).toBe("approved");
      expect(live.provider.publications).toEqual([
        { phase: "reserve", operation: "decide_approve" }, { phase: "finish", operation: "decide_approve" },
      ]);
      expect(live.db.db.prepare("SELECT payload_json FROM control_command_receipts").get())
        .toEqual({ payload_json: canonicalize(live.approval) });
    } finally { live.close(); }
  });

  it.each(["none", "before", "after"] as const)("stages SB cancellation proof and retries %s ACK loss", async loss => {
    const live = await consumer(false);
    try {
      const control = new ControlPlane(live.db, live.provider);
      live.db.db.exec(`CREATE TEMP TRIGGER fail_cancelled_receipt BEFORE INSERT ON control_command_receipts
        BEGIN SELECT RAISE(ABORT,'TEST_ONLY uncommitted SB decision'); END`);
      expect(() => control.decide(live.approval, NOW)).toThrow("TEST_ONLY uncommitted SB decision");
      live.db.db.exec("DROP TRIGGER fail_cancelled_receipt");
      control.cancel({ request_id: live.command.request_id, reason: "cancel unpublished decision",
        actor: "test-operator", revoked_at: NOW.toISOString() }, NOW);
      const finish = live.provider.finishProgress.bind(live.provider);
      if (loss !== "none") {
        let drop = true;
        live.provider.finishProgress = request => {
          if (drop) {
            drop = false;
            if (loss === "after") finish(request);
            throw new Error("TEST_ONLY cancellation ACK lost");
          }
          return finish(request);
        };
        expect(() => new CompanyProgress(live.db, live.provider).settleCancelled(live.scope, NOW))
          .toThrow("COMPANY_PROGRESS_UNCERTAIN");
        expect(live.db.db.prepare("SELECT acknowledged FROM company_progress_cancellation_outbox").get())
          .toEqual({ acknowledged: 0 });
        expect(live.db.db.prepare("SELECT evidence_digest FROM company_progress_reservations").get())
          .toEqual({ evidence_digest: null });
      }
      new CompanyProgress(live.db, live.provider).settleCancelled(live.scope, NOW);
      expect(live.db.db.prepare("SELECT terminal_state FROM company_progress_reservations").get())
        .toEqual({ terminal_state: "cancelled" });
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts").get()).toEqual({ n: 0 });
      expect(live.db.db.prepare("SELECT acknowledged FROM company_progress_cancellation_outbox").get())
        .toEqual({ acknowledged: 1 });
      expect(live.provider.publications.filter(row => row.phase === "finish")).toHaveLength(1);
      new CompanyProgress(live.db, live.provider).synchronize(live.scope, NOW);
    } finally { live.close(); }
  });

  it("replays the original SB finish after ACK loss instead of replacing it with cancellation", async () => {
    const live = await consumer(false);
    live.provider.dropFinishOnce = true;
    try {
      const control = new ControlPlane(live.db, live.provider);
      expect(() => control.decide(live.approval, NOW)).toThrow("COMPANY_PROGRESS_UNCERTAIN");
      const original = live.db.db.prepare("SELECT payload_json FROM control_command_receipts").get();
      control.cancel({ request_id: live.command.request_id, reason: "cancel after original finish",
        actor: "test-operator", revoked_at: NOW.toISOString() }, NOW);
      new CompanyProgress(live.db, live.provider).settleCancelled(live.scope, NOW);
      expect(live.db.db.prepare("SELECT terminal_state FROM company_progress_reservations").get())
        .toEqual({ terminal_state: "approved" });
      expect(live.db.db.prepare("SELECT payload_json FROM control_command_receipts").get()).toEqual(original);
      expect(control.get(live.command.request_id)?.state).toBe("cancelled");
      expect(live.provider.publications.filter(row => row.phase === "finish")).toHaveLength(1);
    } finally { live.close(); }
  });

  it.each(["approve", "reject"] as const)("restores a %s handoff after freshness acknowledgement recovers", async decision => {
    const live = await consumer(true, decision);
    const operation = decision === "approve" ? "accept" : "reject";
    const terminal = decision === "approve" ? "accepted" : "rejected";
    const server = peer(live);
    const original = server.client.call.bind(server.client);
    server.client.call = async (...args) => {
      const receipt = await original(...args);
      if (args[0] === operation) {
        vi.spyOn(live.provider, "readFreshness").mockImplementationOnce(request => ({
          schema_version: 2, scope: request.scope, challenge: request.challenge, status: "unavailable", checkpoint: null,
        }));
      }
      return receipt;
    };
    try {
      const executor = new CompanyCandidateExecutor(live.db, server.client, undefined, () => NOW, live.provider);
      await expect(executor.execute(live.command.request_id)).rejects.toThrow("COMPANY_FRESHNESS_REQUIRED");
      expect(live.db.db.prepare("SELECT status FROM company_candidate_handoffs").get()).toEqual({ status: "uncertain" });
      const receipt = live.db.db.prepare("SELECT * FROM company_candidate_sb_receipts").get();
      expect((await executor.execute(live.command.request_id)).state).toBe(terminal);
      expect(live.db.db.prepare("SELECT status,failure_code,lease_token FROM company_candidate_handoffs").get())
        .toEqual({ status: terminal, failure_code: null, lease_token: null });
      expect(live.db.db.prepare("SELECT * FROM company_candidate_sb_receipts").get()).toEqual(receipt);
      expect(server.counts).toEqual({ accept: decision === "approve" ? 1 : 0, reject: decision === "reject" ? 1 : 0,
        mark_processed: 0, read: 0 });
    } finally { live.close(); vi.restoreAllMocks(); }
  });
  it("has one owner per phase and excludes SB mirrors from its own history", async () => {
    const live = await consumer();
    const server = peer(live);
    const effect = join(live.root, "effect");
    try {
      const executor = new CompanyCandidateExecutor(live.db, server.client, verifier(effect), () => NOW, live.provider);
      expect((await executor.execute(live.command.request_id)).state).toBe("completed");
      expect((await executor.execute(live.command.request_id)).state).toBe("completed");
      expect(server.counts).toEqual({ accept: 1, reject: 0, mark_processed: 1, read: 0 });
      expect(live.provider.publications.filter(row => row.phase === "reserve").map(row => row.operation))
        .toEqual(["decide_approve", "accept", "complete", "mark_processed"]);
      expect(live.db.db.prepare("SELECT operation FROM company_progress_reservations ORDER BY operation").all())
        .toEqual([{ operation: "complete" }, { operation: "decide_approve" }]);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts").get()).toEqual({ n: 1 });
      expect(live.provider.checkpoint.stores.jarvis.receipt_sequence).toBe(2);
      expect(live.provider.checkpoint.stores.second_brain.receipt_sequence).toBe(2);
      const original = reserveProgressRequestSchema.parse(JSON.parse(String(live.db.db.prepare(
        "SELECT reserve_request_json FROM company_progress_reservations WHERE operation='decide_approve'",
      ).pluck().get())));
      const reserved = companyCheckpointSchema.parse(JSON.parse(String(live.db.db.prepare(
        "SELECT checkpoint_json FROM company_progress_reservations WHERE operation='decide_approve'",
      ).pluck().get())));
      const reservationId = String(live.db.db.prepare(
        "SELECT reservation_id FROM company_progress_reservations WHERE operation='decide_approve'",
      ).pluck().get());
      const latest = live.db.db.prepare("SELECT checkpoint_json FROM company_freshness_checkpoints").get();
      let republishes = 0;
      new CompanyProgress(live.db, live.provider).finish({
        scope: live.scope, request_id: live.command.request_id, operation: "decide_approve",
        operation_id: original.operation_id, reservation_id: reservationId, checkpoint: reserved, reserve_request: original,
      }, controlValueDigest(live.approval), "approved", EXPIRED, () => { republishes++; });
      expect(republishes).toBe(0);
      expect(live.db.db.prepare("SELECT checkpoint_json FROM company_freshness_checkpoints").get()).toEqual(latest);
    } finally { live.close(); }
  });

  it("lets only SB reserve rejection", async () => {
    const live = await consumer(true, "reject");
    const server = peer(live);
    try {
      expect((await new CompanyCandidateExecutor(live.db, server.client, undefined, () => NOW, live.provider)
        .execute(live.command.request_id)).state).toBe("rejected");
      expect(live.provider.publications.filter(row => row.phase === "reserve").map(row => row.operation))
        .toEqual(["decide_reject", "reject"]);
      expect(server.counts).toEqual({ accept: 0, reject: 1, mark_processed: 0, read: 0 });
    } finally { live.close(); }
  });

  it.each(["key-id", "material"] as const)("rejects progress/processor %s reuse before a peer mutation", async alias => {
    const live = await consumer();
    const server = peer(live);
    const provider: CompanyFreshnessProvider = {
      kind: "sb_company_db", keyId: alias === "key-id" ? server.client.keyId : "key:other-progress",
      ...(alias === "material" ? { publicKeyPem: server.client.publicKeyPem } : {}),
      readFreshness: request => live.provider.readFreshness(request),
      reserveProgress: request => live.provider.reserveProgress(request), finishProgress: request => live.provider.finishProgress(request),
    };
    try {
      await expect(new CompanyCandidateExecutor(live.db, server.client, undefined, () => NOW, provider)
        .execute(live.command.request_id)).rejects.toThrow("COMPANY_CREDENTIAL_NOT_SEPARATE");
      expect(server.counts).toEqual({ accept: 0, reject: 0, mark_processed: 0, read: 0 });
    } finally { live.close(); }
  });

  it.each(["accept", "mark_processed"] as const)("does not resend a lost %s ack after expiry", async operation => {
    const live = await consumer();
    const server = peer(live);
    const effect = join(live.root, "effect");
    let now = NOW;
    server.loseNext(operation);
    try {
      const executor = new CompanyCandidateExecutor(live.db, server.client, verifier(effect), () => now, live.provider);
      await expect(executor.execute(live.command.request_id)).rejects.toThrow("TEST_ONLY_PEER_ACK_LOST");
      const original = canonicalize(server.originals.get(operation));
      now = EXPIRED;
      expect((await executor.execute(live.command.request_id)).state).toBe(operation === "accept" ? "accepted" : "completed");
      expect(canonicalize(server.originals.get(operation))).toBe(original);
      expect(server.counts[operation]).toBe(1);
      expect(server.counts.read).toBe(1);
      expect(existsSync(effect)).toBe(operation === "mark_processed");
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts").get()).toEqual({ n: 1 });
      const receipt = JSON.parse(String(live.db.db.prepare(
        "SELECT payload_json FROM company_candidate_sb_receipts WHERE operation=?",
      ).pluck().get(operation)));
      expect(receipt.receipt_created_at).toBe(NOW.toISOString());
    } finally { live.close(); }
  });
  it.each(["local-reservation", "peer-not-prepared"] as const)(
    "refuses a cancelled %s before any provider call",
    async recovery => {
      const live = await consumer();
      const server = peer(live);
      const effect = join(live.root, "effect");
      try {
        if (recovery === "local-reservation") {
          live.db.db.prepare(
            `INSERT INTO company_progress_reservations(reservation_id,operation_id,provider_instance_id,workspace_id,
             request_id,operation,checkpoint_json,reserve_request_json,created_at)
             VALUES(?,?,?,?,?,?,?,?,?)`,
          ).run("reservation:cancelled-local-accept", companyOperationId({
            scope: live.scope, request_id: live.command.request_id, command_digest: live.digest, operation: "accept",
          }), live.scope.provider_instance_id, live.scope.workspace_id, live.command.request_id, "accept",
            canonicalize(live.provider.checkpoint), canonicalize({ schema_version: 2, cancelled: true }), NOW.toISOString());
        } else {
          const operationId = companyOperationId({
            scope: live.scope, request_id: live.command.request_id, command_digest: live.digest, operation: "accept",
          });
          live.db.db.prepare(
            `INSERT INTO company_peer_calls(operation_id,provider_instance_id,workspace_id,request_id,operation,
             transition_request_digest,original_arguments_json,state,created_at,updated_at)
             VALUES(?,?,?,?,?,?,?,'invoking',?,?)`,
          ).run(operationId, live.scope.provider_instance_id, live.scope.workspace_id, live.command.request_id, "accept",
            digest("cancelled-peer-accept"), canonicalize({ cancelled: true }), NOW.toISOString(), NOW.toISOString());
        }
        new ControlPlane(live.db).cancel({ request_id: live.command.request_id, reason: "cancel before provider",
          actor: "test-operator", revoked_at: NOW.toISOString() }, NOW);
        await expect(new CompanyCandidateExecutor(live.db, server.client, verifier(effect), () => NOW, live.provider)
          .execute(live.command.request_id)).rejects.toMatchObject({ code: "COMPANY_APPROVAL_REVOKED" });
        expect(server.counts).toEqual({ accept: 0, reject: 0, mark_processed: 0, read: 0 });
        expect(existsSync(effect)).toBe(false);
      } finally { live.close(); }
    },
  );

  it("does not report completed when shared publish finds a cancellation", async () => {
    const live = await consumer();
    const server = peer(live);
    const effect = join(live.root, "effect");
    const control = new ControlPlane(live.db, live.provider);
    const original = server.client.call.bind(server.client);
    server.client.call = async (operation, args, at, nonce) => {
      const receipt = await original(operation, args, at, nonce);
      if (operation === "mark_processed") {
        control.cancel({ request_id: live.command.request_id, reason: "cancel during shared publish",
          actor: "test-operator", revoked_at: NOW.toISOString() }, NOW);
      }
      return receipt;
    };
    try {
      await expect(new CompanyCandidateExecutor(live.db, server.client, verifier(effect), () => NOW, live.provider)
        .execute(live.command.request_id)).rejects.toMatchObject({ code: "COMPANY_APPROVAL_REVOKED" });
      expect(control.get(live.command.request_id)?.state).toBe("cancelled");
      expect(live.db.db.prepare("SELECT status FROM company_candidate_handoffs WHERE request_id=?").get(live.command.request_id))
        .not.toEqual({ status: "completed" });
      expect(server.counts.mark_processed).toBe(1);
      expect(server.counts.accept).toBe(1);
    } finally { live.close(); }
  });

  it("looks up an uncertain original reserve before startup without granting a decision", async () => {
    const live = await consumer(false);
    live.provider.dropReserveOnce = true;
    try {
      const control = new ControlPlane(live.db, live.provider);
      expect(() => control.decide(live.approval, NOW)).toThrow("COMPANY_FRESHNESS_REQUIRED");
      expect(() => control.decide(live.approval, NOW)).toThrow("COMPANY_PROGRESS_UNCERTAIN");
      expect(live.provider.reads).toBe(1);
      expect(live.provider.publications).toEqual([{ phase: "reserve", operation: "decide_approve" }]);
      expect(live.db.db.prepare("SELECT count(*) AS n FROM control_command_receipts").get()).toEqual({ n: 0 });
      expect(live.db.db.prepare("SELECT request_id,evidence_digest FROM company_progress_reservations").get())
        .toEqual({ request_id: live.command.request_id, evidence_digest: null });
      expect(() => control.decide(live.approval, NOW)).toThrow(`request_id=${live.command.request_id}`);
    } finally { live.close(); }
  });

  it("retries only the original decision finish with its original receipt after expiry", async () => {
    const live = await consumer(false);
    live.provider.dropFinishOnce = true;
    try {
      expect(() => new ControlPlane(live.db, live.provider).decide(live.approval, NOW)).toThrow("COMPANY_PROGRESS_UNCERTAIN");
      const original = live.db.db.prepare("SELECT payload_json FROM control_command_receipts").get();
      const progress = new CompanyProgress(live.db, live.provider);
      const pending = progress.pending(live.command, "decide_approve");
      if (!pending) throw new Error("missing original reservation");
      progress.finish(pending, controlValueDigest(live.approval), "approved", EXPIRED);
      expect(live.db.db.prepare("SELECT payload_json FROM control_command_receipts").get()).toEqual(original);
      expect(live.provider.publications.filter(row => row.phase === "finish")).toHaveLength(1);
      expect(live.db.db.prepare("SELECT acknowledged FROM company_progress_evidence_outbox").get()).toEqual({ acknowledged: 1 });
    } finally { live.close(); }
  });

  it("refuses retained checkpoints and outboxes when a restored DB has lost the actual decision", async () => {
    const live = await consumer(false);
    const backup = join(live.root, "before-decision.sqlite");
    await live.db.db.backup(backup);
    try {
      new ControlPlane(live.db, live.provider).decide(live.approval, NOW);
      const restored = new AuthorityDb(backup);
      try {
        restored.db.prepare("ATTACH DATABASE ? AS retained").run(live.db.filename);
        restored.db.exec(`INSERT INTO company_progress_reservations SELECT * FROM retained.company_progress_reservations;
          INSERT INTO company_progress_evidence_outbox SELECT * FROM retained.company_progress_evidence_outbox;`);
        restored.db.prepare("UPDATE company_freshness_checkpoints SET checkpoint_json=?").run(canonicalize(live.provider.checkpoint));
        const reads = live.provider.reads;
        expect(() => new CompanyProgress(restored, live.provider).synchronize(live.scope, NOW)).toThrow("COMPANY_PROGRESS_UNCERTAIN");
        expect(live.provider.reads).toBe(reads);
        expect(restored.db.prepare("SELECT count(*) AS n FROM control_command_receipts").get()).toEqual({ n: 0 });
      } finally { restored.close(); }
    } finally { live.close(); }
  });
});

describe("new-kind retained other-store prefix", () => {
  const unsafe: ReadonlyArray<readonly [string, (next: CompanyCheckpoint, previous: CompanyCheckpoint) => void]> = [
    ["epoch", value => { value.operational_epoch++; }],
    ["policy", value => { value.approval_policy_version++; }],
    ["binding", value => { value.approval_binding_digest = `sha256:${"a".repeat(64)}`; }],
    ["revocation", value => { value.revocation_sequence++; value.revocation_root = `sha256:${"b".repeat(64)}`; }],
    ["own fact", value => { value.stores.jarvis.receipt_sequence++; value.stores.jarvis.receipt_root = `sha256:${"c".repeat(64)}`; }],
    ["same-height root", value => { value.stores.second_brain.receipt_sequence = 0; }],
    ["intent-only", (value, previous) => { value.stores.second_brain = structuredClone(previous.stores.second_brain); }],
    ["missing intent advance", (value, previous) => { value.intent_sequence = previous.intent_sequence; }],
  ];
  it.each(unsafe)("refuses authenticated %s changes without rewriting its cache", async (_name, corrupt) => {
    const live = await consumer();
    try {
      const before = live.db.db.prepare("SELECT checkpoint_json FROM company_freshness_checkpoints").get();
      const previous = live.provider.checkpoint;
      const next = structuredClone(previous);
      next.intent_sequence += 2;
      next.intent_root = `sha256:${"9".repeat(64)}`;
      next.stores.second_brain.receipt_sequence++;
      next.stores.second_brain.receipt_root = `sha256:${"8".repeat(64)}`;
      corrupt(next, previous);
      live.provider.attest(next);
      expect(() => new CompanyProgress(live.db, live.provider).synchronize(live.scope, NOW)).toThrow("COMPANY_OPERATIONAL_ROLLBACK");
      expect(live.db.db.prepare("SELECT checkpoint_json FROM company_freshness_checkpoints").get()).toEqual(before);
    } finally { live.close(); }
  });

  it("uses an independent busy_timeout=0 writer during provider I/O and refuses a lost publication CAS", async () => {
    const live = await consumer();
    const other = new AuthorityDb(live.db.filename);
    let writes = 0;
    try {
      other.db.pragma("busy_timeout=0");
      const next = live.provider.checkpoint;
      next.intent_sequence += 2; next.intent_root = `sha256:${"7".repeat(64)}`;
      next.stores.second_brain.receipt_sequence++; next.stores.second_brain.receipt_root = `sha256:${"6".repeat(64)}`;
      live.provider.attest(next);
      const provider: CompanyFreshnessProvider = {
        kind: "sb_company_db", reserveProgress: request => live.provider.reserveProgress(request),
        finishProgress: request => live.provider.finishProgress(request),
        readFreshness(request) {
          const response = live.provider.readFreshness(request);
          other.db.prepare("UPDATE company_freshness_checkpoints SET checkpoint_json=?").run(canonicalize(next));
          writes++;
          return response;
        },
      };
      expect(() => new CompanyProgress(live.db, provider).synchronize(live.scope, NOW)).toThrow("COMPANY_PROGRESS_UNCERTAIN");
      expect(writes).toBe(1);
      expect(live.db.db.prepare("SELECT checkpoint_json FROM company_freshness_checkpoints").pluck().get()).toBe(canonicalize(next));
    } finally { other.close(); live.close(); }
  });
});
