// The production chain, shared by every regression that needs a database holding exactly what one
// real recommendation needs and nothing more. It inserts no recommendation and no context: making
// those is what the run under test is being asked to do.
//
// Extracted from tests/integration/daily-morning-production.test.ts so the compiled `daily morning`
// CLI regression, the configured-service regression and the current-validity matrix all produce
// from the same stored evidence rather than from three differently-shaped fixtures.
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { signCommandApproval } from "../../src/control-plane-contract.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { MemoryMutationService } from "../../src/dashboard/memory-mutation-service.js";
import { MemoryTokenCache } from "../../src/dashboard/memory-token-cache.js";
import { LocalTimelineSnapshotStore } from "../../src/local-timeline-snapshot-store.js";
import { admitLocalTimelineObservation } from "../../src/local-timeline-observation.js";
import { ObservationRefreshStore } from "../../src/observation-refresh-store.js";
import type { OrcaTaskObservationInput } from "../../src/index.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import { MemoryCandidateDispatchSpool } from "../../src/memory-candidate-dispatch-spool.js";
import { MemoryOutboxService } from "../../src/memory-outbox.js";
import { memoryCandidateSpoolRoots } from "../../src/memory-outbox-production.js";
import { createProductionMemoryReference } from "../../src/memory-reference-production.js";
import { SecondBrainEffectService } from "../../src/second-brain-effect-service.js";
import { createSecondBrainTransport } from "../../src/second-brain-transport.js";
import { approveFixtureOwnerDecision, sealFixtureAuthority } from "./fixture-authority.js";
import { inferredMemoryInput, memoryPolicy } from "./memory-candidate-fixture.js";
import { memoryDatabase } from "./memory-candidate-store.js";
import { evidence, FixtureReader, FixtureWriter, OUTBOX_ARTIFACT_DIGEST } from "./memory-outbox-fixture.js";
import { localKey } from "../helpers.js";

// The morning schedule fires at 07:15:00.000 KST and the shipped policy is effective from
// 2026-08-28T00:00:00.000Z. Everything is prepared at one instant so nothing depends on ordering.
export const AT = "2026-08-28T22:15:00.000Z";
export const CLI_AT = "2026-08-28T22:15:00.005Z";
// The same morning, asked again half a minute later: still 2026-08-29 in Seoul, and still inside
// the windows the first run wrote, so nothing about the second run's inputs has changed.
export const CLI_AT_AGAIN = "2026-08-28T22:15:30.000Z";
export const TASK = "task:daily-production";
// The candidate fixtures carry their own evidence window around midday, and a confirmation does not
// expire because the sun moved: the memory is confirmed and settled at that instant, while the
// observation and the owner's import approval belong to the morning the run is for.
export const MEMORY_AT = "2026-08-28T12:00:00.000Z";
// The destination this database's own approved write recorded. The provider is asked for what it
// holds; only a record arriving on this page and section can name the candidate behind it.
export const PAGE = "wiki/example-alpha";
export const SID = "12345678";
export const LIVE_SOURCE = "src:pos:v1:orca:local";
export const BINARY = resolve(process.cwd(), "dist/src/cli.js");
export const HARNESS = resolve(process.cwd(), "dist/tests/fixtures/compiled-daily-cli.js");
export const PROVIDER_CHILD = resolve(process.cwd(), "tests/fixtures/second-brain-mcp-child.mjs");

export const dailyProductionChild = (args: readonly string[], environment: Readonly<Record<string, string>> = {}) => {
  const inherited = { ...process.env };
  delete inherited["JARVIS_SECOND_BRAIN_LAUNCHER"];
  delete inherited["JARVIS_SECOND_BRAIN_CONFIG"];
  const result = spawnSync(process.execPath, [...args],
    { encoding: "utf8", env: { ...inherited, ...environment } });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/**
 * A database holding only what the owner and the machine actually produced: one admitted local
 * observation, one verified live fact, and one memory the owner decided on - beside a real stdio
 * memory provider that serves the destination this database's own write recorded.
 *
 * The provider states no trust and no evidence kind. It answers as a provider does, and the
 * reference seam decides what that may become by asking this database: a settled write of ours on
 * that page and section, a task still open, and the owner's confirmation on record.
 */
export async function prepareDailyProductionChain(options: { readonly ownerDecision: "confirm" | "reject";
  readonly ownerAuthorization: boolean }) {
  expect(existsSync(BINARY), "dist/src/cli.js is required; run npm run build:backend").toBe(true);
  expect(existsSync(HARNESS), "dist/tests/fixtures is required; run npm run build:backend").toBe(true);
  const database = await memoryDatabase();
  const authority = database.authority;
  const at = new Date(AT);
  // The product derives its spool roots from the database filename, and a separate CLI process has
  // no other way to find them, so the preparation writes where that process will look.
  const roots = memoryCandidateSpoolRoots(authority.filename);
  const reviewRoot = roots.candidate_review_spool_root;
  const dispatchRoot = roots.candidate_dispatch_spool_root;
  const root = dirname(authority.filename);

  // (a) a local observation, admitted through the product's own collection path
  authority.db.prepare(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,
    idempotency_key,state,created_at) VALUES('daily-production',?,'dispatch','{}','sha256:fixture','daily-production','pending',?)`)
    .run(TASK, new Date(at.getTime() - 3_600_000).toISOString());
  const store = new LocalTimelineSnapshotStore(authority, () => at);
  store.register(TASK);
  const snapshot = store.refresh(TASK);
  admitLocalTimelineObservation(authority, TASK, snapshot.collection_id, () => at);
  // A verified live Linux fact beside it: an advisory local collection cannot carry a current fact,
  // so without this there is nothing an action could rest on and withholding would be correct. It is
  // admitted through the store a collector writes to, because a current Linux fact is one this
  // machine went and looked at - a well-shaped envelope handed in is not the same thing.
  const liveTask: OrcaTaskObservationInput = {
    environment: "local", worktree: "/home/jm/orca/workspaces/daily", worktree_id: "worktree-daily",
    terminal_id: "terminal-daily", session_id: "session-daily", incarnation_id: "incarnation-daily",
    pty_id: "pty-daily", cursor: "cursor-daily", working: true,
    timeline: { schema_version: 1, generated_at: AT,
      task: { task_id: TASK, title: "not persisted", kind: "work", state: "running",
        updated_at: new Date(at.getTime() - 60_000).toISOString(), pending_approval: false,
        source_ids: ["source-daily"] },
      events: [{ event_id: "evidence-daily", task_id: TASK, source: "verification", kind: "evidence",
        actor: "verifier", title: "not persisted", status: "recorded", payload: { fact: "not persisted" },
        evidence_refs: ["verify-daily"], created_at: new Date(at.getTime() - 60_000).toISOString(),
        sequence: 1 }],
      pending_decisions: [], workers: [], evidence: [], truncated: false } };
  new ObservationRefreshStore(authority,
    { members: [{ source_id: LIVE_SOURCE, worktree_id: liveTask.worktree_id }] })
    .admit({ key: "daily-production", capped: false,
      collections: [{ source_id: LIVE_SOURCE, worktree_id: liveTask.worktree_id, state: "completed" }],
      observations: { checked_at: AT, portfolios: [], orca_tasks: [liveTask] } }, AT);

  // (b) the owner's decision on one memory, taken through the real confirmation path
  const memoryAt = new Date(MEMORY_AT);
  const candidates = new MemoryCandidateStore(authority, memoryPolicy(), () => memoryAt);
  candidates.attachReviewSpool(reviewRoot);
  const candidate = candidates.classify(inferredMemoryInput({ subject: PAGE, statement: "ExampleAlpha" }));
  const mutation = new MemoryMutationService({ authority, clock: () => memoryAt,
    session: createDashboardSession("owner-session"),
    tokens: new MemoryTokenCache(Buffer.alloc(32, 1), () => memoryAt),
    candidate_review_spool_root: reviewRoot, candidate_dispatch_spool_root: dispatchRoot });
  const decision = mutation.stageCandidateDecision({ candidate_id: candidate.candidate_id,
    operation: "remember", decision: options.ownerDecision, intent_id: `memui:intent:v1:${"1".repeat(64)}` });
  if (decision === undefined) throw new Error("decision command required");
  const control = new ControlPlane(authority);
  const sign = (receiptId: string, requestId: string, digest: string, expiresAt: string) =>
    signCommandApproval({ schema_version: 1, receipt_id: receiptId, request_id: requestId,
      decision: "approve", command_digest: digest, signer_principal_id: "principal:owner",
      authenticated_session_id: "owner-session", key_id: "decision-test", algorithm: "Ed25519",
      issued_at: MEMORY_AT, not_before: MEMORY_AT, expires_at: expiresAt, nonce: receiptId, max_uses: 1,
      status: "issued" }, localKey(authority));
  control.decide(sign("daily-confirmation", decision.request_id, decision.command_digest, decision.expires_at), memoryAt);

  // (c) only a confirmed memory is ever written out, so only that one can settle
  if (options.ownerDecision === "confirm") {
    const dispatch = new MemoryCandidateDispatchSpool(dispatchRoot).read(candidate.candidate_id);
    const actionId = "daily-outbox-action";
    const action = { schema_version: 1 as const, request_id: actionId, action: "memory.outbox.dispatch",
      action_level: 3 as const, target: { candidate_id: candidate.candidate_id,
        candidate_digest: candidate.candidate_digest, classification_digest: candidate.classification_digest },
      args: { schema_version: 2, dispatch_spool_digest: dispatch.dispatch_spool_digest,
        expected_artifact: { page_id: PAGE, sid: SID, source_digest: OUTBOX_ARTIFACT_DIGEST } },
      reversible: false, requested_by: "principal:owner", requested_at: MEMORY_AT,
      expires_at: new Date(memoryAt.getTime() + 900_000).toISOString(), nonce: "daily-outbox-nonce" };
    const staged = control.stage(action, memoryAt);
    control.decide(sign("daily-outbox-approval", actionId, staged.command_digest, action.expires_at), memoryAt);
    const outbox = new MemoryOutboxService({ authority, writer: new FixtureWriter(),
      reader: new FixtureReader({ kind: "current", checked_at: MEMORY_AT, evidence: [evidence(OUTBOX_ARTIFACT_DIGEST)] }),
      clock: () => memoryAt, artifactDeadlineMs: 30_000, leaseMs: 10_000,
      candidate_dispatch_spool_root: dispatchRoot, candidate_review_spool_root: reviewRoot });
    const queued = outbox.enqueue(control.claim(actionId, "daily-worker", memoryAt));
    expect(await outbox.runOnce("daily-worker", 1)).toMatchObject({ settled: 1 });
    expect(outbox.get(queued.outbox_id)).toMatchObject({ state: "settled" });
  }
  await sealFixtureAuthority(authority);
  // The workflow the owner started, which is the only thing that lets a proposal be made at all.
  // The workflow names the work it is for: the task this morning's live fact is an observation of.
  if (options.ownerAuthorization) approveFixtureOwnerDecision(authority, "req:daily:workflow", AT, `task:${TASK}`);

  // (d) the memory provider this deployment reads through: a real stdio child, serving a record on
  // the page and section the write above was approved for. It declares no trust of its own.
  const projectionKey = join(root, "memory-projection.key");
  writeFileSync(projectionKey, randomBytes(32), { mode: 0o600 });
  chmodSync(projectionKey, 0o600);
  chmodSync(PROVIDER_CHILD, 0o755);
  const launcher = join(root, "second-brain-mcp");
  symlinkSync(PROVIDER_CHILD, launcher);
  const providerConfig = join(root, "provider-config.json");
  writeFileSync(providerConfig, JSON.stringify({ adapterScenario: "schema4", schema4Pages: [{
    page_id: PAGE, sensitivity: "personal", updated: "2026-08-28",
    records: [{ sid: SID, text: "ExampleAlpha", valid_from: "2026-08-28T00:00:00.000Z" }] }] }));

  // (e) the target identity behind that record, resolved from the provider through the product's
  // own effect service. Nothing may rest on a memory this database cannot later suppress, so the
  // morning run can only cite a record whose target identity is already on record here.
  if (options.ownerDecision === "confirm") {
    const transport = createSecondBrainTransport({ launcherPath: launcher, configPath: providerConfig });
    try {
      const runtime = createProductionMemoryReference(authority, { clock: () => new Date(CLI_AT), transport });
      const reference = await runtime.reader.read("What should happen next?",
        { max_records: 8, max_record_bytes: 4_096, max_bytes: 32_768 });
      const first = reference.payload.records[0];
      if (first === undefined) throw new Error("provider record required");
      const status = await transport.call("sb_generation_status", { read_fence: null });
      if (status.kind !== "data") throw new Error("provider status required");
      const effect = new SecondBrainEffectService({ authority, transport,
        writer: { write: () => Promise.reject(new Error("fixture performs no write")) },
        clock: () => new Date(CLI_AT), provider_instance_id: String(status.value["provider_instance_id"]),
        signing_key_id: "memory-effect-fixture", private_key: generateKeyPairSync("ed25519").privateKey });
      expect(await effect.resolveTarget({ record_id: first.record.record_id,
        record_digest: first.record.record_digest, generation_id: String(status.value["generation_id"]),
        generation_manifest_digest: String(status.value["generation_manifest_digest"]) }))
        .toMatchObject({ kind: "data" });
    } finally { await transport.close(); }
  }

  // Nothing has been produced yet: that is what the run is being asked to do.
  const count = (table: string) => Number(authority.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get());
  expect(count("personal_recommendations")).toBe(0);
  expect(count("personal_context_snapshots")).toBe(0);
  expect(count("personal_observations")).toBe(2);

  const input = join(database.root, "daily.json");
  writeFileSync(input, JSON.stringify({ schema_version: 1, time_zone: "Asia/Seoul", lease_ms: 300_000,
    deadline_ms: 600_000, recovery_window_ms: 600_000, recovery_lookback_days: 2,
    refresh_freshness_ms: 600_000, budgets: { max_items: 8, max_work: 8, max_bytes: 8192 } }));
  const path = database.authority.filename;
  authority.close();
  return { database, path, input, launcher, providerConfig, candidateId: candidate.candidate_id,
    provider: { JARVIS_SECOND_BRAIN_LAUNCHER: launcher, JARVIS_SECOND_BRAIN_CONFIG: providerConfig } };
}
