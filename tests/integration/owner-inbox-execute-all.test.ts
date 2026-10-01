import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import { ApprovedCommandExecutor, approvedActionHasExecutor } from "../../src/approved-executor.js";
import { KNOWN_CONTROL_ACTIONS } from "../../src/control-actions.js";
import { ControlPlane, type ControlCommandRequestInput } from "../../src/control-plane.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { DEFAULT_AGENTOPS_LOOP } from "../../src/loopgraph.js";
import { externalDelegateBatchDigest } from "../../src/external-delegate.js";
import { OWNER_INBOX_MANUAL_WAIT, OwnerInbox } from "../../src/owner-inbox.js";
import { ControlReceiptSigner } from "../../src/remote-approval-signer.js";
import { initialized, localKey, snapshot } from "../helpers.js";
import { approvedTaskFixture } from "../fixtures/approved-task-fixture.js";
import { stageTaskExecution } from "../../src/task-execution-staging.js";
import { memoryDatabase, closeMemoryDatabase, seedMemoryAuthority, memoryCandidateStore } from "../fixtures/memory-candidate-store.js";
import { verifiedMemoryInput, MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import { proposeMemoryCandidateScope } from "../../src/memory-candidate-scope.js";
import { stageMemoryScopeReview } from "../../src/memory-scope-review.js";

const NOW = new Date("2026-09-30T00:00:00.000Z");
const EXPIRES = "2026-09-30T01:00:00.000Z";
const sha = (fill: string) => `sha256:${fill.repeat(64)}`;
const hex = (fill: string) => fill.repeat(32);

function command(action: string, level: number, target: Record<string, unknown>, args: Record<string, unknown>, reversible: boolean, requestedBy = "principal:owner"): ControlCommandRequestInput {
  return {
    schema_version: 1, request_id: `inbox:${action}`, action, action_level: level as 0 | 1 | 2 | 3 | 4 | 5,
    target, args, reversible, requested_by: requestedBy, requested_at: NOW.toISOString(),
    expires_at: EXPIRES, nonce: `nonce:${action}`,
  };
}

function delegateCommand(): ControlCommandRequestInput {
  const digest = sha("d");
  const items = [{ action_kind: "payment", summary: "pay fixture", payload_digest: digest }];
  const batch = externalDelegateBatchDigest(items);
  return command("external.delegate", 3, { environment: "external", system: "grok-bot" }, {
    source: "grok-bot", action_kind: "payment", summary: "pay fixture", batch_summary: "pay fixture",
    batch_digest: batch, payload_digest: batch, items,
  }, false, "agent:grok-bot");
}

function payloads(): ControlCommandRequestInput[] {
  const candidate = `memcand:pos:v1:${hex("ab")}`;
  const digest = sha("a");
  const local = { environment: "local" };
  const budget = { max_steps: 4, max_attempts_per_node: 1, deadline: "2026-09-30T02:00:00.000Z" };
  const binding = {
    schema_version: 1, candidate_id: candidate, correlation_id: `corr:memory:${hex("cd")}`,
    subject_digest: digest, content_digest: digest, source_id: "src", source_version: "v1",
    operation: "remember", purpose: "personal_memory", sensitivity: "personal",
  };
  return [
    command("database.backup", 2, local, { destination: "snapshot.sqlite" }, true),
    command("database.restore_drill", 1, local, { source: "snapshot.sqlite" }, true),
    command("state.project", 1, local, {}, true),
    command("workflow.register", 3, { environment: "local", loop_id: "inbox-loop" }, {
      spec: { ...DEFAULT_AGENTOPS_LOOP, loop_id: "inbox-loop" },
    }, true),
    command("workflow.start", 2, { environment: "local" }, {
      run_id: "run-inbox", loop_id: "inbox-loop", correlation_id: "corr-inbox", input: {}, budget,
    }, true),
    command("workflow.advance", 2, { environment: "local" }, { run_id: "run-inbox", outcome: "observed" }, true),
    command("workflow.cancel", 3, { environment: "local" }, { run_id: "run-missing", reason: "stop" }, true),
    command("runbook.execute", 1, { environment: "local", runbook_id: "runtime-diagnose" }, {
      runbook_id: "runtime-diagnose", args: {},
    }, true),
    command("git.push", 4, { task_id: "task-inbox" }, { task_id: "task-inbox", branch: "main" }, true),
    command("collaboration.room.create", 3, { task_id: "task-inbox" }, { room: { room_id: "room-inbox" } }, true),
    command("evidence.negative.record", 2, { environment: "local", task_id: "codex-work" }, {
      schema_version: 1, task_id: "codex-work", attempt_id: "attempt:inbox", reason_code: "failed_approach",
      scope: ["src/approved-executor.ts"], summary: "bounded", evidence_digest: digest,
    }, true),
    command("memory.confirm", 3, {
      candidate_id: candidate, candidate_digest: digest, classification_digest: digest,
    }, { schema_version: 1, operation: "correct", evidence_digest: digest }, false),
    command("memory.outbox.dispatch", 3, {
      candidate_id: candidate, candidate_digest: digest, classification_digest: digest,
    }, {
      schema_version: 2, dispatch_spool_digest: digest,
      expected_artifact: { page_id: "page", sid: "sid", source_digest: digest },
      confirm_binding: {
        confirm_request_id: "confirm", confirm_receipt_id: "receipt",
        confirm_command_digest: digest, approved_candidate_digest: digest,
      },
    }, false),
    command("memory.outbox.abandon-not-delivered", 3, { outbox_id: `memout:pos:v2:${hex("ef")}` }, {
      schema_version: 1, outbox_id: `memout:pos:v2:${hex("ef")}`,
    }, false),
    command("memory.delete", 3, {
      deletion_id: `memdel:req:v1:${hex("11")}`, target_manifest_digest: digest, scope_digest: digest,
    }, {
      schema_version: 3, lane: "deletion", lane_id: `memdel:req:v1:${hex("11")}`, provider_instance_id: "sb",
      target_manifest_digest: digest, scope_digest: digest, payload_digest: digest, spool_digest: digest,
      expires_at: EXPIRES,
    }, false),
    command("memory.export", 3, {
      export_id: `memexp:req:v1:${hex("22")}`, target_manifest_digest: digest, scope_digest: digest,
    }, {
      schema_version: 3, lane: "export", lane_id: `memexp:req:v1:${hex("22")}`, provider_instance_id: "sb",
      target_manifest_digest: digest, scope_digest: digest, payload_digest: digest, spool_digest: digest,
      expires_at: EXPIRES,
    }, false),
    command("memory.generation.rollback", 4, { provider_instance_id: "sb", generation_id: "gen-1" }, {
      schema_version: 1, provider_instance_id: "sb", generation_id: "gen-1", reason: "drill",
    }, false),
    command("memory.instruction.record", 3, { candidate_id: candidate, correlation_id: binding.correlation_id }, {
      ...binding, instruction_id: "instruction-1",
    }, false),
    command("memory.decision.record", 3, { candidate_id: candidate, correlation_id: binding.correlation_id }, {
      ...binding, decision_id: "decision-1",
    }, false),
    command("remote.credential.enroll.begin", 3, {
      principal_id: "principal:owner", user_handle_digest: digest, rp_id: "127.0.0.1", origin: "http://127.0.0.1",
    }, { schema_version: 1, enrollment_id: "enroll-1", enrollment_nonce_digest: digest }, true),
    command("remote.credential.enroll.activate", 3, {
      principal_id: "principal:owner", credential_id_digest: digest, public_key_digest: digest,
      user_handle_digest: digest, rp_id: "127.0.0.1", origin: "http://127.0.0.1",
    }, {
      schema_version: 1, enrollment_id: "enroll-1", registration_ceremony_id: "ceremony-1",
      algorithm: -7, backup_eligible: 0,
    }, true),
    command("remote.credential.revoke", 3, {
      principal_id: "principal:owner", credential_id_digest: digest, public_key_digest: digest,
    }, { schema_version: 1, reason_digest: digest }, true),
    command("remote.principal.revoke", 4, { principal_id: "principal:owner", user_handle_digest: digest }, {
      schema_version: 1, reason_digest: digest,
    }, true),
    delegateCommand(),
  ];
}

async function boot(db: Awaited<ReturnType<typeof initialized>>, runtime?: ConstructorParameters<typeof ApprovedCommandExecutor>[8], now = NOW, principal = "test-operator") {
  const root = mkdtempSync(join(tmpdir(), "inbox-exec-"));
  const backup = join(root, "backups");
  const state = join(root, "state");
  writeFileSync(join(root, "index.html"), "<!doctype html>");
  const inbox = new OwnerInbox(db, new ControlReceiptSigner(localKey(db), "decision-test", principal), true, () => now);
  db.db.prepare("INSERT INTO owner_inbox_credentials(credential_id, public_key, counter, created_at) VALUES(?,?,?,?)")
    .run("test-pass", Buffer.from("pk"), 0, now.toISOString());
  const server = createDashboardServer({
    db, staticRoot: root, host: "127.0.0.1", port: 0, clock: () => now, ownerInbox: inbox,
    assertionCheck: async () => ({ ok: true, newCounter: 1 }),
    executorFactory: ({ db: bound, now }) => new ApprovedCommandExecutor(
      bound, backup, state, {}, () => now, undefined, undefined, undefined, runtime,
    ),
  });
  const origin = `http://127.0.0.1:${server.address.port}`;
  const session = await request(`${origin}/api/v1/session`);
  const body = await session.body.json() as { csrf_token: string };
  const cookie = session.headers["set-cookie"];
  return {
    server, origin, inbox,
    headers: {
      origin, host: new URL(origin).host, "content-type": "application/json",
      "x-jarvis-csrf": body.csrf_token,
      cookie: (Array.isArray(cookie) ? cookie[0] ?? "" : String(cookie ?? "")).split(";")[0] ?? "",
    },
  };
}

async function approve(live: Awaited<ReturnType<typeof boot>>, id: string, digest: string) {
  const challenge = await request(`${live.origin}/api/v1/owner-inbox/challenge`, {
    method: "POST", headers: live.headers,
    body: JSON.stringify({ schema_version: 1, request_id: id, decision: "approve", command_digest: digest }),
  });
  expect(challenge.statusCode).toBe(200);
  const issued = await challenge.body.json() as { challenge_id: string };
  const decided = await request(`${live.origin}/api/v1/owner-inbox/decide`, {
    method: "POST", headers: live.headers,
    body: JSON.stringify({
      schema_version: 1, request_id: id, decision: "approve", command_digest: digest,
      challenge_id: issued.challenge_id,
      assertion: { id: "test-pass", clientDataJSON: "", authenticatorData: "", signature: "ok", userHandle: "" },
    }),
  });
  expect(decided.statusCode, id).toBe(200);
  return decided.body.json() as Promise<{ execution: { state: string; manual_wait?: boolean; failure_code?: string } }>;
}

describe("owner inbox executes every action that has an executor", () => {
  it("claims each executable action once and leaves the rest approved for manual execution", async () => {
    const db = await initialized();
    db.ingest(snapshot());
    const control = new ControlPlane(db);
    const staged = payloads().map(input => control.stage(input, NOW));
    const covered = new Set(staged.map(row => row.action));
    expect([...covered].sort()).toEqual(KNOWN_CONTROL_ACTIONS.filter(action => action !== "memory.scope.review" && action !== "task.execute"));
    const live = await boot(db);
    try {
      for (const row of staged) {
        const body = await approve(live, row.request_id, row.command_digest);
        const stored = db.db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(row.request_id) as { state: string };
        const redemptions = db.db.prepare("SELECT COUNT(*) AS n FROM control_command_redemptions WHERE request_id=?").get(row.request_id) as { n: number };
        if (approvedActionHasExecutor(row.action)) {
          expect(redemptions.n, row.action).toBe(1);
          expect(stored.state, row.action).not.toBe("approved");
          expect(body.execution.manual_wait, row.action).not.toBe(true);
        } else {
          expect(redemptions.n, row.action).toBe(0);
          expect(stored.state, row.action).toBe("approved");
          expect(body.execution).toMatchObject({ state: "approved", manual_wait: true });
        }
      }
      const waiting = live.inbox.list().filter(item => item.manual_wait);
      expect(waiting.length).toBeGreaterThan(0);
      expect(waiting.every(item => item.summary === OWNER_INBOX_MANUAL_WAIT)).toBe(true);
      expect(waiting.map(item => item.action)).toContain("git.push");
      const again = db.db.prepare("SELECT COUNT(*) AS n FROM control_command_redemptions WHERE request_id='inbox:memory.delete'").get() as { n: number };
      expect(again.n).toBe(1);
    } finally {
      live.server.close();
      db.close();
    }
  });

  it("runs a staged task.execute through the real executor after inbox approval", async () => {
    const fixture = await approvedTaskFixture(true, { stage: false });
    try {
      const staged = stageTaskExecution(fixture.db, { ...fixture.request, plan: fixture.plan }, fixture.now);
      const live = await boot(fixture.db, fixture.runtime, fixture.now, "test-operator");
      try {
        const body = await approve(live, staged.request_id, staged.command_digest);
        expect(body.execution.state === "completed" || body.execution.state === "failed" || body.execution.state === "uncertain").toBe(true);
        const redemptions = fixture.db.db.prepare("SELECT COUNT(*) AS n FROM control_command_redemptions WHERE request_id=?").get(staged.request_id) as { n: number };
        expect(redemptions.n).toBe(1);
        expect(fixture.generate).toHaveBeenCalledTimes(1);
      } finally { live.server.close(); }
    } finally { await fixture.cleanup(); }
  });

  it("approves memory.scope.review without claiming it", async () => {
    const f = await memoryDatabase();
    try {
      const now = new Date(MEMORY_NOW);
      const input = verifiedMemoryInput();
      seedMemoryAuthority(f.authority, input);
      const candidate = memoryCandidateStore(f.authority).classify(input);
      const proposal = proposeMemoryCandidateScope(f.authority, candidate.candidate_id, {
        owner: "principal:owner", projects: ["project:a"], policy_revision: "policy:1",
        valid_until: new Date(now.getTime() + 60_000).toISOString(),
      }, now);
      const staged = stageMemoryScopeReview(f.authority, proposal, now);
      const inbox = new OwnerInbox(f.authority, new ControlReceiptSigner(localKey(f.authority), "decision-test", "principal:owner"), true, () => now);
      f.authority.db.prepare("INSERT INTO owner_inbox_credentials(credential_id, public_key, counter, created_at) VALUES(?,?,?,?)")
        .run("cred", Buffer.from("pk"), 0, now.toISOString());
      const issued = inbox.issueChallenge({
        request_id: staged.request_id, decision: "approve", command_digest: staged.command_digest, session_id: "session-1",
      });
      const decided = await inbox.decide({
        request_id: staged.request_id, decision: "approve", command_digest: staged.command_digest, session_id: "session-1",
        challenge_id: issued.challenge_id,
        assertion: { id: "cred", clientDataJSON: "", authenticatorData: "", signature: "", userHandle: "" },
        origin: "http://127.0.0.1", rpId: "127.0.0.1", check: async () => ({ ok: true, newCounter: 1 }),
      });
      expect(decided.state).toBe("approved");
      expect(approvedActionHasExecutor("memory.scope.review")).toBe(false);
      const listed = inbox.list().find(item => item.request_id === staged.request_id);
      expect(listed?.summary).toBe(OWNER_INBOX_MANUAL_WAIT);
      expect(f.authority.db.prepare("SELECT COUNT(*) AS n FROM control_command_redemptions WHERE request_id=?").get(staged.request_id)).toEqual({ n: 0 });
    } finally { closeMemoryDatabase(f); }
  });
});
