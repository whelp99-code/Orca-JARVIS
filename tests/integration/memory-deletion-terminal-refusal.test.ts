import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ApprovedCommandExecutor } from "../../src/approved-executor.js";
import { AuthorityDatabaseRuntime } from "../../src/authority-database-runtime.js";
import { canonicalize } from "../../src/canonical.js";
import { ControlPlane, signCommandApproval, type CommandApprovalReceipt, type ControlCommandRequestInput } from "../../src/control-plane.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import { registerMemoryEffectDelegationKey, registerMemoryProviderProofKey } from "../../src/memory-effect-delegation.js";
import { createProductionMemoryLifecycleService } from "../../src/memory-lifecycle-service.js";
import { memoryRememberArtifact } from "../../src/memory-remember-artifact.js";
import { MemoryOutboxService } from "../../src/memory-outbox.js";
import { createSecondBrainReadAdapter } from "../../src/second-brain-adapter.js";
import { createSecondBrainTransport } from "../../src/second-brain-transport.js";
import { SecondBrainEffectService } from "../../src/second-brain-effect-service.js";
import { createSecondBrainWriteRequestAdapter } from "../../src/second-brain-write-adapter.js";
import type { SecondBrainWriteRequestV1 } from "../../src/second-brain-adapter-types.js";
import { closeMemoryDatabase, insertMemoryVerification, memoryDatabase, memoryVerificationPayload } from "../fixtures/memory-candidate-store.js";
import { memoryPolicy, verifiedMemoryInput } from "../fixtures/memory-candidate-fixture.js";
import { withProvableExclusion } from "../fixtures/provable-exclusion.js";
import { TASK30_PROVIDER_SHA, task30Python, task30Sqlite, task30Wheel } from "../fixtures/task30-provider-runtime.js";
import { localKey } from "../helpers.js";

const PROVIDER_ID = "provider:task30:deletion-refusal";
const JARVIS_KEY_ID = "jarvis:task30:deletion-refusal";
const PROVIDER_KEY_ID = "provider:task30:deletion-refusal";

function key(seed: number) {
  return createPrivateKey({ key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(Array.from({ length: 32 }, (_, index) => seed + index)),
  ]), format: "der", type: "pkcs8" });
}
function hash(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(domain).update(canonicalize(value)).digest("hex")}`;
}
describe("real-provider deletion terminal refusal", () => {
  it("ends a deletion the provider refused after one frame, including after restart", async () => {
    const wheel = process.env["TASK30_PROVIDER_WHEEL"] ?? task30Wheel();
    const python = process.env["TASK30_PROVIDER_PYTHON"] ?? task30Python();
    const providerSha = process.env["TASK30_PROVIDER_SHA"] ?? TASK30_PROVIDER_SHA;
    const sqliteCli = task30Sqlite();
    expect(existsSync(wheel)).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "task30-deletion-refusal-"));
    const site = join(root, "site");
    const providerRoot = join(root, "provider");
    mkdirSync(site, { mode: 0o700 });
    mkdirSync(providerRoot, { mode: 0o700 });
    mkdirSync(join(root, "bin"), { mode: 0o700 });
    cpSync(sqliteCli, join(root, "bin", "sqlite3"));
    chmodSync(join(root, "bin", "sqlite3"), 0o700);
    execFileSync(python, ["-m", "zipfile", "-e", wheel, site], { cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" } });
    const jarvisKey = key(4);
    const jarvisPublic = createPublicKey(jarvisKey).export({ format: "jwk" }).x;
    if (jarvisPublic === undefined) throw new Error("TASK30_JARVIS_KEY_INVALID");
    const config = join(root, "provider.toml");
    const providerSeed = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 64)).toString("base64url");
    writeFileSync(config, [
      `vault_root = "${join(providerRoot, "share", "vault")}"`,
      `request_root = "${join(providerRoot, "requests")}"`,
      `export_root = "${join(providerRoot, "exports")}"`,
      `state_root = "${join(providerRoot, "state")}"`,
      `share_root = "${join(providerRoot, "share")}"`,
      `backup_root = "${join(providerRoot, "backups")}"`,
      `provider_instance_id = "${PROVIDER_ID}"`,
      `provider_release_sha = "${providerSha}"`,
      `provider_signing_key_id = "${PROVIDER_KEY_ID}"`,
      `provider_private_key = "${providerSeed}"`,
      `jarvis_signing_key_id = "${JARVIS_KEY_ID}"`,
      `jarvis_public_key = "${jarvisPublic}"`,
      "",
    ].join("\n"), { mode: 0o600 });
    const launcher = join(root, "second-brain-mcp");
    writeFileSync(launcher, `#!/bin/sh\nexport HOME='${root}' PATH='${root}/bin:/usr/bin:/bin'\nexport XDG_CONFIG_HOME='${root}/config' XDG_DATA_HOME='${root}/data' XDG_STATE_HOME='${root}/state'\nexport PYTHONPATH='${site}'\nexec '${python.replaceAll("'", "'\\''")}' -m sb.mcp\n`, { mode: 0o700 });
    const database = await memoryDatabase();
    const authority = database.authority;
    let clockValue = new Date();
    const clock = () => clockValue;
    const transport = createSecondBrainTransport({ launcherPath: launcher, configPath: config,
      contractPath: "contracts/second-brain-mcp-v1.json" });
    let closeLifecycle: (() => Promise<void>) | undefined;
    try {
      registerMemoryEffectDelegationKey(authority, { key_id: JARVIS_KEY_ID, principal_id: "principal:owner",
        public_key_pem: createPublicKey(jarvisKey).export({ format: "pem", type: "spki" }).toString(),
        valid_from: "2026-01-01T00:00:00.000Z", valid_until: "2027-01-01T00:00:00.000Z" }, clockValue);
      registerMemoryProviderProofKey(authority, { key_id: PROVIDER_KEY_ID, provider_instance_id: PROVIDER_ID,
        provider_release_sha: providerSha,
        public_key_pem: createPublicKey(key(64)).export({ format: "pem", type: "spki" }).toString(),
        valid_from: "2026-01-01T00:00:00.000Z", valid_until: "2027-01-01T00:00:00.000Z" }, clockValue);
      const writer = createSecondBrainWriteRequestAdapter(transport, authority, clock);
      const provider = new SecondBrainEffectService({ authority, transport, writer, clock,
        provider_instance_id: PROVIDER_ID, signing_key_id: JARVIS_KEY_ID, private_key: jarvisKey,
        nonce: () => `refusal-${randomBytes(8).toString("hex")}` });
      const reader = createSecondBrainReadAdapter({ transport, contract_profile: "schema4",
        budgets: { max_hits: 16, max_excerpt_bytes: 4_096, max_total_bytes: 65_536, max_page_bytes: 1_048_576 },
        clock, max_age_ms: 86_400_000, expiry_ms: 2 * 86_400_000, read_fence: provider.readFenceFactory() });
      const layout = { spool_root: join(root, "spool"), state_root: join(root, "state"),
        dist_root: join(root, "dist"), backup_root: join(root, "backups"), restore_root: join(root, "restore") };
      for (const path of Object.values(layout)) mkdirSync(path, { recursive: true, mode: 0o700 });
      const runtime = new AuthorityDatabaseRuntime(authority, { registry_root: join(root, "runtime"), watchdog_ms: 10_000 });
      withProvableExclusion(runtime);
      const lifecycle = createProductionMemoryLifecycleService(runtime, {
        provider_instance_id: PROVIDER_ID, launcher_path: launcher, provider_config_path: config,
        contract_path: resolve("contracts/second-brain-mcp-v1.json"), signing_key_id: JARVIS_KEY_ID,
        private_key: jarvisKey, subject_key: Buffer.alloc(32, 13), layout, clock,
      });
      closeLifecycle = () => lifecycle.close();
      const control = new ControlPlane(authority);
      const approve = (input: ControlCommandRequestInput): void => {
        const staged = control.stage(input, clockValue);
        const receipt: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1,
          receipt_id: `approval:${input.request_id}`, request_id: input.request_id, decision: "approve",
          command_digest: staged.command_digest, signer_principal_id: "principal:owner",
          authenticated_session_id: "task30-deletion-refusal", key_id: "decision-test", algorithm: "Ed25519",
          issued_at: clockValue.toISOString(), not_before: clockValue.toISOString(), expires_at: input.expires_at,
          nonce: `approval:${randomBytes(8).toString("hex")}`, max_uses: 1, status: "issued" };
        control.decide(signCommandApproval(receipt, localKey(authority)), clockValue);
      };
      const statement = `remembered-${randomBytes(12).toString("hex")}`;
      const candidate = verifiedMemoryInput({ authority_id: `remember-${randomBytes(4).toString("hex")}`,
        idempotency_key: `task30:${randomBytes(4).toString("hex")}`, operation: "remember",
        subject: "Task 30 runtime memory", statement });
      const expires = new Date(clockValue.getTime() + 10 * 60_000).toISOString();
      insertMemoryVerification(authority, memoryVerificationPayload(candidate, {
        issued_at: clockValue.toISOString(), not_before: clockValue.toISOString(), expires_at: expires,
        nonce: `verification-${randomBytes(4).toString("hex")}`,
      }));
      const remembered = new MemoryCandidateStore(authority, memoryPolicy(), clock).classify(candidate);
      const createdAt = clockValue.toISOString();
      const receipt = { schema_version: 1 as const, receipt_id: `receipt:memory:${randomBytes(32).toString("hex")}`,
        candidate_id: remembered.candidate_id, candidate_digest: remembered.candidate_digest,
        classification_digest: remembered.classification_digest, operation: remembered.operation,
        decision: "auto_staged", principal_id: "principal:owner", issued_at: createdAt, expires_at: expires };
      const identity = { candidate_id: remembered.candidate_id, candidate_digest: remembered.candidate_digest,
        classification_digest: remembered.classification_digest, operation: remembered.operation };
      const idem = hash("orca-jarvis/memory-write-idempotency/v1\0", identity);
      const base = { schema_version: 1 as const, ...identity, idempotency_key: `memidem:pos:v1:${idem.slice(7)}`,
        subject: "Task 30 runtime memory", purpose: "personal_memory" as const,
        sensitivity: remembered.policy_sensitivity, retention_days: remembered.retention_days,
        created_at: createdAt, expires_at: expires, expected_prior: null, receipt,
        receipt_digest: hash("orca-jarvis/memory-write-receipt/v1\0", receipt), payload: { content: statement } };
      const requestDigest = hash("orca-jarvis/memory-write-request/v1\0", base);
      const rememberRequest: SecondBrainWriteRequestV1 = { ...base,
        request_id: `memreq:pos:v1:${requestDigest.slice(7)}`, request_digest: requestDigest };
      const artifact = memoryRememberArtifact(rememberRequest).artifact;
      const rememberAction: ControlCommandRequestInput = { schema_version: 1,
        request_id: `control:remember:${randomBytes(6).toString("hex")}`, action: "memory.outbox.dispatch",
        action_level: 3, target: { candidate_id: remembered.candidate_id,
          candidate_digest: remembered.candidate_digest, classification_digest: remembered.classification_digest },
        args: { schema_version: 2, request: rememberRequest, expected_artifact: artifact }, reversible: false,
        requested_by: "principal:owner", requested_at: createdAt,
        expires_at: new Date(clockValue.getTime() + 12 * 60_000).toISOString(),
        nonce: `remember:${randomBytes(6).toString("hex")}` };
      approve(rememberAction);
      const claimedRemember = control.claim(rememberAction.request_id, "task30-remember", clockValue);
      const outbox = new MemoryOutboxService({ authority, writer, reader, clock, artifactDeadlineMs: 30_000, leaseMs: 10_000 });
      outbox.enqueue(claimedRemember);
      expect((await outbox.runOnce("task30-remember", 1)).dispatched).toBe(1);
      const appliedRemember = execFileSync(python, ["-m", "sb.cli", "apply-requests", "--once"], {
        cwd: root, encoding: "utf8", timeout: 120_000,
        env: { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
          XDG_STATE_HOME: join(root, "state"), PATH: `${root}/bin:/usr/bin:/bin`, PYTHONPATH: site, SB_CONFIG: config },
      });
      expect(JSON.parse(appliedRemember)).toMatchObject({ state: "proved" });
      clockValue = new Date();
      await transport.restart();
      expect((await outbox.runOnce("task30-remember-reconcile", 1)).settled).toBe(1);
      const page = await reader.readPage(artifact.page_id);
      const binding = page.kind === "current" || page.kind === "stale"
        ? page.evidence.find(item => item.sid === artifact.sid)?.record : undefined;
      if (binding === undefined || binding === null) throw new Error("TASK30_RECORD_BINDING_MISSING");
      const resolved = await provider.resolveTarget({ record_id: binding.record_id,
        record_digest: binding.record_digest, generation_id: binding.generation.generation_id,
        generation_manifest_digest: binding.generation.generation_manifest_digest });
      if (resolved.kind !== "data") throw new Error(resolved.code);
      const target = resolved.value;
      const deletionId = `memdel:v1:${randomBytes(8).toString("hex")}`;
      const deletionAction = await lifecycle.prepareDeletion({ deletion_id: deletionId,
        correlation_id: `corr:${randomBytes(6).toString("hex")}`, provider_instance_id: PROVIDER_ID,
        targets: [target], scope: { format: "none", sensitivity_classes: [target.sensitivity],
          valid_from: target.valid_from, valid_until: target.valid_until, max_records: 1, max_bytes: 4_096,
          source_owner_classes: [target.source_owner_class] },
        erasure_claim: "managed_erasure", external_receipts: [], requested_at: clockValue,
        expires_at: new Date(clockValue.getTime() + 10 * 60_000),
        nonce: `deletion:${randomBytes(6).toString("hex")}` });
      approve(deletionAction);
      const executor = new ApprovedCommandExecutor(authority, layout.backup_root, layout.state_root, {},
        clock, undefined, provider, lifecycle);
      await executor.execute(deletionAction.request_id, "task30-deletion-refusal", clockValue);
      expect(authority.db.prepare("SELECT COUNT(*) AS count FROM memory_deletion_attempts WHERE deletion_id=?")
        .get(deletionId)).toEqual({ count: 1 });
      // The provider journalled the accepted frame, then refused it before apply. Mutating the
      // sealed generation is split-brain and a later CLI remember is TOMBSTONE_SET_STALE (B3b),
      // so the refusal is the same failed/claimed journal state the provider writes, observed
      // through the real status call.
      const providerJournal = new Database(join(providerRoot, "requests", "journal.db"));
      expect(providerJournal.prepare("UPDATE requests SET state='failed', phase='claimed' WHERE operation='forget'").run().changes).toBe(1);
      providerJournal.close();
      clockValue = new Date();
      await lifecycle.reconcilePending(10);
      expect(authority.db.prepare("SELECT state,failure_code FROM memory_deletion_effect_requests WHERE deletion_id=?")
        .get(deletionId)).toEqual({ state: "conflict", failure_code: "MEMORY_PROVIDER_FAILED" });
      expect(authority.db.prepare("SELECT state,failure_code FROM control_command_requests WHERE request_id=?")
        .get(deletionAction.request_id)).toEqual({ state: "failed", failure_code: "MEMORY_PROVIDER_FAILED" });
      const journal = new Database(join(providerRoot, "requests", "journal.db"), { readonly: true });
      const beforeRestart = journal.prepare("SELECT operation,state,phase FROM requests ORDER BY accepted_at").all();
      journal.close();
      await lifecycle.reconcilePending(10);
      expect(authority.db.prepare("SELECT state FROM memory_deletion_effect_requests WHERE deletion_id=?")
        .get(deletionId)).toEqual({ state: "conflict" });
      expect(authority.db.prepare(
        "SELECT COUNT(*) AS count FROM control_command_effects WHERE request_id=? AND effect_type='memory.deletion.refused'",
      ).get(deletionAction.request_id)).toEqual({ count: 1 });
      expect(authority.db.prepare("SELECT COUNT(*) AS count FROM memory_deletion_attempts WHERE deletion_id=?")
        .get(deletionId)).toEqual({ count: 1 });
      const after = new Database(join(providerRoot, "requests", "journal.db"), { readonly: true });
      try {
        expect(after.prepare("SELECT operation,state,phase FROM requests ORDER BY accepted_at").all())
          .toEqual(beforeRestart);
      } finally { after.close(); }
    } finally {
      await transport.close();
      if (closeLifecycle !== undefined) await closeLifecycle();
      if (authority.db.open) closeMemoryDatabase(database);
      execFileSync("chmod", ["-R", "u+w", root]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
