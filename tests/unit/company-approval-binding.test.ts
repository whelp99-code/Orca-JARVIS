import { afterEach, describe, expect, it } from "vitest";
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AuthorityDb } from "../../src/db.js";
import { companyApprovalBindingSchema, companyApprovalReceiptSchema } from "../../src/company-approver-contract.js";
import { assertCurrentCompanyPin, registerCompanyApprovalBinding } from "../../src/company-approval-binding.js";
import { companyHandoffKeyV2, decodeCompanyCommandV2 } from "../../src/company-candidate-v2-contract.js";
import { companyCheckpointSchema, companyOperationId, loadCompanyFreshness, type CompanyFreshnessProvider } from "../../src/company-freshness.js";
import { ControlPlane } from "../../src/control-plane.js";
import { controlCommandDigest, controlValueDigest, signCommandApproval, type CommandApprovalReceipt } from "../../src/control-plane-contract.js";
import { importCompanyPage } from "../../src/company-candidate-import.js";
import { createTestOnlyMemoryProvider } from "../fixtures/company-freshness.js";
import { COMPANY_OWNER_KEY, companyProposal } from "../fixtures/company-candidate.js";
import { migratedTestDatabase } from "../fixtures/migrated-database.js";
import { TestOnlyCompanyDbProtocol } from "../fixtures/company-db-protocol.js";

const fixture = z.object({
  binding: companyApprovalBindingSchema,
  approval_receipt: companyApprovalReceiptSchema,
  command: z.unknown(),
  command_digest: z.string(),
  handoff_key: z.string(),
  test_only_key: z.object({ test_only_private_key_pkcs8_der_hex: z.string() }),
  test_only_memory: z.object({ factory_input: z.object({ initial_checkpoint: companyCheckpointSchema }) }),
}).parse(JSON.parse(readFileSync(new URL("../../fixtures/company-approver/company-approver-v2.test-only.json", import.meta.url), "utf8")));
const command = decodeCompanyCommandV2(fixture.command);
const now = new Date(fixture.approval_receipt.not_before);
const approverKey = createPrivateKey({
  key: Buffer.from(fixture.test_only_key.test_only_private_key_pkcs8_der_hex, "hex"), type: "pkcs8", format: "der",
});
const otherKey = createPrivateKey({
  key: Buffer.from(`302e020100300506032b657004220420${"06".repeat(32)}`, "hex"), type: "pkcs8", format: "der",
});
const verifierKey = createPrivateKey({
  key: Buffer.from(`302e020100300506032b657004220420${"08".repeat(32)}`, "hex"), type: "pkcs8", format: "der",
});
const scope = { provider_instance_id: fixture.binding.provider_instance_id, workspace_id: fixture.binding.workspace_id };
const context = {
  ...scope, owner: command.args.owner, processor_principal_id: command.args.processor_principal_id,
  projects: command.args.projects, policy_revision: command.args.policy_revision,
  deletion_sequence: command.args.deletion_sequence, deletion_set_root: command.args.deletion_set_root,
  agent_id: "agent:TEST_ONLY", session_id: "session:TEST_ONLY",
};
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

function addKey(db: AuthorityDb, id: string, key: KeyObject, principal = fixture.binding.approver_principal_id, purpose = "decision") {
  db.db.prepare("INSERT INTO trusted_authority_keys(key_id,principal_id,algorithm,public_key_pem,created_at) VALUES(?,?,?,?,?)")
    .run(id, principal, "Ed25519", createPublicKey(key).export({ format: "pem", type: "spki" }).toString(), now.toISOString());
  db.db.prepare("INSERT INTO authority_key_purposes(key_id,purpose,created_at) VALUES(?,?,?)")
    .run(id, purpose, now.toISOString());
}

function approval(overrides: Partial<Omit<CommandApprovalReceipt, "signature">> = {}, key = approverKey) {
  const payload = companyApprovalReceiptSchema.omit({ signature: true }).strip().parse(fixture.approval_receipt);
  return signCommandApproval({ ...payload, ...overrides }, key);
}

async function setup(enroll = true, alias = false) {
  const root = mkdtempSync(join(tmpdir(), "jarvis-company-approver-"));
  const db = await migratedTestDatabase(join(root, "authority.sqlite"));
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  addKey(db, fixture.approval_receipt.key_id, approverKey);
  addKey(db, "same-principal-nonpin", otherKey);
  addKey(db, "data-owner-key", COMPANY_OWNER_KEY, fixture.binding.owner);
  if (alias) addKey(db, "aliased-material", approverKey, fixture.binding.owner, "policy");
  const decision = join(root, "decision.pub.pem"); const verifier = join(root, "verifier.pub.pem");
  writeFileSync(decision, createPublicKey(approverKey).export({ format: "pem", type: "spki" }), { mode: 0o600 });
  writeFileSync(verifier, createPublicKey(verifierKey).export({ format: "pem", type: "spki" }), { mode: 0o600 });
  await db.initialize({
    decision: { keyId: fixture.approval_receipt.key_id, principal: fixture.binding.approver_principal_id, publicKeyPath: decision },
    verifier: { keyId: "test-verifier", principal: "principal:test-verifier", publicKeyPath: verifier },
  });
  const provider = createTestOnlyMemoryProvider({ scope, initial_checkpoint: fixture.test_only_memory.factory_input.initial_checkpoint });
  if (enroll) {
    registerCompanyApprovalBinding(db, fixture.binding, fixture.test_only_memory.factory_input.initial_checkpoint, provider, now);
    importCompanyPage(db, { handoffs: [{ idempotency_key: fixture.handoff_key, command, command_digest: fixture.command_digest }],
      count: 1, limit: 100, offset: 0 }, context, now);
  }
  return { db, root, provider, control: new ControlPlane(db, provider) };
}

/** Model an adversarial snapshot edit; the production guard is restored before exercising C1. */
function corruptSnapshot(db: AuthorityDb, trigger: string, mutate: () => void) {
  const row = db.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger) as { sql: string } | undefined;
  if (!row) throw new Error(`fixture seal missing: ${trigger}`);
  db.db.transaction(() => {
    db.db.exec(`DROP TRIGGER ${trigger}`);
    mutate();
    db.db.exec(row.sql);
  })();
}

function counts(db: AuthorityDb) {
  return ["control_command_receipts", "control_events", "control_command_redemptions", "company_progress_reservations"]
    .map(table => (db.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
}

describe("fixed company approver C1 authority", () => {
  it("T8 refuses a correctly signed data-owner decision", async () => {
    const { db, control } = await setup();
    const before = counts(db);
    expect(() => control.decide(approval({ key_id: "data-owner-key", signer_principal_id: fixture.binding.owner }, COMPANY_OWNER_KEY), now))
      .toThrow("COMPANY_APPROVAL_INVALID");
    expect(counts(db)).toEqual(before);
    control.decide(approval(), now);
    expect(control.get(command.request_id)?.state).toBe("approved");
  });

  it("T4 rejects a valid representative signature over a changed policy copy", async () => {
    const { db, control } = await setup();
    const altered = structuredClone(command);
    altered.args.approval_policy_version++;
    const key = companyHandoffKeyV2(altered);
    altered.request_id = `${key}:1`; altered.nonce = altered.request_id;
    const digest = controlCommandDigest(altered);
    importCompanyPage(db, { handoffs: [{ idempotency_key: key, command: altered, command_digest: digest }],
      count: 1, limit: 100, offset: 0 }, context, now);
    const before = counts(db);
    expect(() => control.decide(approval({ request_id: altered.request_id, command_digest: digest }), now)).toThrow("ENROLLMENT_REQUIRED");
    expect(counts(db)).toEqual(before);
    expect(control.get(altered.request_id)?.state).toBe("pending");
  });

  it("T10 rejects an old command digest transplanted into a signed v2 approval", async () => {
    const { db, control } = await setup();
    const legacy = companyProposal("legacy-digest", now, 1, context);
    const before = counts(db);
    expect(() => control.decide(approval({ command_digest: legacy.command_digest }), now)).toThrow("COMPANY_APPROVAL_INVALID");
    expect(counts(db)).toEqual(before);
  });

  it.each(["read", "reserve"] as const)("T6 provider %s exception denies before decision effects", async phase => {
    const { db, provider } = await setup();
    const failing: CompanyFreshnessProvider = {
      readFreshness: request => {
        if (phase === "read") throw new Error("TEST_ONLY unavailable");
        return provider.readFreshness(request);
      },
      reserveProgress: request => {
        if (phase === "reserve") throw new Error("TEST_ONLY unavailable");
        return provider.reserveProgress(request);
      },
      finishProgress: request => provider.finishProgress(request),
    };
    const before = counts(db);
    expect(() => new ControlPlane(db, failing).decide(approval(), now)).toThrow("COMPANY_FRESHNESS_REQUIRED");
    expect(counts(db)).toEqual(before);
  });

  it("T6 rejects a changed root at the same store sequence in a reserve response", async () => {
    const { db, provider } = await setup();
    const corrupt: CompanyFreshnessProvider = {
      readFreshness: request => provider.readFreshness(request),
      reserveProgress: request => {
        const response = provider.reserveProgress(request);
        if (response.outcome !== "reserved") return response;
        const result = structuredClone(response);
        result.checkpoint.stores.jarvis.receipt_root = controlValueDigest("TEST_ONLY corrupt root");
        return result;
      },
      finishProgress: request => provider.finishProgress(request),
    };
    const before = counts(db);
    expect(() => new ControlPlane(db, corrupt).decide(approval(), now)).toThrow("COMPANY_PROGRESS_UNCERTAIN");
    expect(counts(db)).toEqual(before);
  });

  it.each(["approve", "reject"] as const)("T17 refuses valid same-principal nonpin %s before any writes, then pinned succeeds", async decision => {
    const { db, control } = await setup();
    const before = counts(db);
    expect(() => control.decide(approval({ decision, key_id: "same-principal-nonpin" }, otherKey), now))
      .toThrow("COMPANY_APPROVAL_INVALID");
    expect(control.get(command.request_id)?.state).toBe("pending");
    expect(counts(db)).toEqual(before);
    control.decide(approval({ decision }), now);
    expect(control.get(command.request_id)?.state).toBe(decision === "approve" ? "approved" : "rejected");
    expect(counts(db)).toEqual(before.map((count, index) => index === 2 ? count : count + 1));
  });

  it("T5 uses the shared command2 digest and real representative signature", async () => {
    const { db } = await setup();
    expect(controlCommandDigest(command)).toBe(fixture.command_digest);
    expect(() => assertCurrentCompanyPin(db, command, fixture.approval_receipt, now)).not.toThrow();
  });

  it("unconfigured freshness denies a valid pinned decision with no mutation", async () => {
    const { db } = await setup();
    const before = counts(db);
    expect(() => new ControlPlane(db).decide(approval(), now)).toThrow("COMPANY_FRESHNESS_REQUIRED");
    expect(counts(db)).toEqual(before);
    expect(new ControlPlane(db).get(command.request_id)?.state).toBe("pending");
  });

  it("T1 fails registration without independently ready freshness and records nothing", async () => {
    const { db } = await setup(false);
    expect(() => registerCompanyApprovalBinding(db, fixture.binding, fixture.test_only_memory.factory_input.initial_checkpoint,
      loadCompanyFreshness({ schema_version: 2, kind: "unconfigured" }), now)).toThrow("COMPANY_FRESHNESS_REQUIRED");
    expect(db.db.prepare("SELECT * FROM company_approval_bindings").all()).toEqual([]);
    expect(db.db.prepare("SELECT * FROM company_freshness_checkpoints").all()).toEqual([]);
  });

  it.each([false, true])("registers only after external I/O and current-key recheck (revoked=%s)", async revoke => {
    const { db, provider } = await setup(false);
    const other = new AuthorityDb(db.filename);
    let writers = 0;
    const external: CompanyFreshnessProvider = {
      reserveProgress: request => provider.reserveProgress(request), finishProgress: request => provider.finishProgress(request),
      readFreshness(request) {
        expect(db.db.inTransaction).toBe(false);
        other.db.transaction(() => {
          writers++;
          if (revoke) other.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
            .run(fixture.approval_receipt.key_id, "TEST_ONLY concurrent revocation", now.toISOString());
        }).immediate();
        return provider.readFreshness(request);
      },
    };
    try {
      other.db.pragma("busy_timeout=0");
      const register = () => registerCompanyApprovalBinding(db, fixture.binding,
        fixture.test_only_memory.factory_input.initial_checkpoint, external, now);
      if (revoke) expect(register).toThrow("COMPANY_APPROVAL_REVOKED");
      else expect(register).not.toThrow();
      expect(writers).toBe(1);
      expect(db.db.prepare("SELECT count(*) AS n FROM company_approval_bindings").get()).toEqual({ n: revoke ? 0 : 1 });
      expect(db.db.prepare("SELECT count(*) AS n FROM company_freshness_checkpoints").get()).toEqual({ n: revoke ? 0 : 1 });
    } finally { other.close(); }
  });

  it("never invokes a registration provider under a caller-held write transaction", async () => {
    const { db, provider } = await setup(false);
    let reads = 0;
    const external: CompanyFreshnessProvider = {
      reserveProgress: request => provider.reserveProgress(request), finishProgress: request => provider.finishProgress(request),
      readFreshness(request) { reads++; return provider.readFreshness(request); },
    };
    expect(() => db.db.transaction(() => registerCompanyApprovalBinding(db, fixture.binding,
      fixture.test_only_memory.factory_input.initial_checkpoint, external, now)).immediate()).toThrow("COMPANY_FRESHNESS_REQUIRED");
    expect(reads).toBe(0);
  });

  it("registers an authenticated other-store prefix without replacing the caller's own facts", async () => {
    const { db } = await setup(false);
    const initial = fixture.test_only_memory.factory_input.initial_checkpoint;
    const provider = new TestOnlyCompanyDbProtocol(scope, initial);
    const latest = provider.checkpoint;
    latest.intent_sequence += 2; latest.intent_root = `sha256:${"6".repeat(64)}`;
    latest.stores.second_brain.receipt_sequence++; latest.stores.second_brain.receipt_root = `sha256:${"7".repeat(64)}`;
    provider.attest(latest);
    registerCompanyApprovalBinding(db, fixture.binding, initial, provider, now);
    expect(companyCheckpointSchema.parse(JSON.parse(String(db.db.prepare(
      "SELECT checkpoint_json FROM company_freshness_checkpoints",
    ).pluck().get())))).toEqual(latest);
    expect(provider.reads).toBe(1);
  });

  it("T12 refuses registration with preexisting legacy history without modifying it", async () => {
    const { db, provider } = await setup(false);
    const legacy = companyProposal("legacy-preserved", now, 1, context);
    const control = new ControlPlane(db);
    const before = control.stage(legacy.command, now);
    expect(() => registerCompanyApprovalBinding(db, fixture.binding, fixture.test_only_memory.factory_input.initial_checkpoint, provider, now))
      .toThrow("ENROLLMENT_REQUIRED");
    expect(control.get(legacy.command.request_id)).toEqual(before);
    expect(db.db.prepare("SELECT * FROM company_approval_bindings").all()).toEqual([]);
  });

  it("T16 rejects an aliased SPKI even under another principal/purpose", async () => {
    const { db, provider } = await setup(false, true);
    expect(() => registerCompanyApprovalBinding(db, fixture.binding, fixture.test_only_memory.factory_input.initial_checkpoint, provider, now))
      .toThrow("COMPANY_APPROVAL_INVALID");
    expect(db.db.prepare("SELECT * FROM company_approval_bindings").all()).toEqual([]);
  });

  it.each(["key", "principal", "binding"] as const)("T9 current %s revocation blocks decision", async kind => {
    const { db, control } = await setup();
    const reference = kind === "key" ? fixture.approval_receipt.key_id
      : kind === "principal" ? fixture.binding.approver_principal_id : command.args.approval_binding_digest;
    db.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
      .run(reference, "TEST_ONLY revocation", now.toISOString());
    const before = counts(db);
    expect(() => control.decide(approval(), now)).toThrow("COMPANY_APPROVAL_REVOKED");
    expect(counts(db)).toEqual(before);
  });

  it("T3 rechecks actual key material, not only the key ID", async () => {
    const { db, control } = await setup();
    corruptSnapshot(db, "trusted_keys_sealed_update", () => {
      db.db.prepare("UPDATE trusted_authority_keys SET public_key_pem=? WHERE key_id=?")
        .run(createPublicKey(otherKey).export({ format: "pem", type: "spki" }).toString(), fixture.approval_receipt.key_id);
    });
    const before = counts(db);
    expect(() => control.decide(approval(), now)).toThrow("COMPANY_APPROVAL_INVALID");
    expect(counts(db)).toEqual(before);
  });

  it("T3 decision purpose cannot be substituted", async () => {
    const { db, control } = await setup();
    corruptSnapshot(db, "immutable_key_purpose_update", () => {
      db.db.prepare("UPDATE authority_key_purposes SET purpose='policy' WHERE key_id=?").run(fixture.approval_receipt.key_id);
    });
    const before = counts(db);
    expect(() => control.decide(approval(), now)).toThrow("COMPANY_APPROVAL_INVALID");
    expect(counts(db)).toEqual(before);
  });

  it("does not accept unsigned extra approval fields", async () => {
    const { db, control } = await setup();
    const before = counts(db);
    const extra = { ...approval(), injected: "not-signed" };
    expect(() => control.decide(extra, now)).toThrow("COMPANY_APPROVAL_INVALID");
    expect(counts(db)).toEqual(before);
  });

  it("checks current command and approval expiry before any decision effect", async () => {
    const { db, control } = await setup();
    const before = counts(db);
    expect(() => control.decide(approval(), new Date(command.expires_at))).toThrow("COMPANY_APPROVAL_INVALID");
    expect(() => control.decide(approval(), new Date(Date.parse(command.requested_at) - 1))).toThrow("COMPANY_APPROVAL_INVALID");
    expect(counts(db)).toEqual(before);
  });

  it("retains a committed decision and uncertain reservation when finish is unavailable", async () => {
    const { db, provider } = await setup();
    const unavailable: CompanyFreshnessProvider = {
      readFreshness: request => provider.readFreshness(request),
      reserveProgress: request => provider.reserveProgress(request),
      finishProgress: () => ({
      schema_version: 2 as const, outcome: "error" as const, code: "COMPANY_FRESHNESS_REQUIRED" as const,
    }) };
    expect(() => new ControlPlane(db, unavailable).decide(approval(), now)).toThrow("COMPANY_FRESHNESS_REQUIRED");
    expect(new ControlPlane(db).get(command.request_id)?.state).toBe("approved");
    expect(db.db.prepare("SELECT status FROM company_candidate_handoffs WHERE request_id=?").get(command.request_id))
      .toEqual({ status: "uncertain" });
    expect(db.db.prepare("SELECT evidence_digest FROM company_progress_reservations").get()).toEqual({ evidence_digest: null });
  });

  it("T6 detects restored JARVIS state despite unchanged fixed key and policy", async () => {
    const { db, root, control, provider } = await setup();
    const backup = join(root, "before-decision.sqlite");
    await db.db.backup(backup);
    control.decide(approval(), now);
    const restored = new AuthorityDb(backup);
    cleanups.push(() => restored.close());
    const before = counts(restored);
    expect(() => new ControlPlane(restored, provider).decide(approval(), now)).toThrow("COMPANY_OPERATIONAL_ROLLBACK");
    expect(counts(restored)).toEqual(before);
    expect(new ControlPlane(restored).get(command.request_id)?.state).toBe("pending");
  });

  it("T6 an unresolved external intent is not ready even at the observed head", async () => {
    const { db, control, provider } = await setup();
    const checkpoint = fixture.test_only_memory.factory_input.initial_checkpoint;
    const reserved = provider.reserveProgress({
      schema_version: 2, scope, operation_id: companyOperationId({ scope, request_id: command.request_id,
        command_digest: fixture.command_digest, operation: "accept" }), operation: "accept", expected_checkpoint: checkpoint,
      event_digest: controlValueDigest("TEST_ONLY external intent"), challenge: "challenge:TEST_ONLY:external",
    });
    if (reserved.outcome !== "reserved" || !reserved.checkpoint) throw new Error("test reserve failed");
    db.db.prepare("UPDATE company_freshness_checkpoints SET checkpoint_json=?").run(JSON.stringify(reserved.checkpoint));
    const before = counts(db);
    expect(() => control.decide(approval(), now)).toThrow("COMPANY_FRESHNESS_REQUIRED");
    expect(counts(db)).toEqual(before);
  });
});
