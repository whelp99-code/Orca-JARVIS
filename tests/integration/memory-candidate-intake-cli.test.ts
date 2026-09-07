import { createHash } from "node:crypto";
import { memoryRememberArtifact } from "../../src/memory-remember-artifact.js";
import { MemoryOutboxService } from "../../src/memory-outbox.js";
import { createSecondBrainWriteRequestAdapter } from "../../src/second-brain-write-adapter.js";
import type { SecondBrainRememberWriteRequest, SecondBrainEvidence } from "../../src/second-brain-adapter-types.js";
import { evidence, FixtureReader } from "../fixtures/memory-outbox-fixture.js";
import { join } from "node:path";
import { readFileSync, writeFileSync, readdirSync, symlinkSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MemoryCandidateDispatchSpool } from "../../src/memory-candidate-dispatch-spool.js";
import { resolveSpooledDispatch } from "../../src/memory-outbox-dispatch-request.js";
import { parseSecondBrainWriteRequest } from "../../src/second-brain-write-request.js";
import { snapshotMemoryWriteArguments } from "../../src/memory-effect-write-request.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import { execute } from "../../src/cli.js";
import { readCandidateReview } from "../../src/dashboard/memory-candidate-review.js";
import { MemoryMutationService } from "../../src/dashboard/memory-mutation-service.js";
import { MemoryTokenCache } from "../../src/dashboard/memory-token-cache.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { ControlPlane, signCommandApproval } from "../../src/control-plane.js";
import { inferredMemoryInput, memoryPolicy, MEMORY_NOW, verifiedMemoryInput } from "../fixtures/memory-candidate-fixture.js";
import { closeMemoryDatabase, memoryDatabase } from "../fixtures/memory-candidate-store.js";
import { localKey } from "../helpers.js";

async function fixture(statement?: string) {
  const database = await memoryDatabase(); const now = new Date(MEMORY_NOW);
  const file = join(database.root, "input.json"), policy = join(database.root, "policy.json");
  const roots = { candidate_review_spool_root: join(database.root, "review"),
    candidate_dispatch_spool_root: join(database.root, "dispatch") };
  const input = statement === undefined ? inferredMemoryInput({ statement: "검토할 업무 기억입니다." })
    : { ...inferredMemoryInput(), schema_version: 2, body_profile: "plain-text-v1", statement };
  writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
  writeFileSync(policy, JSON.stringify(memoryPolicy()), { mode: 0o600 });
  const run = (args = ["memory", "classify", file, policy]) => execute([...args, "--db", database.path],
    { clock: () => now, memoryOutboxOptions: roots });
  return { database, now, file, policy, roots, input, run };
}

async function proveUncertainCompletion(f: Awaited<ReturnType<typeof fixture>>, request: SecondBrainRememberWriteRequest,
  staged: Awaited<ReturnType<ControlPlane["stage"]>>) {
  const control = new ControlPlane(f.database.authority);
  const approval = signCommandApproval({ schema_version: 1, receipt_id: "multiline-dispatch-approval",
    request_id: staged.request_id, decision: "approve", command_digest: staged.command_digest,
    signer_principal_id: "principal:owner", authenticated_session_id: "intake-session", key_id: "decision-test",
    algorithm: "Ed25519", issued_at: f.now.toISOString(), not_before: f.now.toISOString(), expires_at: staged.expires_at,
    nonce: "multiline-dispatch-approval", max_uses: 1, status: "issued" }, localKey(f.database.authority));
  control.decide(approval, f.now);
  const calls: unknown[] = [];
  const transport = { call: async (_method: unknown, args: unknown) => { calls.push(args);
    throw new Error("provider accepted but connection closed"); }, close: async () => {}, restart: async () => {}, diagnostics: () => [] };
  const reader = new FixtureReader({ kind: "no_data", checked_at: f.now.toISOString(), fresh_until: staged.expires_at });
  let current = f.now;
  const service = new MemoryOutboxService({ authority: f.database.authority,
    writer: createSecondBrainWriteRequestAdapter(transport, f.database.authority, () => current), reader,
    clock: () => current, ...f.roots });
  const command = control.claim(staged.request_id, "multiline-executor", current);
  const saga = service.enqueue(command);
  expect(await service.runOnce("multiline-dispatch", 1)).toMatchObject({ dispatched: 1, settled: 0 });
  expect(calls).toEqual([{ request }]);
  control.settle(command.request_id, command.fence, { state: "uncertain", effect_type: "memory.outbox.reconciling",
    payload: {}, failure_code: "MEMORY_OUTBOX_RECONCILING" }, current);
  const plan = memoryRememberArtifact(request);
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const rows: SecondBrainEvidence[] = plan.record_texts.map((text, index) => {
    const start = 200 + index * 5000, end = start + Buffer.byteLength(text);
    return { ...evidence(`sha256:${hash(text)}`, plan.artifact.sid), page_id: plan.artifact.page_id, excerpt: text,
      sensitivity: request.sensitivity,
      record: { record_id: `sbrecord:v1:${hash(String(index))}`, record_digest: `sha256:${hash(String(index))}`,
        source_identity_full: plan.source_identity_full, content_identity_full: hash(text),
        citation_identity_full: hash(`${plan.artifact.page_id}\0${plan.artifact.sid}\0${start}:${end}`),
        citation_span_start: start, citation_span_end: end, source_owner_class: "provider_owned",
        source_owner_id_digest: `sha256:${"6".repeat(64)}`, origin_label: "Second Brain", generation: {
          provider_instance_id: "provider:test", generation_id: "generation:test", generation_manifest_digest: `sha256:${"2".repeat(64)}`,
          vault_head: "3".repeat(40), vault_tree: "4".repeat(40), tombstone_sequence: 0, tombstone_set_root: `sha256:${"5".repeat(64)}` } } };
  });
  reader.readPage = async () => ({ kind: "current", checked_at: current.toISOString(), evidence: rows });
  current = new Date(current.getTime() + 20 * 60_000);
  expect(await service.runOnce("multiline-recovery", 1)).toMatchObject({ dispatched: 0, settled: 1, commands_reconciled: 1 });
  expect(service.get(saga.outbox_id)?.state).toBe("settled");
  expect(control.get(command.request_id)?.state).toBe("completed");
  expect(calls).toHaveLength(1);
  expect(readdirSync(f.roots.candidate_review_spool_root)).toEqual([]);
}

describe("memory candidate CLI intake", () => {
  it.each([undefined, "첫 줄\n둘째 줄", "첫 줄\r\n둘째 줄", "첫 줄\r둘째 줄", "\t 앞\n\n뒤 \t"])("publishes exact input for review and feeds the owner/storage path: %j", async statement => {
    const f = await fixture(statement);
    try {
      const bytes = readFileSync(f.file);
      const first = await f.run();
      expect(first).toMatchObject({ ok: true, command: "memory.classify", stored: false,
        candidate: { state: "awaiting_confirmation", input_class: "labeled_inference", required_confirmation: true } });
      expect(JSON.stringify(first)).not.toContain(String(f.input.statement));
      expect(await f.run()).toEqual(first);
      const id = (first.candidate as { candidate_id: string }).candidate_id;
      expect(readdirSync(f.roots.candidate_review_spool_root)).toHaveLength(1);
      const review = readCandidateReview(f.database.authority, f.roots.candidate_review_spool_root, id, f.now)!;
      expect(review.statement).toBe(f.input.statement);
      const mutation = new MemoryMutationService({ authority: f.database.authority, clock: () => f.now,
        session: createDashboardSession("intake-session"), tokens: new MemoryTokenCache(Buffer.alloc(32, 1), () => f.now),
        ...f.roots });
      const command = mutation.stageReviewedCandidateDecision({ candidate_id: id, operation: "remember", decision: "confirm",
        intent_id: `memui:intent:v1:${"1".repeat(64)}` }, review.review_digest)!;
      const receipt = signCommandApproval({ schema_version: 1, receipt_id: "intake-confirm",
        request_id: command.request_id, decision: "approve", command_digest: command.command_digest,
        signer_principal_id: "principal:owner", authenticated_session_id: "intake-session", key_id: "decision-test",
        algorithm: "Ed25519", issued_at: f.now.toISOString(), not_before: f.now.toISOString(), expires_at: command.expires_at,
        nonce: "intake-confirm", max_uses: 1, status: "issued" }, localKey(f.database.authority));
      const receiptFile = join(f.database.root, "receipt.json"); writeFileSync(receiptFile, JSON.stringify(receipt));
      await f.run(["control", "decide", receiptFile]);
      expect(await f.run(["control", "execute", command.request_id])).toMatchObject({ execution: { state: "completed" } });
      const staged = await f.run(["memory", "stage-dispatch", id]);
      expect(staged).toMatchObject({ request: { state: "pending", action: "memory.outbox.dispatch" } });
      expect(await f.run(["memory", "stage-dispatch", id])).toEqual(staged);
      expect(new ControlPlane(f.database.authority).list()).toHaveLength(2);
      const dispatch = new MemoryCandidateDispatchSpool(f.roots.candidate_dispatch_spool_root).read(id);
      const request = resolveSpooledDispatch({ candidate_id: id, dispatch_spool_digest: dispatch.dispatch_spool_digest,
        roots: { review: f.roots.candidate_review_spool_root, dispatch: f.roots.candidate_dispatch_spool_root }, now: f.now });
      expect(request.schema_version).toBe(statement === undefined ? 1 : 3);
      expect(request.payload.content).toBe(f.input.statement);
      expect(snapshotMemoryWriteArguments({ request })).toEqual({ request });
      expect(parseSecondBrainWriteRequest({ ...request, payload: { content: `${request.payload.content} changed` } }, f.now)).toBeUndefined();
      expect(parseSecondBrainWriteRequest({ ...request, schema_version: statement === undefined ? 3 : 1 }, f.now)).toBeUndefined();
      expect(readFileSync(f.file)).toEqual(bytes);
      if (statement !== undefined) {
        const command = new ControlPlane(f.database.authority).get((staged.request as { request_id: string }).request_id)!;
        await proveUncertainCompletion(f, request, command);
      }
      writeFileSync(f.file, JSON.stringify({ ...f.input, statement: "다른 내용" }));
      await expect(f.run()).rejects.toMatchObject({ code: "MEMORY_CANDIDATE_REPLAY_CONFLICT" });
    } finally { closeMemoryDatabase(f.database); }
  });

  it.each([1, 2])("rejects reclassification across profiles after schema%s without replacing the original candidate", async firstSchema => {
    const f = await fixture();
    try {
      const plain = f.input;
      const profiled = { ...plain, schema_version: 2, body_profile: "plain-text-v1" };
      writeFileSync(f.file, JSON.stringify(firstSchema === 1 ? plain : profiled));
      const first = await f.run();
      const path = join(f.roots.candidate_review_spool_root, readdirSync(f.roots.candidate_review_spool_root)[0]!);
      const original = readFileSync(path);
      writeFileSync(f.file, JSON.stringify({ ...(firstSchema === 1 ? profiled : plain), idempotency_key: "another-intake-key" }));
      await expect(f.run()).rejects.toMatchObject({ code: "MEMORY_CANDIDATE_REPLAY_CONFLICT" });
      expect(f.database.authority.db.prepare("SELECT count(*) AS n FROM memory_candidates").get()).toEqual({ n: 1 });
      expect(readFileSync(path)).toEqual(original);
      expect(new MemoryCandidateStore(f.database.authority, memoryPolicy(), () => f.now)
        .classify(firstSchema === 1 ? plain : profiled).candidate_id).toBe((first.candidate as { candidate_id: string }).candidate_id);
    } finally { closeMemoryDatabase(f.database); }
  });

  it("keeps file and DB digests equal with a moving clock and adopts only exact uncommitted review bytes", async () => {
    const f = await fixture();
    try {
      const store = new MemoryCandidateStore(f.database.authority, memoryPolicy(), () => f.now);
      store.attachReviewSpool(f.roots.candidate_review_spool_root);
      expect(() => f.database.authority.db.transaction(() => { store.classify(f.input); throw new Error("outer rollback"); })())
        .toThrow("outer rollback");
      expect(f.database.authority.db.prepare("SELECT count(*) AS n FROM memory_candidates").get()).toEqual({ n: 0 });
      const path = join(f.roots.candidate_review_spool_root, readdirSync(f.roots.candidate_review_spool_root)[0]!);
      const original = readFileSync(path);
      writeFileSync(f.file, JSON.stringify({ ...f.input, idempotency_key: "different-request-same-identity" }));
      await expect(f.run()).rejects.toMatchObject({ code: "MEMORY_CANDIDATE_REPLAY_CONFLICT" });
      expect(readFileSync(path)).toEqual(original);
      writeFileSync(f.file, JSON.stringify(f.input));
      let tick = 5_000;
      const result = await execute(["memory", "classify", f.file, f.policy, "--db", f.database.path],
        { clock: () => new Date(f.now.getTime() + tick++), memoryOutboxOptions: f.roots });
      const id = (result.candidate as { candidate_id: string }).candidate_id;
      expect(readCandidateReview(f.database.authority, f.roots.candidate_review_spool_root, id,
        new Date(f.now.getTime() + tick))?.statement).toBe(f.input.statement);
      expect(readFileSync(path)).toEqual(original);
    } finally { closeMemoryDatabase(f.database); }
  });

  it("rolls back a new review when source freshness expires during publication", async () => {
    const f = await fixture();
    try {
      let calls = 0;
      await expect(execute(["memory", "classify", f.file, f.policy, "--db", f.database.path],
        { clock: () => calls++ < 2 ? f.now : new Date("2026-08-28T13:00:00.000Z"), memoryOutboxOptions: f.roots }))
        .rejects.toMatchObject({ code: "MEMORY_CANDIDATE_AUTHORITY_INVALID" });
      expect(f.database.authority.db.prepare("SELECT count(*) AS n FROM memory_candidates").get()).toEqual({ n: 0 });
      expect(readdirSync(f.roots.candidate_review_spool_root)).toEqual([]);
    } finally { closeMemoryDatabase(f.database); }
  });

  it.each(["secret", "expired", "no_data"])("classifies %s without trying to publish an ineligible review", async mode => {
    const f = await fixture();
    try {
      const value = mode === "secret" ? { ...f.input, statement: "password=intake-private-marker" }
        : mode === "no_data" ? { ...f.input, second_brain: { state: "no_data", checked_at: MEMORY_NOW,
          fresh_until: "2026-08-28T12:30:00.000Z" } } : f.input;
      writeFileSync(f.file, JSON.stringify(value));
      const result = mode === "expired" ? await execute(["memory", "classify", f.file, f.policy, "--db", f.database.path],
        { clock: () => new Date("2026-08-30T12:00:00.000Z"), memoryOutboxOptions: f.roots }) : await f.run();
      expect(result).toMatchObject({ stored: false, candidate: { state: mode === "secret" ? "rejected"
        : mode === "expired" ? "expired" : "classified" } });
      expect(readdirSync(f.roots.candidate_review_spool_root)).toEqual([]);
      expect(JSON.stringify(result)).not.toContain("intake-private-marker");
      const count = f.database.authority.db.prepare("SELECT count(*) AS n FROM memory_candidate_classifications").get();
      expect(count).toEqual({ n: 1 });
    } finally { closeMemoryDatabase(f.database); }
  });

  it("refuses invented verified authority and malformed files without candidate or raw spool persistence", async () => {
    const f = await fixture();
    try {
      writeFileSync(f.file, JSON.stringify(verifiedMemoryInput()));
      await expect(f.run()).rejects.toMatchObject({ code: "MEMORY_CANDIDATE_AUTHORITY_INVALID" });
      for (const bytes of [Buffer.from('{"schema_version":1,"schema_version":1}'), Buffer.from([0xff]),
        Buffer.from(" ".repeat(32_769)), Buffer.from('{"private":"intake-private-marker"')]) {
        writeFileSync(f.file, bytes);
        await expect(f.run()).rejects.toMatchObject({ code: "MEMORY_CANDIDATE_FILE_INVALID" });
      }
      const link = join(f.database.root, "link.json"); symlinkSync(f.policy, link);
      await expect(f.run(["memory", "classify", link, f.policy])).rejects.toMatchObject({ code: "MEMORY_CANDIDATE_FILE_INVALID" });
      await expect(f.run(["memory", "classify", f.database.root, f.policy])).rejects.toMatchObject({ code: "MEMORY_CANDIDATE_FILE_INVALID" });
      expect(f.database.authority.db.prepare("SELECT count(*) AS n FROM memory_candidates").get()).toEqual({ n: 0 });
      expect(readdirSync(f.roots.candidate_review_spool_root)).toEqual([]);
    } finally { closeMemoryDatabase(f.database); }
  });
});
