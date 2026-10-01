import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { JarvisError, type AuthorityDb } from "./db.js";
import { verifyAttestationCrypto } from "./remote-approval-webauthn.js";

const TTL_MS = 10 * 60_000;

export type EnrollmentAttestation = Readonly<{
  id: string;
  clientDataJSON: string;
  attestationObject: string;
}>;

export type EnrollmentCheck = (input: Readonly<{
  attestation: EnrollmentAttestation;
  expectedChallenge: string;
  expectedOrigin: string;
  expectedRpId: string;
}>) => Promise<{ readonly ok: true; readonly publicKey: Buffer; readonly counter: number } | { readonly ok: false }>;

export function issueEnrollmentCode(db: AuthorityDb, now = new Date()): { readonly code: string; readonly expires_at: string } {
  const code = randomBytes(18).toString("base64url");
  const digest = sha(code);
  const challenge = randomBytes(32).toString("base64url");
  const expires = new Date(now.getTime() + TTL_MS).toISOString();
  db.db.prepare(
    `INSERT INTO owner_inbox_enrollment_codes(code_digest, challenge, expires_at, created_at)
     VALUES(?,?,?,?)`,
  ).run(digest, challenge, expires, now.toISOString());
  return { code, expires_at: expires };
}

export function readEnrollmentChallenge(db: AuthorityDb, code: string, now = new Date()): string {
  const row = findCode(db, code);
  if (row === undefined) return fail(db, "OWNER_INBOX_IDENTITY_REQUIRED", now);
  if (row.used_at !== null) return fail(db, "OWNER_INBOX_REPLAY", now);
  if (Date.parse(row.expires_at) <= now.getTime()) return fail(db, "OWNER_INBOX_EXPIRED", now);
  return row.challenge;
}

export async function enrollOwnerPasskey(db: AuthorityDb, input: Readonly<{
  code: string;
  attestation: EnrollmentAttestation;
  origin: string;
  expectedOrigin: string;
  rpId: string;
  now?: Date;
  check?: EnrollmentCheck;
}>): Promise<{ readonly credential_id: string }> {
  const now = input.now ?? new Date();
  const row = findCode(db, input.code);
  if (row === undefined) return fail(db, "OWNER_INBOX_IDENTITY_REQUIRED", now);
  if (row.used_at !== null) return fail(db, "OWNER_INBOX_REPLAY", now);
  if (Date.parse(row.expires_at) <= now.getTime()) return fail(db, "OWNER_INBOX_EXPIRED", now);
  if (input.origin !== input.expectedOrigin) return fail(db, "OWNER_INBOX_IDENTITY_REQUIRED", now);
  const checked = await (input.check ?? productionCheck)({
    attestation: input.attestation,
    expectedChallenge: row.challenge,
    expectedOrigin: input.origin,
    expectedRpId: input.rpId,
  });
  if (!checked.ok) return fail(db, "OWNER_INBOX_ASSERTION_REJECTED", now);
  const marked = db.db.prepare(
    "UPDATE owner_inbox_enrollment_codes SET used_at = ? WHERE code_digest = ? AND used_at IS NULL",
  ).run(now.toISOString(), sha(input.code));
  if (marked.changes !== 1) return fail(db, "OWNER_INBOX_REPLAY", now);
  db.db.prepare(
    "INSERT INTO owner_inbox_credentials(credential_id, public_key, counter, created_at) VALUES(?,?,?,?)",
  ).run(input.attestation.id, checked.publicKey, checked.counter, now.toISOString());
  audit(db, "success", "enrolled", now);
  return { credential_id: input.attestation.id };
}

const productionCheck: EnrollmentCheck = async (input) => {
  try {
    const verified = await verifyAttestationCrypto({
      attestation: {
        id: input.attestation.id,
        rawId: Buffer.from(input.attestation.id, "base64url"),
        clientDataJSON: Buffer.from(input.attestation.clientDataJSON, "base64url"),
        attestationObject: Buffer.from(input.attestation.attestationObject, "base64url"),
        attachment: null,
        clientExtensionResults: {},
      },
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.expectedOrigin,
      expectedRpId: input.expectedRpId,
    });
    return { ok: true, publicKey: Buffer.from(verified.publicKey), counter: verified.counter };
  } catch {
    return { ok: false };
  }
};

function findCode(db: AuthorityDb, code: string): { used_at: string | null; expires_at: string; challenge: string } | undefined {
  return db.db.prepare(
    "SELECT used_at, expires_at, challenge FROM owner_inbox_enrollment_codes WHERE code_digest = ?",
  ).get(sha(code)) as { used_at: string | null; expires_at: string; challenge: string } | undefined;
}

export function rejectEnrollmentOrigin(db: AuthorityDb, now = new Date()): never {
  return fail(db, "OWNER_INBOX_ORIGIN_MISMATCH", now);
}

function fail(db: AuthorityDb, code: string, now: Date): never {
  audit(db, "failure", code, now);
  throw new JarvisError(code);
}

function audit(db: AuthorityDb, outcome: string, code: string, now: Date): void {
  db.db.prepare("INSERT INTO audit_facts(fact_type,subject_id,payload_json,created_at) VALUES(?,?,?,?)").run(
    "owner_inbox_attempt", "enrollment", JSON.stringify({ outcome, code }), now.toISOString(),
  );
}

function sha(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export function codesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
