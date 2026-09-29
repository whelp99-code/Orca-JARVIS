import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { AuthorityDb } from "../dist/src/db.js";
import { readEd25519PrivateKeyFile } from "../dist/src/memory-signing-key-file.js";
import { enrollOwnerDecisionKey, signOwnerKeyEnrollment } from "../dist/src/owner-decision-key-enrollment.js";

const { values } = parseArgs({ options: {
  prepare: { type: "boolean" }, apply: { type: "boolean" },
  "root-key-file": { type: "string" }, "private-key-file": { type: "string" },
  "proof-file": { type: "string" }, db: { type: "string" },
}, strict: true });

function required(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("OWNER_KEY_ABSOLUTE_PATH_REQUIRED");
  return path;
}

function readProof(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 8192) {
      throw new Error("OWNER_KEY_PROOF_FILE_INVALID");
    }
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

if (values.prepare === true && values.apply !== true) {
  const root = readEd25519PrivateKeyFile(required(values["root-key-file"]));
  if (!root) throw new Error("OWNER_ROOT_KEY_FILE_INVALID");
  const privatePath = required(values["private-key-file"]);
  const proofPath = required(values["proof-file"]);
  if (privatePath === proofPath || existsSync(privatePath) || existsSync(proofPath)) {
    throw new Error("OWNER_KEY_OUTPUT_EXISTS");
  }
  const pair = generateKeyPairSync("ed25519");
  const at = new Date();
  const proof = signOwnerKeyEnrollment({
    schema_version: 1, key_id: "owner-decision-v1", principal_id: "principal:owner",
    public_key_pem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    authorized_by: "jm-decision-root-v1", nonce: randomBytes(16).toString("hex"),
    issued_at: at.toISOString(), expires_at: new Date(at.getTime() + 24 * 60 * 60_000).toISOString(),
  }, root);
  writeFileSync(privatePath, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
  writeFileSync(proofPath, JSON.stringify(proof) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ ok: true, key_id: proof.key_id,
    public_key_sha256: createHash("sha256").update(proof.public_key_pem).digest("hex"),
    expires_at: proof.expires_at, private_key_file: privatePath, proof_file: proofPath }));
} else if (values.apply === true && values.prepare !== true) {
  const dbPath = required(values.db);
  if (!existsSync(dbPath)) throw new Error("OWNER_KEY_DATABASE_INVALID");
  const stat = lstatSync(dbPath);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid()) {
    throw new Error("OWNER_KEY_DATABASE_INVALID");
  }
  const db = new AuthorityDb(dbPath);
  try {
    await db.assertMigrationsReady();
    const proof = readProof(required(values["proof-file"]));
    enrollOwnerDecisionKey(db, proof, required(values["private-key-file"]));
    console.log(JSON.stringify({ ok: true, key_id: proof.key_id, principal_id: "principal:owner",
      audit: "owner_decision_key_enrolled" }));
  } finally {
    db.close();
  }
} else {
  throw new Error("OWNER_KEY_ENROLLMENT_MODE_REQUIRED");
}
