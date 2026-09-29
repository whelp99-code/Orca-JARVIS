import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { enrollOwnerDecisionKey, signOwnerKeyEnrollment } from "../../src/owner-decision-key-enrollment.js";
import { AuthorityDb } from "../../src/db.js";
import { composeRemoteApproval } from "../../src/remote-approval-compose.js";
import { externalAnchors } from "../helpers.js";

const now = new Date("2026-09-28T05:30:00.000Z");

async function sealedFixture() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-owner-key-"));
  const db = new AuthorityDb(join(root, "authority.sqlite"));
  const anchors = externalAnchors();
  await db.initialize({
    decision: { keyId: "jm-decision-root-v1", principal: "jm-owner", publicKeyPath: anchors.decisionPublic },
    verifier: { keyId: "verifier-test", principal: "independent-verifier", publicKeyPath: anchors.verifierPublic },
  });
  const owner = generateKeyPairSync("ed25519");
  const keyPath = join(root, "owner.pem");
  const rootKeyPath = join(root, "legacy-owner.pem");
  writeFileSync(keyPath, owner.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(rootKeyPath, anchors.decision.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const proof = signOwnerKeyEnrollment({
    schema_version: 1, key_id: "owner-decision-v1", principal_id: "principal:owner",
    public_key_pem: owner.publicKey.export({ type: "spki", format: "pem" }).toString(),
    authorized_by: "jm-decision-root-v1", nonce: "owner-enrollment-1",
    issued_at: "2026-09-28T05:00:00.000Z", expires_at: "2026-09-28T06:00:00.000Z",
  }, anchors.decision);
  return { db, root, keyPath, rootKeyPath, proof, close: () => {
    db.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(join(anchors.decisionPublic, ".."), { recursive: true, force: true });
  } };
}

it("enrolls one owner decision key when the sealed root signs its exact public key", async () => {
  // Given a sealed authority whose only decision key belongs to the historical owner identity.
  const { db, keyPath, proof, close } = await sealedFixture();
  try {
    // When the exact private key and signed enrollment are presented.
    enrollOwnerDecisionKey(db, proof, keyPath, now);

    // Then both principals remain distinct, an audit record exists, and ordinary inserts stay sealed.
    expect(db.db.prepare("SELECT key_id,principal_id FROM trusted_authority_keys ORDER BY key_id").all()).toEqual([
      { key_id: "jm-decision-root-v1", principal_id: "jm-owner" },
      { key_id: "local-policy-key", principal_id: "shadow-policy" },
      { key_id: "owner-decision-v1", principal_id: "principal:owner" },
      { key_id: "verifier-test", principal_id: "independent-verifier" },
    ]);
    expect(db.db.prepare("SELECT purpose FROM authority_key_purposes WHERE key_id='owner-decision-v1'").get())
      .toEqual({ purpose: "decision" });
    expect(db.db.prepare("SELECT fact_type FROM audit_facts WHERE subject_id='owner-decision-v1'").get())
      .toEqual({ fact_type: "owner_decision_key_enrolled" });
    expect(composeRemoteApproval(db, { decisionKeyPath: keyPath }).readiness())
      .toEqual({ remote_ready: true, reason: null });
    expect(() => db.db.prepare(
      "INSERT INTO trusted_authority_keys(key_id,principal_id,algorithm,public_key_pem,created_at) VALUES('extra','principal:owner','Ed25519','x','2026-09-28')",
    ).run()).toThrow("authority anchors sealed");
  } finally {
    close();
  }
});

it("prepares and applies the versioned enrollment through the real CLI", async () => {
  const { db, root, rootKeyPath, close } = await sealedFixture();
  const cli = join(process.cwd(), "scripts/owner-key-enrollment.mjs");
  const key = join(root, "operator-owner.pem");
  const proof = join(root, "operator-owner.json");
  try {
    const prepared = spawnSync(process.execPath, [cli, "--prepare", "--root-key-file", rootKeyPath,
      "--private-key-file", key, "--proof-file", proof], { encoding: "utf8", timeout: 10_000 });
    expect(prepared.status).toBe(0);
    expect(JSON.parse(prepared.stdout)).toMatchObject({ ok: true, key_id: "owner-decision-v1" });
    const applied = spawnSync(process.execPath, [cli, "--apply", "--db", db.filename,
      "--private-key-file", key, "--proof-file", proof], { encoding: "utf8", timeout: 10_000 });
    expect(applied.status).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      ok: true, key_id: "owner-decision-v1", principal_id: "principal:owner",
    });
    expect(db.db.prepare("SELECT authorized_by FROM owner_decision_key_enrollments WHERE key_id='owner-decision-v1'")
      .get()).toEqual({ authorized_by: "jm-decision-root-v1" });
  } finally {
    close();
  }
});

it("does not create a database when the apply path is mistyped", () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-owner-missing-db-"));
  const missing = join(root, "missing.sqlite");
  try {
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/owner-key-enrollment.mjs"),
      "--apply", "--db", missing, "--private-key-file", join(root, "key"),
      "--proof-file", join(root, "proof")], { encoding: "utf8", timeout: 10_000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OWNER_KEY_DATABASE_INVALID");
    expect(existsSync(missing)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects a changed public key in a root-signed enrollment", async () => {
  const { db, keyPath, proof, close } = await sealedFixture();
  try {
    const changed = { ...proof, public_key_pem: generateKeyPairSync("ed25519").publicKey
      .export({ type: "spki", format: "pem" }).toString() };
    expect(() => enrollOwnerDecisionKey(db, changed, keyPath, now)).toThrow("OWNER_KEY_PROOF_INVALID");
    expect(db.db.prepare("SELECT 1 FROM trusted_authority_keys WHERE key_id='owner-decision-v1'").get()).toBeUndefined();
  } finally {
    close();
  }
});

it("rejects a private key unrelated to the root-signed public key", async () => {
  const { db, keyPath, proof, close } = await sealedFixture();
  try {
    writeFileSync(keyPath, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
    expect(() => enrollOwnerDecisionKey(db, proof, keyPath, now)).toThrow("OWNER_KEY_FILE_MISMATCH");
    expect(db.db.prepare("SELECT 1 FROM trusted_authority_keys WHERE key_id='owner-decision-v1'").get()).toBeUndefined();
  } finally {
    close();
  }
});

it("rejects an expired owner-key enrollment before changing the registry", async () => {
  const { db, keyPath, proof, close } = await sealedFixture();
  try {
    expect(() => enrollOwnerDecisionKey(db, proof, keyPath, new Date("2026-09-28T06:00:00.000Z")))
      .toThrow("OWNER_KEY_PROOF_EXPIRED");
    expect(db.db.prepare("SELECT 1 FROM trusted_authority_keys WHERE key_id='owner-decision-v1'").get()).toBeUndefined();
  } finally {
    close();
  }
});

it("restores both seals when the audit write fails after key insertion", async () => {
  const { db, keyPath, proof, close } = await sealedFixture();
  try {
    db.db.exec(`CREATE TRIGGER fixture_reject_owner_audit BEFORE INSERT ON audit_facts
      WHEN NEW.fact_type='owner_decision_key_enrolled' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END`);
    expect(() => enrollOwnerDecisionKey(db, proof, keyPath, now)).toThrow("fixture audit failure");
    expect(db.db.prepare("SELECT 1 FROM trusted_authority_keys WHERE key_id='owner-decision-v1'").get()).toBeUndefined();
    expect(db.db.prepare("SELECT 1 FROM owner_decision_key_enrollments WHERE key_id='owner-decision-v1'").get())
      .toBeUndefined();
    expect(() => db.db.prepare(
      "INSERT INTO trusted_authority_keys(key_id,principal_id,algorithm,public_key_pem,created_at) VALUES('extra','principal:owner','Ed25519','x','2026-09-28')",
    ).run()).toThrow("authority anchors sealed");
    expect(() => db.db.prepare(
      "INSERT INTO authority_key_purposes(key_id,purpose,created_at) VALUES('extra','decision','2026-09-28')",
    ).run()).toThrow("authority key purposes sealed");
  } finally {
    close();
  }
});

it("rejects replay after a key has already been enrolled", async () => {
  const { db, keyPath, proof, close } = await sealedFixture();
  try {
    enrollOwnerDecisionKey(db, proof, keyPath, now);
    expect(() => enrollOwnerDecisionKey(db, proof, keyPath, now)).toThrow("OWNER_KEY_ALREADY_ENROLLED");
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM owner_decision_key_enrollments").get()).toEqual({ n: 1 });
  } finally {
    close();
  }
});
