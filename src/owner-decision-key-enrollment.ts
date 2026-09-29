import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { AuthorityDb, JarvisError } from "./db.js";
import { readEd25519PrivateKeyFile } from "./memory-signing-key-file.js";
import { z } from "zod";

const domain = "orca-jarvis/owner-decision-key-enrollment/v1\0";
const payloadSchema = z.strictObject({
  schema_version: z.literal(1),
  key_id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  principal_id: z.literal("principal:owner"),
  public_key_pem: z.string().min(1).max(4096),
  authorized_by: z.string().min(1),
  nonce: z.string().min(16).max(128),
  issued_at: z.iso.datetime({ precision: 3 }),
  expires_at: z.iso.datetime({ precision: 3 }),
});
const proofSchema = payloadSchema.extend({ signature: z.string().min(1).max(128) });
type EnrollmentPayload = z.infer<typeof payloadSchema>;

function signedBytes(payload: EnrollmentPayload): Buffer {
  return Buffer.from(domain + canonicalize(payload), "utf8");
}

export function signOwnerKeyEnrollment(payload: EnrollmentPayload, rootPrivateKey: KeyObject): EnrollmentPayload & {
  readonly signature: string;
} {
  const parsed = payloadSchema.parse(payload);
  return { ...parsed, signature: sign(null, signedBytes(parsed), rootPrivateKey).toString("base64") };
}

/**
 * One narrowly authorized extension of a sealed decision registry. The original anchors remain
 * immutable; the INSERT seals are restored within the same transaction before any commit.
 */
export function enrollOwnerDecisionKey(db: AuthorityDb, input: unknown, privateKeyPath: string, now = new Date()): void {
  const parsed = proofSchema.safeParse(input);
  if (!parsed.success) throw new JarvisError("OWNER_KEY_PROOF_INVALID");
  const { signature, ...payload } = parsed.data;
  const at = now.getTime();
  const issued = Date.parse(payload.issued_at);
  const expires = Date.parse(payload.expires_at);
  if (!Number.isFinite(at) || issued > at || expires <= at || expires - issued > 24 * 60 * 60_000) {
    throw new JarvisError("OWNER_KEY_PROOF_EXPIRED");
  }
  const signed = Buffer.from(signature, "base64");
  if (signed.length !== 64 || signed.toString("base64") !== signature) {
    throw new JarvisError("OWNER_KEY_PROOF_INVALID");
  }
  const oldKey = db.db.prepare(
    `SELECT k.public_key_pem,k.principal_id FROM trusted_authority_keys k
     JOIN authority_key_purposes p ON p.key_id=k.key_id AND p.purpose='decision'
     WHERE k.key_id=?`,
  ).get(payload.authorized_by) as { public_key_pem: string; principal_id: string } | undefined;
  if (oldKey?.principal_id !== "jm-owner" || !db.db.prepare(
    "SELECT 1 FROM authority_configuration WHERE id=1",
  ).get() || db.db.prepare(
    "SELECT 1 FROM authority_revocations WHERE reference=?",
  ).get(payload.authorized_by) || !verify(null, signedBytes(payload), oldKey.public_key_pem, signed)) {
    throw new JarvisError("OWNER_KEY_PROOF_INVALID");
  }
  const privateKey = readEd25519PrivateKeyFile(privateKeyPath);
  if (!privateKey) throw new JarvisError("OWNER_KEY_FILE_INVALID");
  let publicPem: string;
  try {
    publicPem = createPublicKey(payload.public_key_pem).export({ type: "spki", format: "pem" }).toString();
  } catch {
    throw new JarvisError("OWNER_KEY_PROOF_INVALID");
  }
  if (publicPem !== payload.public_key_pem
    || createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString() !== publicPem) {
    throw new JarvisError("OWNER_KEY_FILE_MISMATCH");
  }
  const publicDigest = createHash("sha256").update(publicPem).digest("hex");
  const proofDigest = createHash("sha256").update(signedBytes(payload)).update(signed).digest("hex");
  const tx = db.db.transaction(() => {
    const existing = db.db.prepare(
      `SELECT 1 FROM trusted_authority_keys k JOIN authority_key_purposes p ON p.key_id=k.key_id
       WHERE k.principal_id='principal:owner' AND p.purpose='decision'`,
    ).get();
    if (existing) throw new JarvisError("OWNER_KEY_ALREADY_ENROLLED");
    const names = ["trusted_keys_sealed_insert", "sealed_key_purpose_insert"] as const;
    const triggers = names.map(name => db.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
    ).get(name) as { sql: string } | undefined);
    if (triggers.some((trigger, index) => !trigger?.sql.includes(index === 0
      ? "authority anchors sealed" : "authority key purposes sealed"))) {
      throw new JarvisError("OWNER_KEY_SEAL_MISSING");
    }
    db.db.exec("DROP TRIGGER trusted_keys_sealed_insert; DROP TRIGGER sealed_key_purpose_insert");
    db.db.prepare(
      "INSERT INTO trusted_authority_keys(key_id,principal_id,algorithm,public_key_pem,created_at) VALUES(?,?,?,?,?)",
    ).run(payload.key_id, payload.principal_id, "Ed25519", publicPem, now.toISOString());
    db.db.prepare(
      "INSERT INTO authority_key_purposes(key_id,purpose,created_at) VALUES(?,'decision',?)",
    ).run(payload.key_id, now.toISOString());
    for (const trigger of triggers) {
      if (!trigger) throw new JarvisError("OWNER_KEY_SEAL_MISSING");
      db.db.exec(trigger.sql);
    }
    db.db.prepare(
      "INSERT INTO owner_decision_key_enrollments(key_id,authorized_by,proof_digest,enrolled_at) VALUES(?,?,?,?)",
    ).run(payload.key_id, payload.authorized_by, proofDigest, now.toISOString());
    db.db.prepare(
      "INSERT INTO audit_facts(fact_type,subject_id,payload_json,created_at) VALUES('owner_decision_key_enrolled',?,?,?)",
    ).run(payload.key_id, canonicalize({
      authorized_by: payload.authorized_by, principal_id: payload.principal_id,
      public_key_sha256: publicDigest, proof_digest: proofDigest, nonce: payload.nonce,
    }), now.toISOString());
  });
  tx.immediate();
}
