// Usage: node scripts/packaged-production-chain-probe.mjs PACKAGE_ROOT [RECEIPT_PATH]
// Runs the observation -> memory -> context -> recommendation -> brief chain inside the supplied
// package, through the packaged product's own daily command. Every product module is loaded from
// the package; nothing resolves into the development checkout.
//
// Nothing below declares a memory, a trust level or an evidence kind. The provider is a real stdio
// child answering as a provider does, and what it returns only becomes evidence if this database
// can show a settled write of ours on that destination, the owner's confirmation for that content,
// and the resolved target identity a later forget would reach the artifact through.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestEnvironment } from "./lib/test-environment.mjs";

assert.ok(process.argv[2], "PACKAGE_ROOT required");
const root = resolve(process.argv[2]);
const receipt = JSON.parse(readFileSync(join(root, "runtime-package-receipt.json"), "utf8"));
const load = name => import(pathToFileURL(join(root, "dist/src", name)).href);

// The morning schedule fires at 07:15:00.000 KST and the shipped policy is effective from
// 2026-08-28T00:00:00.000Z. The packaged binary exposes no clock override and must not gain one, so
// the fixed instant reaches it the way the runtime already supports: through execute()'s
// dependencies, in the test entry the package ships.
const AT = "2026-08-28T22:15:00.000Z";
const CLI_AT = "2026-08-28T22:15:00.005Z";
const MEMORY_AT = "2026-08-28T12:00:00.000Z";
const TASK = "task:packaged-production";
const PAGE = "wiki/example-alpha";
const SID = "12345678";
const ARTIFACT_LINE = "ExampleAlpha.[^12345678]";
const sha = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const ARTIFACT_DIGEST = sha(ARTIFACT_LINE);
const shift = ms => new Date(Date.parse(AT) + ms).toISOString();
const PROVIDER_CHILD = resolve("tests/fixtures/second-brain-mcp-child.mjs");

const scratch = createTestEnvironment({ PATH: process.env.PATH });
try {
  // The package must satisfy its own runtime dependencies. A module resolving back into the
  // development checkout would make everything below a statement about that checkout instead.
  const packageRequire = createRequire(pathToFileURL(join(root, "package.json")).href);
  const sqlite = packageRequire.resolve("better-sqlite3");
  assert.ok(sqlite.startsWith(root + "/"), `better-sqlite3 resolved outside the package: ${sqlite}`);

  const { AuthorityDb } = await load("db.js");
  const { ControlPlane } = await load("control-plane.js");
  const { signCommandApproval } = await load("control-plane-contract.js");
  const { normalizePersonalObservations } = await load("personal-observations.js");
  const { LocalTimelineSnapshotStore } = await load("local-timeline-snapshot-store.js");
  const { admitLocalTimelineObservation } = await load("local-timeline-observation.js");
  const { MemoryCandidateStore } = await load("memory-candidate-store.js");
  const { MemoryCandidateDispatchSpool } = await load("memory-candidate-dispatch-spool.js");
  const { MemoryOutboxService } = await load("memory-outbox.js");
  const { memoryCandidateSpoolRoots } = await load("memory-outbox-production.js");
  const { MemoryMutationService } = await load("dashboard/memory-mutation-service.js");
  const { MemoryTokenCache } = await load("dashboard/memory-token-cache.js");
  const { createDashboardSession } = await load("dashboard/session.js");
  const { createSecondBrainTransport } = await load("second-brain-transport.js");
  const { SecondBrainEffectService } = await load("second-brain-effect-service.js");
  const { createProductionMemoryReference } = await load("memory-reference-production.js");
  const { todayProjection } = await load("dashboard/personal-today.js");
  const policy = JSON.parse(readFileSync(join(root, "config/personal-os-policy.json"), "utf8"));

  // An isolated decision anchor, sealed through the product's own initialization path. No operator
  // key is used and none is created outside this scratch directory.
  const decision = generateKeyPairSync("ed25519");
  const verifier = generateKeyPairSync("ed25519");
  const anchor = (name, key) => {
    const path = join(scratch.root, `${name}.pub.pem`);
    writeFileSync(path, key.export({ type: "spki", format: "pem" }));
    return path;
  };

  const liveTask = suffix => ({
    environment: "local", worktree: "/home/jm/orca/workspaces/packaged", worktree_id: "worktree-packaged",
    terminal_id: "terminal-packaged", session_id: "session-packaged",
    incarnation_id: `incarnation-packaged-${suffix}`, pty_id: "pty-packaged",
    cursor: `cursor-packaged-${suffix}`, working: true,
    timeline: { schema_version: 1, generated_at: AT,
      task: { task_id: TASK, title: "not persisted", kind: "work", state: "running",
        updated_at: shift(-60000), pending_approval: false, source_ids: ["source-packaged"] },
      events: [{ event_id: `evidence-packaged-${suffix}`, task_id: TASK, source: "verification",
        kind: "evidence", actor: "verifier", title: "not persisted", status: "recorded",
        payload: { fact: "not persisted" }, evidence_refs: [`verify-packaged-${suffix}`],
        created_at: shift(-60000), sequence: 1 }],
      pending_decisions: [], workers: [], evidence: [], truncated: false },
  });

  // What the owner is asked about. The classification, the policy decision and the confirmation all
  // happen in the package; this is only the input a collector would hand it.
  const candidateInput = {
    schema_version: 1, idempotency_key: "candidate:packaged:inference", operation: "remember",
    subject: PAGE, statement: "ExampleAlpha", purpose: "personal_memory", sensitivity: "personal",
    host: "linux-second-brain", principal_id: "principal:owner", payload_fields: ["summary"],
    source: { class: "labeled_inference", source_id: "inference-source-packaged", source_version: "v1",
      inference_id: "inference-packaged", label: "inference",
      references: [{ kind: "inference_evidence",
        identifier: { namespace: "inference_evidence", id: sha("packaged-inference-evidence").slice(7), version: 1 },
        evidence_digest: sha("packaged-inference-evidence-digest"),
        observed_at: "2026-08-28T11:00:00.000Z", fresh_until: "2026-08-28T13:00:00.000Z",
        expires_at: "2026-08-29T12:00:00.000Z" }] },
    second_brain: { state: "available" }, conflict: { state: "none", references: [] },
  };

  // The provider's acceptance of one write, and the reconciliation observing the artifact it landed
  // on. Neither states a trust level: they are what a provider answers, and the outbox is what
  // decides the write settled.
  const writer = { write: request => Promise.resolve({ kind: "accepted", state: "pending",
    candidate_id: request.candidate_id, request_id: request.request_id,
    request_digest: request.request_digest, idempotency_key: request.idempotency_key,
    operation: request.operation, accepted_at: MEMORY_AT,
    inbox_path: `inbox/.requests/pending/${request.request_id}.json`,
    request_file_digest: sha("packaged-request-file"), replayed: false }) };
  const observed = { kind: "current", checked_at: MEMORY_AT, evidence: [{ kind: "memory", page_id: PAGE,
    sid: SID, source_ref: "synthetic:ExampleAlpha", source_id: "src:pos:v1:second-brain:primary",
    source_version: "sb/0.1.0|v1|fixture", sensitivity: "personal", observed_at: MEMORY_AT,
    valid_at: MEMORY_AT, freshness: { state: "fresh", checked_at: MEMORY_AT, fresh_until: "2026-08-28T13:00:00.000Z" },
    expires_at: "2026-08-29T12:00:00.000Z", trust: "untrusted", authority: "none",
    excerpt: ARTIFACT_LINE, content_digest: ARTIFACT_DIGEST, omission: null, record: null }] };
  const reader = { search: () => Promise.resolve(observed), readPage: () => Promise.resolve(observed),
    recentChanges: () => Promise.resolve(observed), openConflicts: () => Promise.resolve(observed) };

  const sign = (key, receiptId, requestId, digest, expiresAt) => signCommandApproval({ schema_version: 1,
    receipt_id: receiptId, request_id: requestId, decision: "approve", command_digest: digest,
    signer_principal_id: "principal:owner", authenticated_session_id: "session:owner",
    key_id: "decision-packaged", algorithm: "Ed25519", issued_at: MEMORY_AT, not_before: MEMORY_AT,
    expires_at: expiresAt, nonce: receiptId, max_uses: 1, status: "issued" }, key);

  const approveWorkflow = (db, requestId) => {
    const control = new ControlPlane(db);
    const request = control.stage({ schema_version: 1, request_id: requestId, action: "workflow.start",
      action_level: 2, target: { environment: "local" },
      args: { run_id: `run-${requestId}`, loop_id: "loop-packaged", correlation_id: `corr-${requestId}`,
        input: {}, budget: { max_tokens: 1 } },
      reversible: true, requested_by: "principal:owner", requested_at: shift(-3600000),
      expires_at: shift(7200000), nonce: `nonce-${requestId}` }, new Date(AT));
    control.decide(signCommandApproval({ schema_version: 1, receipt_id: `receipt:${requestId}`,
      request_id: requestId, decision: "approve", command_digest: request.command_digest,
      signer_principal_id: "principal:owner", authenticated_session_id: "session:owner",
      key_id: "decision-packaged", algorithm: "Ed25519", issued_at: AT, not_before: AT,
      expires_at: shift(600000), nonce: `receipt-nonce-${requestId}`, max_uses: 1, status: "issued" },
    decision.privateKey), new Date(AT));
    return request.request_id;
  };

  function provider(directory, contract) {
    chmodSync(PROVIDER_CHILD, 0o755);
    const launcher = join(directory, "second-brain-mcp");
    const config = join(directory, "provider-config.json");
    symlinkSync(PROVIDER_CHILD, launcher);
    writeFileSync(config, JSON.stringify({ adapterScenario: "schema4", contractPath: contract,
      schema4Pages: [{ page_id: PAGE, sensitivity: "personal", updated: "2026-08-28",
        records: [{ sid: SID, text: "ExampleAlpha", valid_from: "2026-08-28T00:00:00.000Z" }] }] }));
    return { launcher, config };
  }

  async function prepare(label, options) {
    const directory = join(scratch.root, label);
    mkdirSync(directory);
    const db = new AuthorityDb(join(directory, "authority.sqlite"));
    try {
      await db.initialize({
        decision: { keyId: "decision-packaged", principal: "principal:owner",
          publicKeyPath: anchor(`${label}-decision`, decision.publicKey) },
        verifier: { keyId: "verifier-packaged", principal: "packaged-verifier",
          publicKeyPath: anchor(`${label}-verifier`, verifier.publicKey) },
      });
      const at = new Date(AT);
      const memoryAt = new Date(MEMORY_AT);
      const roots = memoryCandidateSpoolRoots(db.filename);
      const reviewRoot = roots.candidate_review_spool_root;
      const dispatchRoot = roots.candidate_dispatch_spool_root;

      // A local observation admitted through the product's own collection path, and a verified live
      // Linux fact beside it: an advisory local collection cannot carry a current fact.
      db.db.prepare(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,
        idempotency_key,state,created_at) VALUES('packaged-production',?,'dispatch','{}','sha256:fixture','packaged-production','pending',?)`)
        .run(TASK, shift(-3600000));
      const timeline = new LocalTimelineSnapshotStore(db, () => at);
      timeline.register(TASK);
      admitLocalTimelineObservation(db, TASK, timeline.refresh(TASK).collection_id, () => at);
      const [live] = normalizePersonalObservations({ checked_at: AT, portfolios: [], orca_tasks: [liveTask(label)] });
      assert.ok(live, "live observation required");
      db.persistObservation(live, AT);

      // The owner's decision on one memory, taken through the staging the dashboard uses.
      const candidates = new MemoryCandidateStore(db, policy, () => memoryAt);
      candidates.attachReviewSpool(reviewRoot);
      const candidate = candidates.classify(candidateInput);
      const mutation = new MemoryMutationService({ authority: db, clock: () => memoryAt,
        session: createDashboardSession("owner-session"),
        tokens: new MemoryTokenCache(Buffer.alloc(32, 1), () => memoryAt),
        candidate_review_spool_root: reviewRoot, candidate_dispatch_spool_root: dispatchRoot });
      const staged = mutation.stageCandidateDecision({ candidate_id: candidate.candidate_id,
        operation: "remember", decision: options.ownerDecision, intent_id: `memui:intent:v1:${"1".repeat(64)}` });
      assert.ok(staged, "decision command required");
      const control = new ControlPlane(db);
      control.decide(sign(decision.privateKey, "packaged-confirmation", staged.request_id,
        staged.command_digest, staged.expires_at), memoryAt);

      // Only a confirmed memory is ever written out, so only that one can settle.
      if (options.ownerDecision === "confirm") {
        const dispatch = new MemoryCandidateDispatchSpool(dispatchRoot).read(candidate.candidate_id);
        const actionId = "packaged-outbox-action";
        const action = { schema_version: 1, request_id: actionId, action: "memory.outbox.dispatch",
          action_level: 3, target: { candidate_id: candidate.candidate_id,
            candidate_digest: candidate.candidate_digest, classification_digest: candidate.classification_digest },
          args: { schema_version: 2, dispatch_spool_digest: dispatch.dispatch_spool_digest,
            expected_artifact: { page_id: PAGE, sid: SID, source_digest: ARTIFACT_DIGEST } },
          reversible: false, requested_by: "principal:owner", requested_at: MEMORY_AT,
          expires_at: new Date(memoryAt.getTime() + 900000).toISOString(), nonce: "packaged-outbox-nonce" };
        const command = control.stage(action, memoryAt);
        control.decide(sign(decision.privateKey, "packaged-outbox-approval", actionId,
          command.command_digest, action.expires_at), memoryAt);
        const outbox = new MemoryOutboxService({ authority: db, writer, reader, clock: () => memoryAt,
          artifactDeadlineMs: 30000, leaseMs: 10000,
          candidate_dispatch_spool_root: dispatchRoot, candidate_review_spool_root: reviewRoot });
        const queued = outbox.enqueue(control.claim(actionId, "packaged-worker", memoryAt));
        assert.deepEqual((await outbox.runOnce("packaged-worker", 1)).settled, 1);
        assert.equal(outbox.get(queued.outbox_id).state, "settled");
      }

      // The provider this deployment reads through, and the private projection key the read needs.
      const projectionKey = join(directory, "memory-projection.key");
      writeFileSync(projectionKey, randomBytes(32), { mode: 0o600 });
      chmodSync(projectionKey, 0o600);
      const endpoint = provider(directory, join(root, "dist/contracts/second-brain-mcp-v1.json"));

      // The target identity behind that record, resolved from the provider through the packaged
      // effect service: an artifact resting on a memory has to stay suppressible.
      if (options.ownerDecision === "confirm") {
        const transport = createSecondBrainTransport({ launcherPath: endpoint.launcher, configPath: endpoint.config });
        try {
          const runtime = createProductionMemoryReference(db, { clock: () => new Date(CLI_AT), transport });
          const reference = await runtime.reader.read("What should happen next?",
            { max_records: 8, max_record_bytes: 4096, max_bytes: 32768 });
          const first = reference.payload.records[0];
          assert.ok(first, "provider record required");
          const status = await transport.call("sb_generation_status", { read_fence: null });
          assert.equal(status.kind, "data");
          const effect = new SecondBrainEffectService({ authority: db, transport,
            writer: { write: () => Promise.reject(new Error("probe performs no memory effect write")) },
            clock: () => new Date(CLI_AT), provider_instance_id: String(status.value.provider_instance_id),
            signing_key_id: "memory-effect-packaged", private_key: generateKeyPairSync("ed25519").privateKey });
          const resolved = await effect.resolveTarget({ record_id: first.record.record_id,
            record_digest: first.record.record_digest, generation_id: String(status.value.generation_id),
            generation_manifest_digest: String(status.value.generation_manifest_digest) });
          assert.equal(resolved.kind, "data");
        } finally { await transport.close(); }
      }

      // The workflow the owner started, which is what lets a proposal be made at all.
      if (options.ownerAuthorization) approveWorkflow(db, `req:packaged:workflow:${label}`);

      const counts = table => Number(db.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get());
      assert.equal(counts("personal_recommendations"), 0);
      assert.equal(counts("personal_context_snapshots"), 0);
      assert.equal(counts("personal_observations"), 2);

      const input = join(directory, "daily.json");
      writeFileSync(input, JSON.stringify({ schema_version: 1, time_zone: "Asia/Seoul", lease_ms: 300000,
        deadline_ms: 600000, recovery_window_ms: 600000, recovery_lookback_days: 2,
        refresh_freshness_ms: 600000, budgets: { max_items: 8, max_work: 8, max_bytes: 8192 } }));
      return { path: db.filename, input, endpoint };
    } finally { db.close(); }
  }

  async function run(label, options) {
    const prepared = await prepare(label, options);
    const environment = { ...process.env };
    delete environment.JARVIS_SECOND_BRAIN_LAUNCHER;
    delete environment.JARVIS_SECOND_BRAIN_CONFIG;
    if (options.provider !== false) {
      environment.JARVIS_SECOND_BRAIN_LAUNCHER = prepared.endpoint.launcher;
      environment.JARVIS_SECOND_BRAIN_CONFIG = prepared.endpoint.config;
    }
    // The packaged test entry injects the clock through execute()'s dependencies and reaches the
    // same command the product binary does; the binary itself carries no clock override.
    const result = spawnSync(process.execPath,
      [join(root, "dist/tests/fixtures/compiled-daily-cli.js"), prepared.path, prepared.input, CLI_AT],
      { cwd: root, encoding: "utf8", env: environment });
    const db = new AuthorityDb(prepared.path);
    try {
      const brief = todayProjection(db, new Date(CLI_AT)).brief;
      return { exit_code: result.status, stderr: result.stderr ?? "",
        recommendation_rows: Number(db.db.prepare("SELECT COUNT(*) FROM personal_recommendations").pluck().get()),
        context_rows: Number(db.db.prepare("SELECT COUNT(*) FROM personal_context_snapshots").pluck().get()),
        brief_state: brief.state, brief_items: brief.item_count };
    } finally { db.close(); }
  }

  const produced = await run("produced", { ownerDecision: "confirm", ownerAuthorization: true });
  assert.equal(produced.stderr, "");
  assert.equal(produced.exit_code, 0);
  assert.equal(produced.recommendation_rows, 1);
  assert.equal(produced.brief_items, 1);

  const unauthorized = await run("unauthorized", { ownerDecision: "confirm", ownerAuthorization: false });
  assert.equal(unauthorized.exit_code, 0);
  assert.equal(unauthorized.recommendation_rows, 0);
  assert.equal(unauthorized.brief_items, 0);

  const unconfirmed = await run("unconfirmed", { ownerDecision: "reject", ownerAuthorization: true });
  assert.equal(unconfirmed.exit_code, 0);
  assert.equal(unconfirmed.recommendation_rows, 0);
  assert.equal(unconfirmed.brief_items, 0);

  const providerless = await run("providerless", { ownerDecision: "confirm", ownerAuthorization: true, provider: false });
  assert.equal(providerless.stderr, "");
  assert.equal(providerless.exit_code, 0);
  assert.equal(providerless.recommendation_rows, 0);

  const result = {
    scope: "packaged runtime: local + live observation -> owner-confirmed memory -> provider read through the reference seam -> context -> recommendation -> morning brief, through the packaged daily command",
    package_root: root, source: receipt.source,
    runtime: { node: process.version, better_sqlite3_resolved_from: sqlite,
      harness: "scripts/packaged-production-chain-probe.mjs from the development checkout; every product module loaded from the package" },
    real: ["local timeline observation admitted through the product collection path",
      "live Linux observation normalised and persisted through the product producer",
      "memory classified, confirmed by an owner-signed receipt through the control plane, written and settled through the outbox saga",
      "memory read back from a real stdio provider child and admitted only through the reference seam",
      "provider target identity resolved through the packaged effect service",
      "owner workflow authorization staged and decided through the control plane",
      "production and publication run by the packaged daily morning command as a child process"],
    isolated_fixture: ["decision and verifier anchors generated for this run",
      "a provider child from the development checkout serving one page, stating no trust and no evidence kind",
      "the provider's write acceptance and artifact observation for the one settled write",
      "fixed instant 2026-08-28T22:15:00.000Z injected through the packaged test entry"],
    not_exercised: ["no operator key", "no Second Brain release process", "no native model call"],
    produced, unauthorized, unconfirmed, providerless, deployment_ready: false,
  };
  if (process.argv[3]) writeFileSync(process.argv[3], `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally { scratch.cleanup(); }
