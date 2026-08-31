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
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { ApprovedCommandExecutor } from "../../src/approved-executor.js";
import { ControlPlane, signCommandApproval, type CommandApprovalReceipt,
  type ControlCommandRequestInput } from "../../src/control-plane.js";
import { MemoryCandidateStore } from "../../src/memory-candidate-store.js";
import { MemoryCorrectionSaga } from "../../src/memory-correction-saga.js";
import { MemoryDeletionSaga } from "../../src/memory-deletion-saga.js";
import { registerMemoryEffectDelegationKey,
  registerMemoryProviderProofKey } from "../../src/memory-effect-delegation.js";
import { MemoryExportSaga } from "../../src/memory-export-saga.js";
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

const PROVIDER = "/home/jm/orca/workspaces/second-brain-app/jarvis-personal-operating-system";
const PYTHON = `${PROVIDER}/.venv/bin/python`;
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
function sha(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
  const output = execFileSync(PYTHON, ["-m", "sb.cli", "apply-requests", "--once"], {
    cwd: root, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, PYTHONPATH: site, SB_CONFIG: config },
  });
  const value: unknown = JSON.parse(output);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("TASK30_PROVIDER_RESULT_INVALID");
  }
  return value as Readonly<Record<string, unknown>>;
}

describe("Task 30 real built-process lifecycle", () => {
  it("runs one approved remember and three proof-bound effects through the real MCP child", async () => {
    const wheel = `${PROVIDER}/dist/second_brain-0.1.0-py3-none-any.whl`;
    expect(existsSync(wheel), "provider writer must run uv build before this gate").toBe(true);
    const providerSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: PROVIDER, encoding: "utf8",
    }).trim();
    expect(providerSha).toMatch(/^[0-9a-f]{40}$/);
    const root = mkdtempSync(join(tmpdir(), "task30-real-process-"));
    const site = join(root, "site");
    const providerRoot = join(root, "provider");
    const spoolRoot = join(root, "jarvis-spool");
    const restoreRoot = join(root, "restore");
    mkdirSync(site, { mode: 0o700 });
    mkdirSync(providerRoot, { mode: 0o700 });
    execFileSync(PYTHON, ["-m", "zipfile", "-e", wheel, site], { cwd: root });
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
    writeFileSync(launcher, `#!/bin/sh\nexport PYTHONPATH=${site}\nexec ${PYTHON} -m sb.mcp\n`, { mode: 0o700 });
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
      const reader = createSecondBrainReadAdapter({ transport,
        budgets: { max_hits: 16, max_excerpt_bytes: 4_096,
          max_total_bytes: 65_536, max_page_bytes: 1_048_576 },
        clock, max_age_ms: 86_400_000, expiry_ms: 2 * 86_400_000,
        read_fence: provider.readFenceFactory() });
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
      const executor = (lifecycles: ConstructorParameters<typeof ApprovedCommandExecutor>[7] = {}) =>
        new ApprovedCommandExecutor(authority, join(root, "jarvis-backups"),
          join(root, "jarvis-state"), {}, clock, undefined, provider, lifecycles);
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
      const sid = createHash("sha256").update(rememberCandidate.candidate_id).digest("hex").slice(0, 16);
      const oldRecord = `${old} [^${sid}]`;
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
      const pageId = `wiki/memory-${createHash("sha256").update(rememberedContent).digest("hex").slice(0, 16)}`;
      const rememberAction: ControlCommandRequestInput = { schema_version: 1,
        request_id: `control:remember:${randomBytes(8).toString("hex")}`,
        action: "memory.outbox.dispatch", action_level: 3,
        target: { candidate_id: rememberCandidate.candidate_id,
          candidate_digest: rememberCandidate.candidate_digest,
          classification_digest: rememberCandidate.classification_digest },
        args: { schema_version: 2, request: rememberRequest,
          expected_artifact: { page_id: pageId, sid, source_digest: sha(oldRecord) } },
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
      expect(outbox.get(queued.outbox_id)?.state).toBe("reconciling");
      expect(providerApply(root, config, site)).toMatchObject({ state: "proved", code: "PROVIDER_PROVED" });
      clockValue = new Date();
      await transport.restart();
      const settledRemember = await outbox.runOnce("task30-remember-reconcile", 1);
      expect(settledRemember.settled).toBe(1);
      const rememberRow = outbox.get(queued.outbox_id);
      expect(rememberRow?.state).toBe("settled");
      control.settle(rememberAction.request_id, claimedRemember.fence, { state: "completed",
        effect_type: "memory.remember.settled", payload: {
          outbox_id: queued.outbox_id,
          settlement_receipt_digest: rememberRow?.settlement_receipt_digest,
        } }, clockValue);

      const targetOldResult = await provider.resolveTarget({ page_id: pageId,
        exact_record: oldRecord, source_identity_full: "6".repeat(64) });
      if (targetOldResult.kind !== "data") throw new Error(targetOldResult.code);
      const targetOld = targetOldResult.value;
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
      const correction = new MemoryCorrectionSaga({ authority, spool_root: spoolRoot,
        writer, provider, signing_key_id: JARVIS_KEY_ID, private_key: jarvisKey,
        subject_key: Buffer.alloc(32, 11), clock,
        artifact_verified: async proof => typeof proof.artifact_manifest_digest === "string",
        purge_needles: () => [oldNeedle, correctedNeedle, Buffer.from(rememberedContent)],
        managed_roots: [{ path: spoolRoot, kind: "spool" },
          { path: join(root, "jarvis-state"), kind: "state" },
          { path: join(root, "jarvis-backups"), kind: "backup" }],
        backup_roots: [join(root, "jarvis-backups")] });
      const correctionAction = await correction.prepare({
        control_request_id: `control:correction:${randomBytes(8).toString("hex")}`,
        candidate_id: correctionCandidate.candidate_id, provider_instance_id: PROVIDER_ID,
        targets: [targetOld], scope: scope(targetOld, "none"), content: corrected,
        requested_at: clockValue, expires_at: new Date(clockValue.getTime() + 10 * 60_000),
        nonce: `correction:${randomBytes(8).toString("hex")}` });
      approve(correctionAction);
      const correctionPending = await executor({ correction }).execute(
        correctionAction.request_id, "task30-correction", clockValue);
      expect(correctionPending).toMatchObject({ state: "uncertain",
        failure_code: "MEMORY_CORRECTION_RECONCILING" });
      const correctionId = required((correctionPending.result as { correction_id?: string }).correction_id,
        "TASK30_CORRECTION_ID_MISSING");
      expect(providerApply(root, config, site)).toMatchObject({ state: "proved", code: "PROVIDER_PROVED" });
      clockValue = new Date();
      expect(await correction.reconcile(correctionId)).toMatchObject({ state: "settled" });
      expectAbsent(preCorrectionBackup, [oldNeedle]);
      expectAbsent(providerRoot, [oldNeedle]);

      const targetCorrectedResult = await provider.resolveTarget({ page_id: pageId,
        exact_record: corrected, source_identity_full: "6".repeat(64) });
      if (targetCorrectedResult.kind !== "data") throw new Error(targetCorrectedResult.code);
      const targetCorrected = targetCorrectedResult.value;
      const exportSaga = new MemoryExportSaga({ authority, spool_root: spoolRoot,
        writer, provider, signing_key_id: JARVIS_KEY_ID, private_key: jarvisKey,
        subject_key: Buffer.alloc(32, 11), clock,
        export_verified: async proof => ({ file_count: 1,
          byte_count: statSync(join(providerRoot, "exports", String(proof.request_id), "memory.json")).size }) });
      const exportId = `memexp:v1:${randomBytes(12).toString("hex")}`;
      const exportAction = await exportSaga.prepare({ export_id: exportId,
        correlation_id: `corr:${randomBytes(12).toString("hex")}`,
        provider_instance_id: PROVIDER_ID, targets: [targetCorrected],
        scope: scope(targetCorrected, "json"), requested_at: clockValue,
        expires_at: new Date(clockValue.getTime() + 10 * 60_000),
        nonce: `export:${randomBytes(8).toString("hex")}` });
      approve(exportAction);
      expect(await executor({ export: exportSaga }).execute(exportAction.request_id,
        "task30-export", clockValue)).toMatchObject({ state: "uncertain",
        failure_code: "MEMORY_EXPORT_WRITING" });
      expect(providerApply(root, config, site)).toMatchObject({ state: "proved", code: "PROVIDER_PROVED" });
      clockValue = new Date();
      expect(await exportSaga.reconcile(exportId)).toMatchObject({ state: "available" });
      const preForgetBackup = join(providerRoot, "backups", "pre-forget");
      mkdirSync(dirname(preForgetBackup), { recursive: true, mode: 0o700 });
      cpSync(realpathSync(join(providerRoot, "share", "vault")), preForgetBackup, { recursive: true });
      chmodSync(preForgetBackup, 0o700);
      writeFileSync(join(preForgetBackup, "manifest.json"), "{\"schema_version\":1}\n", { mode: 0o600 });

      const deletion = new MemoryDeletionSaga({ authority, spool_root: spoolRoot,
        writer, provider, signing_key_id: JARVIS_KEY_ID, private_key: jarvisKey,
        subject_key: Buffer.alloc(32, 11), clock,
        absence_verified: async proof => typeof proof.surface_manifest_digest === "string",
        purge_needles: () => [oldNeedle, correctedNeedle, Buffer.from(rememberedContent)],
        managed_roots: [{ path: spoolRoot, kind: "spool" },
          { path: join(root, "jarvis-state"), kind: "state" },
          { path: join(root, "jarvis-backups"), kind: "backup" }],
        backup_roots: [join(root, "jarvis-backups")] });
      const deletionId = `memdel:v1:${randomBytes(12).toString("hex")}`;
      const deletionAction = await deletion.prepare({ deletion_id: deletionId,
        correlation_id: `corr:${randomBytes(12).toString("hex")}`,
        provider_instance_id: PROVIDER_ID, targets: [targetCorrected],
        scope: scope(targetCorrected, "none"), erasure_claim: "managed_erasure",
        external_receipts: [], requested_at: clockValue,
        expires_at: new Date(clockValue.getTime() + 10 * 60_000),
        nonce: `deletion:${randomBytes(8).toString("hex")}` });
      approve(deletionAction);
      expect(await executor({ deletion }).execute(deletionAction.request_id,
        "task30-deletion", clockValue)).toMatchObject({ state: "uncertain",
        failure_code: "MEMORY_DELETION_RECONCILING" });
      expect(providerApply(root, config, site)).toMatchObject({ state: "proved", code: "PROVIDER_PROVED" });
      clockValue = new Date();
      expect(await deletion.reconcile(deletionId)).toMatchObject({ state: "settled" });
      expectAbsent(preForgetBackup, [oldNeedle, correctedNeedle]);
      expect(authority.db.prepare("SELECT state FROM memory_export_requests WHERE export_id=?")
        .get(exportId)).toEqual({ state: "invalidated" });
      const restore = await sanitizeMemoryRestoreCandidate({ authority, source: staleJarvis,
        workspace: join(restoreRoot, "workspace"), subject_key: Buffer.alloc(32, 11),
        needles: [oldNeedle, correctedNeedle], now: clockValue });
      expect(restore).toMatchObject({ disposition: "sanitized", activated: false });
      expect(typeof restore.sanitized_path).toBe("string");
      if (typeof restore.sanitized_path !== "string") throw new Error("TASK30_RESTORE_PATH_MISSING");
      expectAbsent(restore.sanitized_path, [oldNeedle, correctedNeedle]);
      expect(await outbox.runOnce("task30-remember-replay", 1)).toMatchObject({ dispatched: 0 });
      expect(await correction.reconcile(correctionId)).toMatchObject({ state: "settled" });
      expect(await exportSaga.reconcile(exportId)).toMatchObject({ state: "invalidated" });
      expect(await deletion.reconcile(deletionId)).toMatchObject({ state: "settled" });
      expect(writeFrames).toBe(4);
      expect(authority.db.prepare("SELECT COUNT(*) AS count FROM memory_correction_proofs").get())
        .toEqual({ count: 1 });
      expect(authority.db.prepare("SELECT COUNT(*) AS count FROM memory_export_proofs").get())
        .toEqual({ count: 1 });
      expect(authority.db.prepare("SELECT COUNT(*) AS count FROM memory_deletion_proofs").get())
        .toEqual({ count: 1 });
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
      expect(regularFiles(join(providerRoot, "exports")).filter(path => path.endsWith("memory.json")))
        .toEqual([]);
      expect(readdirSync(join(providerRoot, "share", "vault-generations"), { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith(".")).length).toBe(1);
      await transport.close();
      authority.close(); authorityClosed = true;
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
      if (!authorityClosed) closeMemoryDatabase(database);
      else {
        rmSync(database.root, { recursive: true, force: true });
        rmSync(database.anchorsRoot, { recursive: true, force: true });
      }
      writableRemove(root);
    }
  }, 180_000);
});
