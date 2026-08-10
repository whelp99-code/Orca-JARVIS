import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AuthorityDb, PreGjcShadow } from "../../src/index.js";
import type { ProgressSignal, ProgressSignalKey } from "../../src/index.js";
import { canonicalize } from "../../src/canonical.js";
import { tempDb } from "../helpers.js";

const now = new Date("2026-08-09T00:00:00.000Z");
const fixture = () => { const target = JSON.parse(readFileSync("test/fixtures/pre-gjc-e2e.json", "utf8")).targets[0] as { signals: Array<{ progress_signal: ProgressSignal }>; trusted_keys: ProgressSignalKey[] }; return { signal: target.signals[0]!.progress_signal, key: target.trusted_keys[0]! }; };
async function opened() { const db = new AuthorityDb(tempDb()); await db.migrate(); return { db, shadow: new PreGjcShadow(db) }; }

describe("pre-GJC runtime boundary", () => {
  it("is replay-safe across one hundred conflicting claims and project-scoped report delivery", async () => {
    const { db, shadow } = await opened(); const { signal, key } = fixture(); shadow.registerKey(key); shadow.configureProject("one", "codex", 10, 10, 3); shadow.configureProject("two", "codex", 10, 10, 3);
    const first = shadow.enqueueCandidate("worktree", signal, now); for (let index = 0; index < 100; index += 1) expect(shadow.enqueueCandidate("worktree", signal, now)).toEqual({ candidate_id: first.candidate_id, replayed: true });
    const lease = shadow.claimNext("worker", now, 1)!; expect(() => shadow.stageCandidate({ ...lease, fence: lease.fence + 1 }, "one", now)).toThrow("PRE_GJC_FENCE_REJECTED");
    shadow.stageCandidate(shadow.claimNext("worker-two", new Date("2026-08-09T00:00:01.000Z"), 1)!, "one", new Date("2026-08-09T00:00:01.000Z"));
    const pending = shadow.pendingReports(); expect(pending).toHaveLength(1); const report = shadow.claimReport("reporter", new Date("2026-08-09T00:00:02.000Z"), 1)!; shadow.acknowledgeReport(report, { receipt: "local-only" }, new Date("2026-08-09T00:00:02.000Z")); expect(() => shadow.acknowledgeReport(report, {}, new Date("2026-08-09T00:00:02.000Z"))).toThrow("PRE_GJC_REPORT_FENCE_REJECTED");
    expect(db.db.prepare("SELECT COUNT(*) AS count FROM pre_gjc_report_outbox WHERE state='delivered'").get()).toEqual({ count: 1 }); db.close();
  });

  it("binds authority decisions exactly and persists local-only recovery evidence", async () => {
    const { db, shadow } = await opened(); shadow.configureProject("project", "codex", 10, 10, 3); const pair = generateKeyPairSync("ed25519"); shadow.registerKey({ key_id: "authority", provider: "codex", purpose: "authority-receipt", public_key_pem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), active: true, not_before: "2026-08-08T23:00:00.000Z", expires_at: "2026-08-09T01:00:00.000Z" });
    const binding = { project_id: "project", provider: "codex" as const, terminal_id: "terminal", session_id: "session", incarnation_id: "incarnation", signal_event_id: "sha256:event", attempt_id: "attempt", lease_id: "lease", fence: 7, expires_at: "2026-08-09T00:05:00.000Z" };
    const makeReceipt = (request: typeof binding, request_id: string, receipt_id: string, decision: "approve" | "reject" | "needs_input", answer?: string) => { const unsigned = { ...request, receipt_id, request_id, decision, ...(answer === undefined ? {} : { answer }), key_id: "authority", issued_at: now.toISOString() }; return { ...unsigned, signature: sign(null, Buffer.from(`orca-jarvis/pre-gjc-authority/v1\0${canonicalize(unsigned)}`), pair.privateKey).toString("base64url") }; };
    const approved = shadow.requestAuthority(binding, now); const receipt = makeReceipt(binding, approved, "approved", "approve"); const intent = shadow.recordAuthorityReceipt(receipt, now)!; expect(() => shadow.deliverResume(intent, { resume: () => { throw new Error("simulated crash"); } }, now)).toThrow("simulated crash");
    expect(() => shadow.deliverResume(intent, { resume: item => ({ intent_id: item.intent_id, receipt: "durable-ack", delivered_at: now.toISOString() }) }, new Date("2026-08-09T00:01:01.000Z"))).toThrow("PRE_GJC_RESUME_NOT_PENDING");
    const inputBinding = { ...binding, signal_event_id: "sha256:input", fence: 8 }; const needsInput = shadow.requestAuthority(inputBinding, now); const inputIntent = shadow.recordAuthorityReceipt(makeReceipt(inputBinding, needsInput, "input", "needs_input", "continue?"), now)!; shadow.deliverResume(inputIntent, { resume: item => ({ intent_id: item.intent_id, receipt: "input-ack", delivered_at: now.toISOString() }) }, now);
    const rejectBinding = { ...binding, signal_event_id: "sha256:reject", fence: 9 }; const rejected = shadow.requestAuthority(rejectBinding, now); expect(shadow.recordAuthorityReceipt(makeReceipt(rejectBinding, rejected, "rejected", "reject"), now)).toBeUndefined();
    const revokedBinding = { ...binding, signal_event_id: "sha256:revoked", fence: 10 }; const revokedRequest = shadow.requestAuthority(revokedBinding, now); const revokedIntent = shadow.recordAuthorityReceipt(makeReceipt(revokedBinding, revokedRequest, "revoked", "approve"), now)!; shadow.revokeKey("authority", "codex", "authority-receipt", "post-record"); let revokedCalls = 0; expect(() => shadow.deliverResume(revokedIntent, { resume: () => { revokedCalls += 1; return { intent_id: revokedIntent, receipt: "unexpected", delivered_at: now.toISOString() }; } }, now)).toThrow("PRE_GJC_RECEIPT_INVALID"); expect(revokedCalls).toBe(0);
    expect(() => shadow.recordAuthorityReceipt(receipt, now)).toThrow();
    const proposal = shadow.proposeImprovement("project", { no_prose_influence: true }); expect(() => db.db.prepare("UPDATE pre_gjc_improvement_proposals SET state='approved' WHERE proposal_id=?").run(proposal)).toThrow(); shadow.rejectProposal(proposal);
    expect(shadow.status()).toMatchObject({ proposals: 1, gjc_dispatched: false }); db.close();
  });
});
