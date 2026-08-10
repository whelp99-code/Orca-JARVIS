import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthorityDb, PreGjcShadow } from "../../src/index.js";
import type { ProgressSignal, ProgressSignalKey } from "../../src/index.js";
import { tempDb } from "../helpers.js";
import { canonicalize } from "../../src/canonical.js";

const fixture = () => { const target = JSON.parse(readFileSync("test/fixtures/pre-gjc-e2e.json", "utf8")).targets[0] as { signals: Array<{ progress_signal: ProgressSignal }>; trusted_keys: ProgressSignalKey[] }; return { signals: target.signals.map(item => item.progress_signal), trusted_keys: target.trusted_keys }; };
async function opened() { const db = new AuthorityDb(tempDb()); await db.migrate(); return { db, shadow: new PreGjcShadow(db) }; }

describe("durable pre-GJC shadow", () => {
  it("keeps provider/purpose keys immutable, revocable, and temporal", async () => {
    const { db, shadow } = await opened(); const input = fixture(); const key = input.trusted_keys[0]!;
    shadow.registerKey(key); shadow.registerKey(key); expect(() => shadow.registerKey({ ...key, expires_at: "2026-08-09T02:00:00.000Z" })).toThrow("PRE_GJC_KEY_IMMUTABLE");
    expect(shadow.enqueueCandidate("one", input.signals[0]!, new Date("2026-08-09T00:00:00.000Z"))).toMatchObject({ replayed: false }); shadow.revokeKey(key.key_id, "codex", "progress-signal", "test");
    expect(() => shadow.enqueueCandidate("two", input.signals[0]!, new Date("2026-08-09T00:00:00.000Z"))).toThrow("PRE_GJC_SIGNAL_REJECTED"); db.close();
  });
  it("uses FIFO replay-safe fenced staging and bounded paused reporting", async () => {
    const { db, shadow } = await opened(); const input = fixture(); shadow.registerKey(input.trusted_keys[0]!);
    const first = shadow.enqueueCandidate("one", input.signals[0]!, new Date("2026-08-09T00:00:00.000Z")); expect(shadow.enqueueCandidate("one", input.signals[0]!, new Date("2026-08-09T00:00:00.000Z"))).toMatchObject({ candidate_id: first.candidate_id, replayed: true });
    const lease = shadow.claimNext("worker", new Date("2026-08-09T00:00:00.000Z"))!; expect(lease.candidate_id).toBe(first.candidate_id); shadow.configureProject("project", "codex", 10, 10, 1); const report = shadow.stageCandidate(lease, "project", new Date("2026-08-09T00:00:01.000Z"));
    expect(() => shadow.stageCandidate(lease, "project", new Date("2026-08-09T00:00:01.000Z"))).toThrow("PRE_GJC_FENCE_REJECTED"); shadow.deferReport(report.report_id, new Date("2026-08-09T00:00:01.000Z")); expect(() => shadow.deferReport(report.report_id, new Date("2026-08-09T00:00:02.000Z"))).toThrow("PRE_GJC_REPORT_DEADLETTER"); shadow.setPaused("project", true); db.close();
  });
  it("reclaims expired leases with a new fence and refuses paused or exhausted projects", async () => {
    const { db, shadow } = await opened(); const input = fixture(); shadow.registerKey(input.trusted_keys[0]!); const candidate = shadow.enqueueCandidate("one", input.signals[0]!, new Date("2026-08-09T00:00:00.000Z")); shadow.configureProject("project", "codex", 1, 1, 2);
    const first = shadow.claimNext("worker", new Date("2026-08-09T00:00:00.000Z"), 1)!; const reclaimed = shadow.claimNext("worker", new Date("2026-08-09T00:00:01.000Z"), 1)!; expect(reclaimed).toMatchObject({ candidate_id: candidate.candidate_id, fence: first.fence + 1 }); shadow.setPaused("project", true); expect(() => shadow.stageCandidate(reclaimed, "project", new Date("2026-08-09T00:00:01.000Z"))).toThrow("PRE_GJC_FENCE_REJECTED"); db.close();
  });
  it("persists an exact signed one-use resume intent before fake Orca delivery", async () => {
    const { db, shadow } = await opened(); const pair = generateKeyPairSync("ed25519"); const public_key_pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString(); shadow.registerKey({ key_id: "authority", provider: "codex", purpose: "authority-receipt", public_key_pem, active: true, not_before: "2026-08-08T23:00:00.000Z", expires_at: "2026-08-09T01:00:00.000Z" });
    const now = new Date("2026-08-09T00:00:00.000Z"); shadow.configureProject("project", "codex", 10, 10); const request_id = shadow.requestAuthority({ project_id: "project", provider: "codex", terminal_id: "terminal", session_id: "session", incarnation_id: "incarnation", signal_event_id: "sha256:event", attempt_id: "attempt", lease_id: "lease", fence: 1, expires_at: "2026-08-09T00:05:00.000Z" }, now); const unsigned = { receipt_id: "receipt", request_id, project_id: "project", provider: "codex" as const, terminal_id: "terminal", session_id: "session", incarnation_id: "incarnation", signal_event_id: "sha256:event", attempt_id: "attempt", lease_id: "lease", fence: 1, decision: "approve" as const, key_id: "authority", issued_at: now.toISOString(), expires_at: "2026-08-09T00:05:00.000Z" }; const receipt = { ...unsigned, signature: sign(null, Buffer.from(`orca-jarvis/pre-gjc-authority/v1\0${canonicalize(unsigned)}`), pair.privateKey).toString("base64url") };
    const calls: string[] = []; shadow.consumeAuthorityReceipt(receipt, { resume: intent => { calls.push(intent.intent_id); return { intent_id: intent.intent_id, receipt: "durable-adapter-ack", delivered_at: now.toISOString() }; } }, now); expect(calls).toHaveLength(1); expect(db.db.prepare("SELECT state,attempts FROM pre_gjc_resume_intents").get()).toEqual({ state: "delivered", attempts: 1 }); expect(() => shadow.consumeAuthorityReceipt(receipt, { resume: () => ({ intent_id: "again", receipt: "x", delivered_at: now.toISOString() }) }, now)).toThrow(); expect(calls).toHaveLength(1); db.close();
  });
  it("records improvements as proposal-only", async () => { const { db, shadow } = await opened(); shadow.configureProject("project", "claude", 1, 1); const id = shadow.proposeImprovement("project", { metric: "retry" }); expect(db.db.prepare("SELECT state,isolated_execution_required FROM pre_gjc_improvement_proposals WHERE proposal_id=?").get(id)).toEqual({ state: "proposed", isolated_execution_required: 1 }); db.close(); });
});
