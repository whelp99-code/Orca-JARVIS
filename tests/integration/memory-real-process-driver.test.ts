// allow: SIZE_OK — one indivisible real-process lifecycle: four proved effects, then the organic stale correction that requires that settled provider.
import { withProvableExclusion } from "../fixtures/provable-exclusion.js";
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { ApprovedCommandExecutor } from "../../src/approved-executor.js";
import { ControlPlane, signCommandApproval, type CommandApprovalReceipt,
  type ControlCommandRequestInput } from "../../src/control-plane.js";
import { AuthorityDatabaseRuntime } from "../../src/authority-database-runtime.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import { registerMemoryEffectDelegationKey,
  registerMemoryProviderProofKey } from "../../src/memory-effect-delegation.js";
import { createProductionMemoryLifecycleService } from "../../src/memory-lifecycle-service.js";
import { memoryRememberArtifact } from "../../src/memory-remember-artifact.js";
import { MemoryOutboxService } from "../../src/memory-outbox.js";
import { memoryOutboxHash } from "../../src/memory-outbox-values.js";
import { sanitizeMemoryRestoreCandidate } from "../../src/memory-restore-high-water.js";
import { createSecondBrainReadAdapter } from "../../src/second-brain-adapter.js";
import type { SecondBrainTransport } from "../../src/second-brain-transport.js";
import { createSecondBrainTransport } from "../../src/second-brain-transport.js";
import { SecondBrainEffectService } from "../../src/second-brain-effect-service.js";
import { createSecondBrainWriteRequestAdapter } from "../../src/second-brain-write-adapter.js";
import type { MemoryEffectScopeV2, ResolvedMemoryTargetV2 } from "../../src/second-brain-effect-v2.js";
import type { SecondBrainWriteRequestV1 } from "../../src/second-brain-adapter-types.js";
import { closeMemoryDatabase, insertMemoryVerification, memoryDatabase,
  memoryVerificationPayload } from "../fixtures/memory-candidate-store.js";
import { memoryPolicy, verifiedMemoryInput } from "../fixtures/memory-candidate-fixture.js";
import { localKey } from "../helpers.js";

// This cross-process gate consumes explicitly injected build artifacts, never a host installation.
import { TASK30_PROVIDER_SHA, task30Python, task30Sqlite, task30Wheel } from "../fixtures/task30-provider-runtime.js";

const PROVIDER_SHA = process.env["TASK30_PROVIDER_SHA"] ?? TASK30_PROVIDER_SHA;
const PROVIDER_WHEEL = process.env["TASK30_PROVIDER_WHEEL"] ?? task30Wheel();
const PYTHON = process.env["TASK30_PROVIDER_PYTHON"] ?? task30Python();
const CONTRACT = "contracts/second-brain-mcp-v1.json";
const JARVIS_KEY_ID = "jarvis:task30:real-process";
const PROVIDER_KEY_ID = "provider:task30:real-process";
const PROVIDER_ID = "provider:task30:real-process";

function key(seed: number) {
  return createPrivateKey({ key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(Array.from({ length: 32 }, (_, index) => seed + index)),
  ]), format: "der", type: "pkcs8" });
}
function hash(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(domain).update(canonicalize(value)).digest("hex")}`;
}
function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new Error(code);
  return value;
}
function scope(target: ResolvedMemoryTargetV2, format: "none" | "json"): MemoryEffectScopeV2 {
  return { format, sensitivity_classes: [target.sensitivity], valid_from: target.valid_from,
    valid_until: target.valid_until, max_records: 1, max_bytes: 4_096,
    source_owner_classes: [target.source_owner_class] };
}
function writableRemove(root: string): void {
  if (!existsSync(root)) return;
  execFileSync("chmod", ["-R", "u+w", root]);
  rmSync(root, { recursive: true, force: true });
}
function regularFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  if (statSync(root).isFile()) return [root];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...regularFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
function expectAbsent(root: string, needles: readonly Buffer[]): void {
  for (const path of regularFiles(root)) {
    const body = readFileSync(path);
    expect(needles.some(needle => body.includes(needle)), path).toBe(false);
  }
}
function providerApply(root: string, config: string, site: string): Readonly<Record<string, unknown>> {
  const output = execFileSync(required(PYTHON, "TASK30_PROVIDER_PYTHON_REQUIRED"), ["-m", "sb.cli", "apply-requests", "--once"], {
    cwd: root, encoding: "utf8", timeout: 120_000,
    env: { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"), PATH: `${root}/bin:/usr/bin:/bin`, PYTHONPATH: site, SB_CONFIG: config },
  });
  const value: unknown = JSON.parse(output);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("TASK30_PROVIDER_RESULT_INVALID");
  }
  return value as Readonly<Record<string, unknown>>;
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function providerHighWater(providerRoot: string): { readonly replica: unknown; readonly rows: unknown } {
  const journal = new Database(join(providerRoot, "requests", "journal.db"), { readonly: true });
  try {
    return {
      replica: journal.prepare("SELECT sequence, set_root FROM tombstone_replica ORDER BY sequence DESC LIMIT 1").get(),
      rows: journal.prepare("SELECT operation, state, phase, fence FROM requests ORDER BY accepted_at").all(),
    };
  } finally { journal.close(); }
}

describe("Task 30 real built-process lifecycle", () => {
  it("settles four proved effects, then ends an organic stale correction as conflict", async () => {
    const wheel = required(PROVIDER_WHEEL, "TASK30_PROVIDER_WHEEL_REQUIRED");
    const python = required(PYTHON, "TASK30_PROVIDER_PYTHON_REQUIRED");
    const providerSha = required(PROVIDER_SHA, "TASK30_PROVIDER_SHA_REQUIRED");
    const sqliteCli = task30Sqlite();
    expect(existsSync(wheel), "provider writer must run uv build before this gate").toBe(true);
    expect(providerSha).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(python), "inject an isolated Python runtime").toBe(true);
    expect(existsSync(sqliteCli), "inject the SQLite executable fixture").toBe(true);
    const root = mkdtempSync(join(tmpdir(), "task30-real-process-"));
    const site = join(root, "site");
    const providerRoot = join(root, "provider");
    const spoolRoot = join(root, "jarvis-spool");
    const restoreRoot = join(root, "restore");
    mkdirSync(site, { mode: 0o700 });
    mkdirSync(providerRoot, { mode: 0o700 });
    mkdirSync(join(root, "bin"), { mode: 0o700 });
    cpSync(sqliteCli, join(root, "bin", "sqlite3"));
    chmodSync(join(root, "bin", "sqlite3"), 0o700);
    execFileSync(python, ["-m", "zipfile", "-e", wheel, site], {
      cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" },
    });
    const jarvisKey = key(0); const providerKey = key(32);
    const jarvisPublic = createPublicKey(jarvisKey).export({ format: "jwk" }).x;
    if (jarvisPublic === undefined) throw new Error("TASK30_JARVIS_KEY_INVALID");
    const config = join(root, "provider.toml");
    const providerSeed = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 32)).toString("base64url");
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
    chmodSync(config, 0o600);
    const launcher = join(root, "second-brain-mcp");
    writeFileSync(launcher, `#!/bin/sh\nexport HOME='${root}' PATH='${root}/bin:/usr/bin:/bin'\nexport XDG_CONFIG_HOME='${root}/config' XDG_DATA_HOME='${root}/data' XDG_STATE_HOME='${root}/state'\nexport PYTHONPATH='${site}'\nexec '${python.replaceAll("'", "'\\''")}' -m sb.mcp\n`, { mode: 0o700 });
    chmodSync(launcher, 0o700);

    const database = await memoryDatabase();
    const authority = database.authority;
    const old = `old-${randomBytes(24).toString("hex")}`;
    const corrected = `corrected-${randomBytes(24).toString("hex")}`;
    const oldNeedle = Buffer.from(old); const correctedNeedle = Buffer.from(corrected);
    let clockValue = new Date();
    const clock = () => clockValue;
    let writeFrames = 0;
    const rawTransport = createSecondBrainTransport({ launcherPath: launcher,
      configPath: config, contractPath: CONTRACT });
    const transport: SecondBrainTransport = {
      call(method, arguments_, options) {
        if (method === "sb_write_request") writeFrames += 1;
        return rawTransport.call(method, arguments_, options);
      },
      restart: () => rawTransport.restart(), close: () => rawTransport.close(),
      diagnostics: () => rawTransport.diagnostics(),
    };
    let authorityClosed = false;
    let closeLifecycle: (() => Promise<void>) | undefined;
    try {
      registerMemoryEffectDelegationKey(authority, { key_id: JARVIS_KEY_ID,
        principal_id: "principal:owner",
        public_key_pem: createPublicKey(jarvisKey).export({ format: "pem", type: "spki" }).toString(),
        valid_from: "2026-01-01T00:00:00.000Z", valid_until: "2027-01-01T00:00:00.000Z" }, clockValue);
      registerMemoryProviderProofKey(authority, { key_id: PROVIDER_KEY_ID,
        provider_instance_id: PROVIDER_ID, provider_release_sha: providerSha,
        public_key_pem: createPublicKey(providerKey).export({ format: "pem", type: "spki" }).toString(),
        valid_from: "2026-01-01T00:00:00.000Z", valid_until: "2027-01-01T00:00:00.000Z" }, clockValue);
      const writer = createSecondBrainWriteRequestAdapter(transport, authority, clock);
      const provider = new SecondBrainEffectService({ authority, transport, writer, clock,
        provider_instance_id: PROVIDER_ID, signing_key_id: JARVIS_KEY_ID,
        private_key: jarvisKey, nonce: () => `task30-${randomBytes(8).toString("hex")}` });
      const reader = createSecondBrainReadAdapter({ transport, contract_profile: "schema4",
        budgets: { max_hits: 16, max_excerpt_bytes: 4_096,
          max_total_bytes: 65_536, max_page_bytes: 1_048_576 },
        clock, max_age_ms: 86_400_000, expiry_ms: 2 * 86_400_000,
        read_fence: provider.readFenceFactory() });
      const resolveBoundTarget = async (targetPageId: string, targetSid: string) => {
        const page = await reader.readPage(targetPageId);
        const binding = (page.kind === "current" || page.kind === "stale")
          ? page.evidence.find(item => item.sid === targetSid)?.record : undefined;
        if (binding === undefined || binding === null) throw new Error("TASK32_RECORD_BINDING_MISSING");
        const result = await provider.resolveTarget({ record_id: binding.record_id,
          record_digest: binding.record_digest, generation_id: binding.generation.generation_id,
          generation_manifest_digest: binding.generation.generation_manifest_digest });
        if (result.kind !== "data") throw new Error(result.code);
        return result.value;
      };
      const lifecycleLayout = { spool_root: spoolRoot,
        state_root: join(root, "jarvis-state"), dist_root: join(root, "jarvis-release", "dist"),
        backup_root: join(root, "jarvis-backups"),
        restore_root: join(root, "jarvis-restore-candidates") };
      for (const path of Object.values(lifecycleLayout)) {
        mkdirSync(path, { recursive: true, mode: 0o700 });
      }
      const databaseRuntime = new AuthorityDatabaseRuntime(authority,
        { registry_root: join(root, "jarvis-runtime"), watchdog_ms: 10_000 });
      // Declared, not assumed: this case needs an environment where exclusion is provable.
      withProvableExclusion(databaseRuntime);
      const lifecycle = createProductionMemoryLifecycleService(databaseRuntime, {
        provider_instance_id: PROVIDER_ID, launcher_path: launcher,
        provider_config_path: config, contract_path: resolve(CONTRACT),
        signing_key_id: JARVIS_KEY_ID, private_key: jarvisKey,
        subject_key: Buffer.alloc(32, 11), layout: lifecycleLayout, clock,
      });
      closeLifecycle = () => lifecycle.close();
      const control = new ControlPlane(authority);
      const approve = (input: ControlCommandRequestInput): void => {
        const staged = control.stage(input, clockValue);
        const receipt: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1,
          receipt_id: `approval:${input.request_id}`, request_id: input.request_id,
          decision: "approve", command_digest: staged.command_digest,
          signer_principal_id: "principal:owner", authenticated_session_id: "task30-real-process",
          key_id: "decision-test", algorithm: "Ed25519", issued_at: clockValue.toISOString(),
          not_before: clockValue.toISOString(), expires_at: input.expires_at,
          nonce: `approval:${randomBytes(8).toString("hex")}`, max_uses: 1, status: "issued" };
        control.decide(signCommandApproval(receipt, localKey(authority)), clockValue);
      };
      const executor = (memoryLifecycle?: ConstructorParameters<typeof ApprovedCommandExecutor>[7]) =>
        new ApprovedCommandExecutor(authority, join(root, "jarvis-backups"),
          join(root, "jarvis-state"), {}, clock, undefined, provider, memoryLifecycle);
      const classify = (operation: "remember" | "correct", statement: string, id: string) => {
        const input = verifiedMemoryInput({ authority_id: id, idempotency_key: `task30:${id}`,
          operation, subject: "Task 30 runtime memory", statement });
        const expires = new Date(clockValue.getTime() + 10 * 60_000).toISOString();
        insertMemoryVerification(authority, memoryVerificationPayload(input, {
          issued_at: clockValue.toISOString(), not_before: clockValue.toISOString(), expires_at: expires,
          nonce: `verification-${id}`,
        }));
        return new MemoryCandidateStore(authority, memoryPolicy(), clock).classify(input);
      };

      const rememberCandidate = classify("remember", old, `remember-${randomBytes(6).toString("hex")}`);
      expect(rememberCandidate.state).toBe("approved");
      const rememberedContent = old;
      const createdAt = clockValue.toISOString();
      const requestExpires = new Date(clockValue.getTime() + 10 * 60_000).toISOString();
      const receipt = { schema_version: 1 as const,
        receipt_id: `receipt:memory:${randomBytes(32).toString("hex")}`,
        candidate_id: rememberCandidate.candidate_id,
        candidate_digest: rememberCandidate.candidate_digest,
        classification_digest: rememberCandidate.classification_digest,
        operation: rememberCandidate.operation, decision: "auto_staged",
        principal_id: "principal:owner", issued_at: createdAt, expires_at: requestExpires };
      const identity = { candidate_id: rememberCandidate.candidate_id,
        candidate_digest: rememberCandidate.candidate_digest,
        classification_digest: rememberCandidate.classification_digest,
        operation: rememberCandidate.operation };
      const idem = hash("orca-jarvis/memory-write-idempotency/v1\0", identity);
      const base = { schema_version: 1 as const, ...identity,
        idempotency_key: `memidem:pos:v1:${idem.slice(7)}`,
        subject: "Task 30 runtime memory", purpose: "personal_memory" as const,
        sensitivity: rememberCandidate.policy_sensitivity,
        retention_days: rememberCandidate.retention_days, created_at: createdAt,
        expires_at: requestExpires, expected_prior: null, receipt,
        receipt_digest: hash("orca-jarvis/memory-write-receipt/v1\0", receipt),
        payload: { content: rememberedContent } };
      const requestDigest = hash("orca-jarvis/memory-write-request/v1\0", base);
      const rememberRequest: SecondBrainWriteRequestV1 = { ...base,
        request_id: `memreq:pos:v1:${requestDigest.slice(7)}`, request_digest: requestDigest };
      const expectedArtifact = memoryRememberArtifact(rememberRequest).artifact;
      const pageId = expectedArtifact.page_id;
      const sid = expectedArtifact.sid;
      const rememberAction: ControlCommandRequestInput = { schema_version: 1,
        request_id: `control:remember:${randomBytes(8).toString("hex")}`,
        action: "memory.outbox.dispatch", action_level: 3,
        target: { candidate_id: rememberCandidate.candidate_id,
          candidate_digest: rememberCandidate.candidate_digest,
          classification_digest: rememberCandidate.classification_digest },
        args: { schema_version: 2, request: rememberRequest,
          expected_artifact: expectedArtifact },
        reversible: false, requested_by: "principal:owner", requested_at: createdAt,
        expires_at: new Date(clockValue.getTime() + 12 * 60_000).toISOString(),
        nonce: `remember:${randomBytes(8).toString("hex")}` };
      approve(rememberAction);
      const claimedRemember = control.claim(rememberAction.request_id, "task30-remember", clockValue);
      const outbox = new MemoryOutboxService({ authority, writer, reader, clock,
        artifactDeadlineMs: 30_000, leaseMs: 10_000 });
      const queued = outbox.enqueue(claimedRemember);
      const firstRemember = await outbox.runOnce("task30-remember", 1);
      expect(firstRemember.dispatched).toBe(1);
      expect(authority.db.prepare("SELECT outcome,outcome_code FROM memory_outbox_attempts WHERE outbox_id=?")
        .get(queued.outbox_id)).toEqual({ outcome: "accepted", outcome_code: "PROVIDER_ACCEPTED" });
      expect(outbox.get(queued.outbox_id)?.state, JSON.stringify(outbox.get(queued.outbox_id))).toBe("reconciling");
      expect(providerApply(root, config, site)).toMatchObject({ state: "proved", code: "PROVIDER_PROVED" });
      clockValue = new Date();
      await transport.restart();
      const settledRemember = await outbox.runOnce("task30-remember-reconcile", 1);
      expect(settledRemember.settled, JSON.stringify({ cycle: settledRemember, outbox: outbox.get(queued.outbox_id) })).toBe(1);
      const rememberRow = outbox.get(queued.outbox_id);
      expect(rememberRow?.state).toBe("settled");
      control.settle(rememberAction.request_id, claimedRemember.fence, { state: "completed",
        effect_type: "memory.remember.settled", payload: {
          outbox_id: queued.outbox_id,
          settlement_receipt_digest: rememberRow?.settlement_receipt_digest,
        } }, clockValue);

      const targetOld = await resolveBoundTarget(pageId, sid);
      const staleJarvis = join(restoreRoot, "pre-correction.sqlite");
      mkdirSync(dirname(staleJarvis), { recursive: true, mode: 0o700 });
      await authority.db.backup(staleJarvis);
      const preCorrectionBackup = join(providerRoot, "backups", "pre-correction");
      mkdirSync(dirname(preCorrectionBackup), { recursive: true, mode: 0o700 });
      cpSync(realpathSync(join(providerRoot, "share", "vault")), preCorrectionBackup, { recursive: true });
      chmodSync(preCorrectionBackup, 0o700);
      writeFileSync(join(preCorrectionBackup, "manifest.json"), "{\"schema_version\":1}\n", { mode: 0o600 });

      const correctionCandidate = classify("correct", corrected,
        `correct-${randomBytes(6).toString("hex")}`);
      expect(correctionCandidate.state).toBe("awaiting_confirmation");
      const correctionCandidateExpiry = new Date(clockValue.getTime() + 10 * 60_000).toISOString();
      const confirmation: ControlCommandRequestInput = { schema_version: 1,
        request_id: `control:confirm:${randomBytes(8).toString("hex")}`,
        action: "memory.confirm", action_level: 3,
        target: { candidate_id: correctionCandidate.candidate_id,
          candidate_digest: correctionCandidate.candidate_digest,
          classification_digest: correctionCandidate.classification_digest },
        args: { schema_version: 1, operation: "correct",
          evidence_digest: memoryOutboxHash("memory-outbox-event", { id: correctionCandidate.candidate_id }) },
        reversible: false, requested_by: "principal:owner",
        requested_at: clockValue.toISOString(), expires_at: correctionCandidateExpiry,
        nonce: `confirm:${randomBytes(8).toString("hex")}` };
      approve(confirmation);
      expect(await executor().execute(confirmation.request_id, "task30-confirm", clockValue))
        .toMatchObject({ state: "completed" });
      const correctionAction = await lifecycle.prepareCorrection({
        control_request_id: `control:correction:${randomBytes(8).toString("hex")}`,
        candidate_id: correctionCandidate.candidate_id, provider_instance_id: PROVIDER_ID,
        targets: [targetOld], scope: scope(targetOld, "none"), content: corrected,
        requested_at: clockValue, expires_at: new Date(clockValue.getTime() + 10 * 60_000),
        nonce: `correction:${randomBytes(8).toString("hex")}` });
      approve(correctionAction);
      const correctionPending = await executor(lifecycle).execute(
        correctionAction.request_id, "task30-correction", clockValue);
      expect(correctionPending).toMatchObject({ state: "uncertain",
        failure_code: "MEMORY_CORRECTION_RECONCILING" });
      const correctionId = required((correctionPending.result as { correction_id?: string }).correction_id,
        "TASK30_CORRECTION_ID_MISSING");
      expect(providerApply(root, config, site)).toMatchObject({ state: "proved", code: "PROVIDER_PROVED" });
      clockValue = new Date();
      await lifecycle.reconcilePending(10);
      expect(authority.db.prepare(
        "SELECT state FROM memory_correction_requests WHERE correction_id=?",
      ).get(correctionId)).toEqual({ state: "settled" });
      expect(authority.db.prepare(
        `SELECT COUNT(*) AS rows,
                CASE WHEN SUM(file_count+row_count+object_count+fd_count)>0 THEN 1 ELSE 0 END AS observed,
                SUM(match_count) AS matches,SUM(error_count) AS errors,SUM(omission_count) AS omissions
         FROM memory_surface_catalog_entries WHERE scanner_kind='provider_manifest'`,
      ).get()).toEqual({ rows: 40, observed: 1, matches: 0, errors: 0, omissions: 0 });
      expect(authority.db.prepare(
        `SELECT COUNT(*) AS rows,SUM(row_count) AS executions,SUM(object_count) AS blocks,
                SUM(error_count) AS errors,SUM(omission_count) AS omissions
         FROM memory_surface_catalog_entries WHERE scanner_kind='guard'`,
      ).get()).toEqual({ rows: 10, executions: 10, blocks: 10, errors: 0, omissions: 0 });
      expectAbsent(preCorrectionBackup, [oldNeedle]);
      expectAbsent(providerRoot, [oldNeedle]);

      // The corrected provider result must still pass the consumer's citation boundary.
      const correctedRead = await reader.search(corrected);
      expect(correctedRead.kind).toBe("current");
      if (correctedRead.kind !== "current") throw new Error("TASK30_CORRECTION_CITATION_INVALID");
      expect(correctedRead.evidence).toMatchObject([{ page_id: pageId, excerpt: corrected }]);
      const correctedEvidence = required(correctedRead.evidence[0], "TASK30_CORRECTION_EVIDENCE_MISSING");
      const targetCorrected = await resolveBoundTarget(pageId, correctedEvidence.sid);
      const exportId = `memexp:v1:${randomBytes(12).toString("hex")}`;
      const exportAction = await lifecycle.prepareExport({ export_id: exportId,
        correlation_id: `corr:${randomBytes(12).toString("hex")}`,
        provider_instance_id: PROVIDER_ID, targets: [targetCorrected],
        scope: scope(targetCorrected, "json"), requested_at: clockValue,
        expires_at: new Date(clockValue.getTime() + 10 * 60_000),
        nonce: `export:${randomBytes(8).toString("hex")}` });
      approve(exportAction);
      expect(await executor(lifecycle).execute(exportAction.request_id,
        "task30-export", clockValue)).toMatchObject({ state: "uncertain",
        failure_code: "MEMORY_EXPORT_WRITING" });
      expect(providerApply(root, config, site)).toMatchObject({ state: "proved", code: "PROVIDER_PROVED" });
      clockValue = new Date();
      await lifecycle.reconcilePending(10);
      expect(authority.db.prepare(
        `SELECT state,CASE WHEN export_file_count>0 THEN 1 ELSE 0 END AS files_observed,
                CASE WHEN export_byte_count>1 THEN 1 ELSE 0 END AS bytes_observed
         FROM memory_export_requests WHERE export_id=?`,
      ).get(exportId)).toEqual({ state: "available", files_observed: 1, bytes_observed: 1 });
      const preForgetBackup = join(providerRoot, "backups", "pre-forget");
      mkdirSync(dirname(preForgetBackup), { recursive: true, mode: 0o700 });
      cpSync(realpathSync(join(providerRoot, "share", "vault")), preForgetBackup, { recursive: true });
      chmodSync(preForgetBackup, 0o700);
      writeFileSync(join(preForgetBackup, "manifest.json"), "{\"schema_version\":1}\n", { mode: 0o600 });

      const deletionId = `memdel:v1:${randomBytes(12).toString("hex")}`;
      const deletionAction = await lifecycle.prepareDeletion({ deletion_id: deletionId,
        correlation_id: `corr:${randomBytes(12).toString("hex")}`,
        provider_instance_id: PROVIDER_ID, targets: [targetCorrected],
        scope: scope(targetCorrected, "none"), erasure_claim: "managed_erasure",
        external_receipts: [], requested_at: clockValue,
        expires_at: new Date(clockValue.getTime() + 10 * 60_000),
        nonce: `deletion:${randomBytes(8).toString("hex")}` });
      approve(deletionAction);
      expect(await executor(lifecycle).execute(deletionAction.request_id,
        "task30-deletion", clockValue)).toMatchObject({ state: "uncertain",
        failure_code: "MEMORY_DELETION_RECONCILING" });
      expect(providerApply(root, config, site)).toMatchObject({ state: "proved", code: "PROVIDER_PROVED" });
      clockValue = new Date();
      await lifecycle.reconcilePending(10);
      expect(authority.db.prepare(
        "SELECT state FROM memory_deletion_effect_requests WHERE deletion_id=?",
      ).get(deletionId)).toEqual({ state: "settled" });
      expectAbsent(preForgetBackup, [oldNeedle, correctedNeedle]);
      expect(authority.db.prepare("SELECT state FROM memory_export_requests WHERE export_id=?")
        .get(exportId)).toEqual({ state: "invalidated" });
      const restore = await sanitizeMemoryRestoreCandidate({ authority, source: staleJarvis,
        workspace: join(restoreRoot, "workspace"), now: clockValue });
      expect(restore).toMatchObject({ disposition: "sanitized", activated: false });
      expect(typeof restore.sanitized_path).toBe("string");
      if (typeof restore.sanitized_path !== "string") throw new Error("TASK30_RESTORE_PATH_MISSING");
      expectAbsent(restore.sanitized_path, [oldNeedle, correctedNeedle]);
      expect(await outbox.runOnce("task30-remember-replay", 1)).toMatchObject({ dispatched: 0 });
      await lifecycle.reconcilePending(10);
      expect(authority.db.prepare(
        "SELECT state FROM memory_correction_requests WHERE correction_id=?",
      ).get(correctionId)).toEqual({ state: "settled" });
      expect(authority.db.prepare(
        "SELECT state FROM memory_export_requests WHERE export_id=?",
      ).get(exportId)).toEqual({ state: "invalidated" });
      expect(authority.db.prepare(
        "SELECT state FROM memory_deletion_effect_requests WHERE deletion_id=?",
      ).get(deletionId)).toEqual({ state: "settled" });
      const v2Frames = Number((authority.db.prepare(
        `SELECT (SELECT COUNT(*) FROM memory_correction_attempts)
          +(SELECT COUNT(*) FROM memory_deletion_attempts)
          +(SELECT COUNT(*) FROM memory_export_attempts) AS count`,
      ).get() as { readonly count: number }).count);
      expect(writeFrames + v2Frames).toBe(4);
      expect(authority.db.prepare("SELECT COUNT(*) AS count FROM memory_correction_proofs").get())
        .toEqual({ count: 1 });
      expect(authority.db.prepare("SELECT COUNT(*) AS count FROM memory_export_proofs").get())
        .toEqual({ count: 1 });
      expect(authority.db.prepare("SELECT COUNT(*) AS count FROM memory_deletion_proofs").get())
        .toEqual({ count: 1 });
      expect(authority.db.prepare(
        `SELECT barrier_id,COUNT(*) AS count FROM memory_lifecycle_barrier_events
         GROUP BY barrier_id ORDER BY barrier_id`,
      ).all()).toEqual([
        { barrier_id: "before_settlement_commit", count: 3 },
        { barrier_id: "jarvis_proof_observation", count: 3 },
        { barrier_id: "jarvis_suppression_tombstone_commit", count: 2 },
      ]);
      const providerJournal = new Database(join(providerRoot, "requests", "journal.db"), { readonly: true });
      try {
        expect(providerJournal.prepare("SELECT operation,state,phase,fence FROM requests ORDER BY accepted_at")
          .all()).toEqual([
          { operation: "remember", state: "proved", phase: "proved", fence: 1 },
          { operation: "correct", state: "proved", phase: "proved", fence: 1 },
          { operation: "export", state: "proved", phase: "proved", fence: 1 },
          { operation: "forget", state: "proved", phase: "proved", fence: 1 },
        ]);
      } finally { providerJournal.close(); }
      // The provider must refuse this superseded target itself. Writing the journal here would
      // hide a provider that no longer produces EFFECT_PRIOR_STALE.
      const staleCandidate = classify("correct", `${corrected} again`,
        `stale-${randomBytes(6).toString("hex")}`);
      expect(staleCandidate.state).toBe("awaiting_confirmation");
      const staleConfirm: ControlCommandRequestInput = { schema_version: 1,
        request_id: `control:confirm:${randomBytes(8).toString("hex")}`,
        action: "memory.confirm", action_level: 3,
        target: { candidate_id: staleCandidate.candidate_id,
          candidate_digest: staleCandidate.candidate_digest,
          classification_digest: staleCandidate.classification_digest },
        args: { schema_version: 1, operation: "correct",
          evidence_digest: memoryOutboxHash("memory-outbox-event", { id: staleCandidate.candidate_id }) },
        reversible: false, requested_by: "principal:owner",
        requested_at: clockValue.toISOString(),
        expires_at: new Date(clockValue.getTime() + 10 * 60_000).toISOString(),
        nonce: `confirm:${randomBytes(8).toString("hex")}` };
      approve(staleConfirm);
      expect(await executor().execute(staleConfirm.request_id, "task30-stale-confirm", clockValue))
        .toMatchObject({ state: "completed" });
      const staleAction = await lifecycle.prepareCorrection({
        control_request_id: `control:stale:${randomBytes(8).toString("hex")}`,
        candidate_id: staleCandidate.candidate_id, provider_instance_id: PROVIDER_ID,
        targets: [targetOld], scope: scope(targetOld, "none"), content: `${corrected} again`,
        requested_at: clockValue, expires_at: new Date(clockValue.getTime() + 10 * 60_000),
        nonce: `stale:${randomBytes(8).toString("hex")}` });
      approve(staleAction);
      const staleSend = await executor(lifecycle).execute(staleAction.request_id, "task30-stale", clockValue);
      expect(staleSend).toMatchObject({ state: "uncertain", failure_code: "MEMORY_CORRECTION_RECONCILING" });
      const staleResult = staleSend.result;
      const staleCorrectionIdValue = isRecord(staleResult) ? staleResult["correction_id"] : undefined;
      if (typeof staleCorrectionIdValue !== "string") throw new Error("TASK30_STALE_CORRECTION_ID_MISSING");
      const staleCorrectionId = staleCorrectionIdValue;
      let providerRefusal: Readonly<Record<string, unknown>>;
      try {
        providerRefusal = providerApply(root, config, site);
      } catch (error) {
        const stdout = error instanceof Error && "stdout" in error ? String(error.stdout) : "";
        const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
        let parsed: unknown;
        try { parsed = JSON.parse(stdout); }
        catch { throw new Error(`TASK30_PROVIDER_RESULT_INVALID:${stderr.slice(-400)}`); }
        if (!isRecord(parsed)) throw new Error("TASK30_PROVIDER_RESULT_INVALID");
        providerRefusal = parsed;
      }
      expect(providerRefusal).toMatchObject({
        state: "failed", phase: "claimed", code: "EFFECT_PRIOR_STALE" });
      clockValue = new Date();
      await lifecycle.reconcilePending(10);
      expect(authority.db.prepare(
        "SELECT state, failure_code FROM memory_correction_requests WHERE correction_id=?",
      ).get(staleCorrectionId)).toEqual({ state: "conflict", failure_code: "MEMORY_PROVIDER_FAILED" });
      expect(authority.db.prepare(
        "SELECT state, failure_code FROM control_command_requests WHERE request_id=?",
      ).get(staleAction.request_id)).toEqual({ state: "failed", failure_code: "MEMORY_PROVIDER_FAILED" });
      expect(authority.db.prepare(
        "SELECT COUNT(*) AS count FROM control_command_effects WHERE request_id=? AND effect_type='memory.correction.refused'",
      ).get(staleAction.request_id)).toEqual({ count: 1 });
      expect(authority.db.prepare(
        "SELECT COUNT(*) AS count FROM memory_correction_attempts WHERE correction_id=?",
      ).get(staleCorrectionId)).toEqual({ count: 1 });
      const refusedCorrection = providerHighWater(providerRoot);
      expect(refusedCorrection.rows).toEqual([
        { operation: "remember", state: "proved", phase: "proved", fence: 1 },
        { operation: "correct", state: "proved", phase: "proved", fence: 1 },
        { operation: "export", state: "proved", phase: "proved", fence: 1 },
        { operation: "forget", state: "proved", phase: "proved", fence: 1 },
        { operation: "correct", state: "failed", phase: "claimed", fence: 1 },
      ]);
      const chain = authority.db.prepare(
        "SELECT sequence, set_root FROM memory_tombstone_chain ORDER BY sequence DESC LIMIT 1").get();
      expect(refusedCorrection.replica).toEqual(chain);
      const manifest: unknown = JSON.parse(readFileSync(
        join(realpathSync(join(providerRoot, "share", "vault")), "generation.json"), "utf8"));
      if (!isRecord(manifest)) throw new Error("TASK30_ACTIVE_MANIFEST_INVALID");
      const sequence = manifest["tombstone_sequence"];
      const setRoot = manifest["tombstone_set_root"];
      if (typeof sequence !== "number" || typeof setRoot !== "string") {
        throw new Error("TASK30_ACTIVE_MANIFEST_INVALID");
      }
      expect({ sequence, set_root: setRoot }).toEqual(chain);
      const staleTargetRead = await reader.search(old);
      const forgottenRead = await reader.search(corrected);
      const unrelatedRead = await reader.search("Task");
      expect(staleTargetRead.kind).toBe("current");
      expect(forgottenRead.kind).toBe("current");
      expect(unrelatedRead.kind).toBe("current");
      if (staleTargetRead.kind !== "current" || forgottenRead.kind !== "current") {
        throw new Error("TASK30_STALE_READ_FENCED");
      }
      expect(staleTargetRead.evidence.every(item => item.excerpt === null
        || (!item.excerpt.includes(old) && !item.excerpt.includes(corrected)))).toBe(true);
      expect(forgottenRead.evidence.every(item => item.excerpt === null
        || (!item.excerpt.includes(old) && !item.excerpt.includes(corrected)))).toBe(true);
      await lifecycle.reconcilePending(10);
      expect(authority.db.prepare(
        "SELECT state FROM memory_correction_requests WHERE correction_id=?",
      ).get(staleCorrectionId)).toEqual({ state: "conflict" });
      expect(authority.db.prepare(
        "SELECT COUNT(*) AS count FROM memory_correction_attempts WHERE correction_id=?",
      ).get(staleCorrectionId)).toEqual({ count: 1 });
      expect(authority.db.prepare(
        "SELECT COUNT(*) AS count FROM control_command_effects WHERE request_id=? AND effect_type='memory.correction.refused'",
      ).get(staleAction.request_id)).toEqual({ count: 1 });
      expect(providerHighWater(providerRoot).rows).toEqual(refusedCorrection.rows);
      // A stale deletion never reaches this provider. Dispatch preflights the target and
      // throws MEMORY_DELETION_TARGET_STALE, so an organic EFFECT_PRIOR_STALE forget would
      // require injecting the journal. The shipped deletion-refusal test covers that injected
      // observation; this lifecycle does not.
      expect(regularFiles(join(providerRoot, "exports")).filter(path => path.endsWith("memory.json")))
        .toEqual([]);
      expect(readdirSync(join(providerRoot, "share", "vault-generations"), { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith(".")).length).toBe(1);
      await transport.close();
      await lifecycle.close(); closeLifecycle = undefined; authorityClosed = true;
      expectAbsent(providerRoot, [oldNeedle, correctedNeedle]);
      expectAbsent(database.root, [oldNeedle, correctedNeedle]);
      const generationRoot = realpathSync(join(providerRoot, "share", "vault-generations"));
      const openGenerationFds: string[] = [];
      for (const processEntry of readdirSync("/proc", { withFileTypes: true })) {
        if (!processEntry.isDirectory() || !/^\d+$/.test(processEntry.name)) continue;
        const fdRoot = join("/proc", processEntry.name, "fd");
        if (!existsSync(fdRoot)) continue;
        try {
          for (const fd of readdirSync(fdRoot)) {
            try {
              const target = realpathSync(join(fdRoot, fd));
              if (target.startsWith(generationRoot)) openGenerationFds.push(`${processEntry.name}/${fd}`);
            } catch { continue; }
          }
        } catch { continue; }
      }
      expect(openGenerationFds).toEqual([]);
    } finally {
      await transport.close();
      if (closeLifecycle !== undefined) {
        await closeLifecycle(); authorityClosed = true;
      }
      if (!authorityClosed) closeMemoryDatabase(database);
      else {
        rmSync(database.root, { recursive: true, force: true });
        rmSync(database.anchorsRoot, { recursive: true, force: true });
      }
      writableRemove(root);
    }
  }, 180_000);
});
