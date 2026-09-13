// Usage: node scripts/packaged-production-chain-probe.mjs PACKAGE_ROOT [RECEIPT_PATH]
// Runs the observation -> context -> recommendation -> brief chain inside the supplied package.
// Every product module is loaded from the package; nothing resolves into the development checkout.
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestEnvironment } from "./lib/test-environment.mjs";

assert.ok(process.argv[2], "PACKAGE_ROOT required");
const root = resolve(process.argv[2]);
const receipt = JSON.parse(readFileSync(join(root, "runtime-package-receipt.json"), "utf8"));
const load = name => import(pathToFileURL(join(root, "dist/src", name)).href);

const AT = "2026-08-28T12:00:00.000Z";
const OBSERVED = "2026-08-28T11:59:00.000Z";
const CONTEXT_EXPIRES_MS = 240000;
const RECOMMENDATION_EXPIRES = "2026-08-28T12:03:00.000Z";
const PRINCIPLE = "memory:principle:packaged";
const MEMORY_TARGET = `sha256:${"d".repeat(64)}`;
const shift = ms => new Date(Date.parse(AT) + ms).toISOString();

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
  const { produceDailyRecommendation } = await load("personal-context-production.js");
  const { projectRecommendations } = await load("recommendation-projection.js");
  const { MorningRecommendationSource } = await load("morning-recommendation-source.js");
  const { MemoryProjectionAuthority } = await load("memory-projection-authority.js");
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
      task: { task_id: "task:packaged", title: "not persisted", kind: "work", state: "running",
        updated_at: OBSERVED, pending_approval: false, source_ids: ["source-packaged"] },
      events: [{ event_id: `evidence-packaged-${suffix}`, task_id: "task:packaged", source: "verification",
        kind: "evidence", actor: "verifier", title: "not persisted", status: "recorded",
        payload: { fact: "not persisted" }, evidence_refs: [`verify-packaged-${suffix}`],
        created_at: OBSERVED, sequence: 1 }],
      pending_decisions: [], workers: [], evidence: [], truncated: false },
  });

  // An isolated Second Brain principle. The provider's own read contract carries trust "untrusted",
  // so a confirmed principle cannot come from a read; this one is supplied as fixture input and is
  // recorded as such rather than presented as provider evidence.
  const memory = { kind: "evidence", memory_ref: PRINCIPLE, source_id: "src:pos:v1:second-brain:primary",
    digest: `sha256:${"a".repeat(64)}`, observed_at: "2026-08-28T11:30:00.000Z",
    fresh_until: "2026-08-28T12:05:00.000Z", excerpt: "Prioritize confirmed customer obligations.",
    trust: "user_confirmed", sensitivity: "personal", relevance: "related", relation: "supports" };

  const approve = (db, key, requestId) => {
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
    key), new Date(AT));
    return request.request_id;
  };

  async function run(label, withOwnerApproval) {
    const db = new AuthorityDb(join(scratch.root, `${label}.sqlite`));
    try {
      await db.initialize({
        decision: { keyId: "decision-packaged", principal: "principal:owner",
          publicKeyPath: anchor(`${label}-decision`, decision.publicKey) },
        verifier: { keyId: "verifier-packaged", principal: "packaged-verifier",
          publicKeyPath: anchor(`${label}-verifier`, verifier.publicKey) },
      });
      const [observation] = normalizePersonalObservations({ checked_at: AT,
        orca_tasks: [liveTask(label)], portfolios: [] });
      db.persistObservation(observation, AT);
      const gate = approve(db, decision.privateKey, `req:packaged:gate:${label}`);
      const importDecision = withOwnerApproval
        ? approve(db, decision.privateKey, `req:packaged:import:${label}`)
        : `req:packaged:import:${label}:never-approved`;
      const produced = produceDailyRecommendation(db, {
        assemble: { purpose: "daily_prioritization", query: "What should happen next?", clock: AT,
          expires_in_ms: CONTEXT_EXPIRES_MS,
          budgets: { max_items: 16, max_excerpt_bytes: 512, max_total_bytes: 8192 },
          observations: [observation], pending_authority_refs: [], memories: [memory] },
        policy, policy_decision_ref: "policy:linux:personal-os-policy-v1:packaged",
        principle_ref: PRINCIPLE, owner_import_decision_ref: importDecision,
        candidates: [{ action_id: "packaged-followup", execution_mode: "jarvis",
          owner_safety_gate: "owner_approval_required", owner_gate_ref: gate,
          customer_impact: "customer_critical", deadline: null, dependency: { kind: "non_blocking" },
          irreversible_risk: "low", effort_cost: "medium", principle_ref: PRINCIPLE,
          current_evidence_ref: observation.id,
          stable_identity: { key: "packaged-followup", evidence_ref: observation.id } }],
        recommendation: { id: "rec:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7f01",
          idempotency_key: `idem:pos:v1:recommendation:${createHash("sha256").update(label).digest("hex")}`,
          correlation_id: "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", causation_id: null,
          expires_at: RECOMMENDATION_EXPIRES, confidence_class: "high",
          actions: [{ action_id: "packaged-followup", title: "Next: packaged-followup",
            operation: "review", target_digest: `sha256:${"b".repeat(64)}` }] },
      });
      const rows = Number(db.db.prepare("SELECT COUNT(*) FROM personal_recommendations").pluck().get());
      if (produced.state === "recommended") {
        new MemoryProjectionAuthority(db).bind({ kind: "context", id: produced.context.id,
          component_id: produced.context.id }, [{ target_digest: MEMORY_TARGET }], new Date(AT));
      }
      const brief = new MorningRecommendationSource(db).generate(AT);
      return { state: produced.state, context_id: produced.context.id,
        observation_id: observation.id, recommendation_rows: rows,
        next_actions: projectRecommendations(db, AT).next_actions.map(item => item.title),
        brief_items: brief.source.input.items.length,
        brief_abstentions: brief.brief.abstention_reasons,
        reasons: produced.state === "abstained" ? produced.reasons : null };
    } finally { db.close(); }
  }

  const approved = await run("approved", true);
  assert.equal(approved.state, "recommended");
  assert.equal(approved.recommendation_rows, 1);
  assert.deepEqual(approved.next_actions, ["Next: packaged-followup"]);
  assert.equal(approved.brief_items, 1);

  const withheld = await run("withheld", false);
  assert.equal(withheld.state, "abstained");
  assert.equal(withheld.recommendation_rows, 0);
  assert.deepEqual(withheld.next_actions, []);

  const result = {
    scope: "packaged runtime: live observation -> assembled context -> recommendation -> morning brief",
    package_root: root, source: receipt.source,
    runtime: { node: process.version, better_sqlite3_resolved_from: sqlite,
      harness: "scripts/packaged-production-chain-probe.mjs from the development checkout; every product module loaded from the package" },
    real: ["live Linux observation normalised and persisted through the product producer",
      "owner approvals staged and decided through the control plane",
      "context assembled and persisted, recommendation created, brief generated"],
    isolated_fixture: ["decision and verifier anchors generated for this run",
      "one Second Brain principle supplied as memory evidence input",
      "fixed clock 2026-08-28T12:00:00.000Z"],
    not_exercised: ["no operator key", "no real Second Brain provider process", "no native model call"],
    approved, withheld, deployment_ready: false,
  };
  if (process.argv[3]) writeFileSync(process.argv[3], `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally { scratch.cleanup(); }
