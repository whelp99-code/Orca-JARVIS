import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import {
  TASK_VERIFIER_KEY_ID_ENV,
  taskCertificationVerifierKey,
  taskCertificationVerifierPrincipal,
} from "../../src/task-certification-context.js";
import { migratedTestDatabase } from "../fixtures/migrated-database.js";
import { tempDb } from "../helpers.js";

const AT = "2026-09-15T00:00:00.000Z";
const open: AuthorityDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  delete process.env[TASK_VERIFIER_KEY_ID_ENV];
});

function pem(): string {
  return generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
}

type AnchorSpec = {
  readonly keyId: string;
  readonly principal: string;
  readonly purpose: "decision" | "verifier" | "policy";
  readonly publicKeyPem?: string;
  readonly revoked?: boolean;
  readonly algorithm?: string;
};

/**
 * A sealed authority database whose anchors are exactly the given ones. Sealing is inserted last,
 * because the sealing triggers forbid adding a key afterwards - which is the whole reason the
 * expected principal cannot be a compiled-in constant.
 */
async function sealedAuthority(anchors: readonly AnchorSpec[]): Promise<AuthorityDb> {
  const db = await migratedTestDatabase(tempDb());
  open.push(db);
  for (const anchor of anchors) {
    db.db.prepare("INSERT INTO trusted_authority_keys(key_id,principal_id,algorithm,public_key_pem,created_at) VALUES(?,?,?,?,?)")
      .run(anchor.keyId, anchor.principal, anchor.algorithm ?? "Ed25519", anchor.publicKeyPem ?? pem(), AT);
    db.db.prepare("INSERT INTO authority_key_purposes(key_id,purpose,created_at) VALUES(?,?,?)")
      .run(anchor.keyId, anchor.purpose, AT);
    if (anchor.revoked === true) {
      db.db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
        .run(anchor.keyId, "fixture revocation", AT);
    }
  }
  db.db.prepare("INSERT INTO authority_configuration(id,sealed_at) VALUES(1,?)").run(AT);
  expect(() => db.db.prepare("INSERT INTO trusted_authority_keys(key_id,principal_id,algorithm,public_key_pem,created_at) VALUES(?,?,?,?,?)")
    .run("late-key", "independent-verifier", "Ed25519", pem(), AT)).toThrowError(/sealed/);
  return db;
}

const verifier = (keyId = "jm-verifier-key", principal = "jm-verifier"): AnchorSpec =>
  ({ keyId, principal, purpose: "verifier" });

describe("task certification verifier principal", () => {
  it("certifies against a sealed deployment whose anchored verifier principal is jm-verifier", async () => {
    const db = await sealedAuthority([verifier(), { keyId: "owner-decision", principal: "principal:owner", purpose: "decision" }]);
    process.env[TASK_VERIFIER_KEY_ID_ENV] = "jm-verifier-key";
    expect(taskCertificationVerifierPrincipal(db, "jm-verifier-key")).toBe("jm-verifier");
    expect(taskCertificationVerifierKey(db, "jm-verifier-key"))
      .toBe(db.db.prepare("SELECT public_key_pem FROM trusted_authority_keys WHERE key_id=?")
        .pluck().get("jm-verifier-key"));
  });

  it("refuses a pinned key whose purpose is decision", async () => {
    const db = await sealedAuthority([verifier(), { keyId: "owner-decision", principal: "principal:owner", purpose: "decision" }]);
    process.env[TASK_VERIFIER_KEY_ID_ENV] = "owner-decision";
    expect(() => taskCertificationVerifierKey(db, "jm-verifier-key"))
      .toThrowError(/TASK_CERTIFICATION_BINDING_INVALID/);
    expect(() => taskCertificationVerifierPrincipal(db, "jm-verifier-key"))
      .toThrowError(/TASK_CERTIFICATION_BINDING_INVALID/);
  });

  it("refuses a revoked pinned key", async () => {
    const db = await sealedAuthority([{ ...verifier(), revoked: true }]);
    process.env[TASK_VERIFIER_KEY_ID_ENV] = "jm-verifier-key";
    expect(() => taskCertificationVerifierKey(db, "jm-verifier-key"))
      .toThrowError(/TASK_CERTIFICATION_BINDING_INVALID/);
  });

  it("refuses an unknown pinned key id", async () => {
    const db = await sealedAuthority([verifier()]);
    process.env[TASK_VERIFIER_KEY_ID_ENV] = "not-anchored";
    expect(() => taskCertificationVerifierKey(db, "jm-verifier-key"))
      .toThrowError(/TASK_CERTIFICATION_BINDING_INVALID/);
  });

  it("refuses a requested key whose principal is not the pinned anchor's", async () => {
    const db = await sealedAuthority([
      verifier(),
      verifier("other-verifier-key", "someone-else"),
    ]);
    process.env[TASK_VERIFIER_KEY_ID_ENV] = "jm-verifier-key";
    expect(() => taskCertificationVerifierKey(db, "other-verifier-key"))
      .toThrowError(/TASK_CERTIFICATION_BINDING_INVALID/);
  });

  it("no longer requires the principal to be the compiled-in independent-verifier name", async () => {
    const db = await sealedAuthority([verifier()]);
    expect(taskCertificationVerifierPrincipal(db, "jm-verifier-key")).toBe("jm-verifier");
    expect(() => taskCertificationVerifierKey(db, "jm-verifier-key")).not.toThrow();
  });

  it("still refuses a verifier anchor that reuses a decision key", async () => {
    const shared = pem();
    const db = await sealedAuthority([
      { keyId: "shared-verifier", principal: "jm-verifier", purpose: "verifier", publicKeyPem: shared },
      { keyId: "shared-decision", principal: "principal:owner", purpose: "decision", publicKeyPem: shared },
    ]);
    process.env[TASK_VERIFIER_KEY_ID_ENV] = "shared-verifier";
    expect(() => taskCertificationVerifierKey(db, "shared-verifier"))
      .toThrowError(/TASK_CERTIFICATION_BINDING_INVALID/);
  });
});
