import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { join } from "node:path";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { ControlPlane, signCommandApproval } from "../../src/control-plane.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import { MemoryCandidateReviewSpool, memoryCandidateReviewDigest } from "../../src/memory-candidate-review-spool.js";
import { readCandidateReview } from "../../src/dashboard/memory-candidate-review.js";
import { closeMemoryDatabase, memoryDatabase } from "../fixtures/memory-candidate-store.js";
import { inferredMemoryInput, memoryPolicy, MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import { Task32ReadAdapter } from "../fixtures/task32-memory-test-support.js";
import { localKey } from "../helpers.js";
import { ApprovedCommandExecutor } from "../../src/approved-executor.js";

async function fixture() {
  const database = await memoryDatabase(); const now = new Date(MEMORY_NOW);
  const reviewRoot = join(database.root, "review"); const dispatchRoot = join(database.root, "dispatch");
  const store = new MemoryCandidateStore(database.authority, memoryPolicy(), () => now);
  store.attachReviewSpool(reviewRoot);
  const input = inferredMemoryInput({ sensitivity: "personal" }); const candidate = store.classify(input);
  const server = createDashboardServer({ db: database.authority, staticRoot: database.root,
    host: "127.0.0.1", port: 0, clock: () => now, memoryAdapter: new Task32ReadAdapter(),
    memoryCandidateReviewSpoolRoot: reviewRoot, memoryCandidateDispatchSpoolRoot: dispatchRoot });
  const base = `http://${server.address.host}:${server.address.port}`;
  const session = await request(`${base}/api/v1/session`);
  const token = (await session.body.json() as { csrf_token: string }).csrf_token;
  async function call(path: string, body?: unknown, authenticated = true) {
    const response = await request(`${base}/api/v1/memory/${path}`, {
      method: body === undefined ? "GET" : "POST", headers: {
        ...(authenticated ? { "X-JARVIS-CSRF": token } : {}), Origin: base, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.statusCode, headers: response.headers, body: await response.body.json() as Record<string, any> };
  }
  return { database, now, reviewRoot, dispatchRoot, input, candidate, call,
    close: () => { server.close(); closeMemoryDatabase(database); } };
}

describe("owner candidate review and storage preparation HTTP", () => {

  it.each(["before-approval", "after-approval"] as const)("blocks a quarantined candidate %s", async phase => {
    const f = await fixture();
    try {
      const path = `candidates/${encodeURIComponent(f.candidate.candidate_id)}`;
      const review = await f.call(path); expect(review.status).toBe(200);
      const staged = await f.call(`${path}/actions/stage-decision`, { schema_version: 2,
        intent_id: `memui:intent:v1:${"d".repeat(64)}`, operation: "remember", decision: "confirm",
        review_digest: review.body["review_digest"] });
      expect(staged.status).toBe(202);
      const control = new ControlPlane(f.database.authority); const command = control.get(staged.body["request_id"]);
      if (!command) throw new Error("missing command");
      const receipt = signCommandApproval({ schema_version: 1, receipt_id: "quarantine-confirmation",
        request_id: command.request_id, decision: "approve", command_digest: command.command_digest,
        signer_principal_id: "principal:owner", authenticated_session_id: "owner-session", key_id: "decision-test",
        algorithm: "Ed25519", issued_at: f.now.toISOString(), not_before: f.now.toISOString(),
        expires_at: command.expires_at, nonce: "quarantine-confirmation", max_uses: 1, status: "issued" },
      localKey(f.database.authority));
      if (phase === "after-approval") control.decide(receipt, f.now);
      new MemoryProjectionAuthority(f.database.authority).quarantineUnresolved({
        kind: "dashboard_projection", id: f.candidate.candidate_id, component_id: f.candidate.candidate_id }, f.now);
      expect((await f.call(path)).status).toBe(404);
      if (phase === "before-approval") {
        expect(() => control.decide(receipt, f.now)).toThrowError(expect.objectContaining({ code: "MEMORY_CANDIDATE_SUPPRESSED" }));
        expect(f.database.authority.db.prepare("SELECT COUNT(*) AS count FROM memory_candidate_owner_decisions").get())
          .toEqual({ count: 0 });
        expect(f.database.authority.db.prepare("SELECT COUNT(*) AS count FROM memory_candidate_dispatch_publications").get())
          .toEqual({ count: 0 });
      } else {
        const dispatch = await f.call(`${path}/actions/stage-dispatch`, { schema_version: 1,
          intent_id: `memui:intent:v1:${"e".repeat(64)}` });
        expect(dispatch.status).toBe(409);
        expect(f.database.authority.db.prepare("SELECT COUNT(*) AS count FROM control_command_requests WHERE action='memory.outbox.dispatch'")
          .get()).toEqual({ count: 0 });
      }
    } finally { f.close(); }
  });

  it.each(["confirm", "reject"] as const)("binds review and completes %s through the actual executor", async decisionKind => {
    const f = await fixture();
    try {
      const path = `candidates/${encodeURIComponent(f.candidate.candidate_id)}`;
      expect((await f.call(path, undefined, false)).status).toBe(403);
      const review = await f.call(path);
      expect(review.status).toBe(200); expect(review.headers["cache-control"]).toContain("no-store");
      expect(review.body["statement"]).toBe(f.input["statement"]);
      const decision = { schema_version: 2, intent_id: `memui:intent:v1:${"a".repeat(64)}`,
        operation: "remember", decision: decisionKind, review_digest: review.body["review_digest"] };
      expect((await f.call(`${path}/actions/stage-decision`, { ...decision,
        review_digest: `sha256:${"f".repeat(64)}` })).status).toBe(409);
      const first = await f.call(`${path}/actions/stage-decision`, decision);
      expect(first.status).toBe(202);
      expect((await f.call(`${path}/actions/stage-decision`, decision)).body["request_id"]).toBe(first.body["request_id"]);
      const control = new ControlPlane(f.database.authority); const command = control.get(first.body["request_id"]);
      expect(JSON.stringify(command)).not.toContain(f.input["statement"]);
      if (command === undefined) throw new Error("command missing");
      const dispatchBody = { schema_version: 1, intent_id: decision.intent_id };
      expect((await f.call(`${path}/actions/stage-dispatch`, dispatchBody)).status).toBe(409);
      control.decide(signCommandApproval({ schema_version: 1, receipt_id: "candidate-ui-confirmation",
        request_id: command.request_id, decision: "approve", command_digest: command.command_digest,
        signer_principal_id: "principal:owner", authenticated_session_id: "owner-session", key_id: "decision-test",
        algorithm: "Ed25519", issued_at: f.now.toISOString(), not_before: f.now.toISOString(),
        expires_at: command.expires_at, nonce: "candidate-ui-confirmation", max_uses: 1, status: "issued" },
      localKey(f.database.authority)), f.now);
      const completed = await new ApprovedCommandExecutor(f.database.authority,
        join(f.database.root, "backups"), join(f.database.root, "state"), {}, () => f.now)
        .execute(command.request_id, "candidate-ui-test", f.now);
      expect(completed.state).toBe("completed");
      expect(control.get(command.request_id)?.state).toBe("completed");
      if (decisionKind === "reject") {
        expect((await f.call("candidates?state=approved&limit=20")).body["items"]).toEqual([]);
        expect((await f.call(`${path}/actions/stage-dispatch`, dispatchBody)).status).toBe(409);
        expect(f.database.authority.db.prepare("SELECT state FROM memory_candidates WHERE candidate_id=?")
          .get(f.candidate.candidate_id)).toEqual({ state: "rejected" }); return;
      }
      const approved = await f.call("candidates?state=approved&limit=20");
      expect(approved.body["items"]).toEqual(expect.arrayContaining([expect.objectContaining({ actions: ["stage_dispatch"] })]));
      const staged = await f.call(`${path}/actions/stage-dispatch`, dispatchBody);
      expect(staged.status).toBe(202); expect(staged.body["state"]).toBe("pending");
      expect((await f.call(`${path}/actions/stage-dispatch`, dispatchBody)).body["request_id"]).toBe(staged.body["request_id"]);
      expect((await f.call("candidates?state=approved&limit=20")).body["items"]).toEqual([]);
      const progress = await f.call("remember-progress?limit=20");
      expect(progress.body["items"]).toEqual([expect.objectContaining({ request_id: staged.body["request_id"],
        state: "pending", outbox_state: null, stored: false })]);
      expect((await f.call(path)).status).toBe(409);
    } finally { f.close(); }
  });

  it("keeps the next approved candidate reachable after twenty commands were prepared", async () => {
    const f = await fixture();
    try {
      const store = new MemoryCandidateStore(f.database.authority, memoryPolicy(), () => f.now);
      store.attachReviewSpool(f.reviewRoot); const control = new ControlPlane(f.database.authority);
      let lastId = "";
      for (let index = 0; index < 21; index++) {
        const candidate = store.classify(inferredMemoryInput({ authority_id: `queue-${index}`,
          idempotency_key: `candidate:queue:${index}` }));
        lastId = candidate.candidate_id; const path = `candidates/${encodeURIComponent(lastId)}`;
        const review = await f.call(path);
        const staged = await f.call(`${path}/actions/stage-decision`, { schema_version: 2,
          intent_id: `memui:intent:v1:${"b".repeat(64)}`, operation: "remember", decision: "confirm",
          review_digest: review.body["review_digest"] });
        const command = control.get(staged.body["request_id"]);
        if (command === undefined) throw new Error("missing decision");
        control.decide(signCommandApproval({ schema_version: 1, receipt_id: `queue-${index}`,
          request_id: command.request_id, decision: "approve", command_digest: command.command_digest,
          signer_principal_id: "principal:owner", authenticated_session_id: "owner-session", key_id: "decision-test",
          algorithm: "Ed25519", issued_at: f.now.toISOString(), not_before: f.now.toISOString(),
          expires_at: command.expires_at, nonce: `queue-${index}`, max_uses: 1, status: "issued" },
        localKey(f.database.authority)), f.now);
        if (index < 20) expect((await f.call(`${path}/actions/stage-dispatch`, {
          schema_version: 1, intent_id: `memui:intent:v1:${"c".repeat(64)}` })).status).toBe(202);
      }
      expect((await f.call("candidates?state=approved&limit=20")).body["items"])
        .toEqual([expect.objectContaining({ candidate_id: lastId, actions: ["stage_dispatch"] })]);
    } finally { f.close(); }
  });

  it.each(["sensitive", "restricted"] as const)("does not expose %s candidate text", async sensitivity => {
    const f = await fixture();
    try {
      const store = new MemoryCandidateStore(f.database.authority, memoryPolicy(), () => f.now);
      store.attachReviewSpool(f.reviewRoot);
      const candidate = store.classify(inferredMemoryInput({ sensitivity, authority_id: sensitivity,
        idempotency_key: `candidate:${sensitivity}` }));
      const result = await f.call(`candidates/${encodeURIComponent(candidate.candidate_id)}`);
      expect(result.status).toBe(409); expect(result.body["statement"]).toBeUndefined();
    } finally { f.close(); }
  });

  it("refuses a self-consistent modified spool, expiry, and unbound publication without changing files", async () => {
    const f = await fixture();
    try {
      const spool = new MemoryCandidateReviewSpool(f.reviewRoot); const file = spool.paths()[0];
      if (file === undefined) throw new Error("review missing");
      const bytes = readFileSync(file); const value = spool.read(f.candidate.candidate_id);
      const changed = { ...value, statement: "Unapproved replacement text" };
      writeFileSync(file, JSON.stringify({ ...changed, review_envelope_digest: memoryCandidateReviewDigest(changed) }));
      expect(() => readCandidateReview(f.database.authority, f.reviewRoot, f.candidate.candidate_id, f.now))
        .toThrow("MEMORY_REVIEW_UNAVAILABLE");
      writeFileSync(file, bytes);
      expect(() => readCandidateReview(f.database.authority, f.reviewRoot, f.candidate.candidate_id,
        new Date(f.candidate.confirmation_expires_at!))).toThrow("MEMORY_CANDIDATE_EXPIRED");
      chmodSync(f.reviewRoot, 0o755);
      expect(() => readCandidateReview(f.database.authority, f.reviewRoot, f.candidate.candidate_id, f.now))
        .toThrow("MEMORY_REVIEW_UNAVAILABLE");
      expect(statSync(f.reviewRoot).mode & 0o777).toBe(0o755); chmodSync(f.reviewRoot, 0o700);
      expect(() => readCandidateReview(f.database.authority, join(f.database.root, "missing"),
        f.candidate.candidate_id, f.now)).toThrow("MEMORY_REVIEW_UNAVAILABLE");
      expect(existsSync(join(f.database.root, "missing"))).toBe(false);
      const unbound = new MemoryCandidateStore(f.database.authority, memoryPolicy(), () => f.now)
        .classify(inferredMemoryInput({ authority_id: "unbound", idempotency_key: "candidate:unbound" }));
      expect(() => readCandidateReview(f.database.authority, f.reviewRoot, unbound.candidate_id, f.now))
        .toThrow("MEMORY_REVIEW_UNAVAILABLE");
      expect(readCandidateReview(f.database.authority, f.reviewRoot, f.candidate.candidate_id, f.now)?.statement)
        .toBe(f.input["statement"]);
      expect(readFileSync(file)).toEqual(bytes);
    } finally { f.close(); }
  });
});
