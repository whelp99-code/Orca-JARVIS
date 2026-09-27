import { generateKeyPairSync } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { ControlPlane } from "./control-plane.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { readEd25519PrivateKeyFile } from "./memory-signing-key-file.js";
import { parsePersonalOsPolicy } from "./personal-os-policy.js";
import { RemoteApprovalService } from "./remote-approval.js";
import { createProductionIngressResolver } from "./remote-approval-ingress.js";
import { ControlReceiptSigner } from "./remote-approval-signer.js";

const PLACEHOLDER_ORIGIN = "https://remote-approval.invalid";

function sealedDecision(db: AuthorityDb): { key_id: string; principal_id: string } | undefined {
  return db.db.prepare(
    `SELECT k.key_id, k.principal_id FROM trusted_authority_keys k
     JOIN authority_key_purposes p ON p.key_id=k.key_id
     WHERE p.purpose='decision' LIMIT 1`,
  ).get() as { key_id: string; principal_id: string } | undefined;
}

export function composeRemoteApproval(db: AuthorityDb, options: {
  readonly policyPath?: string;
  readonly decisionKeyPath?: string;
  readonly ingressKeyPath?: string;
} = {}): RemoteApprovalService {
  const policy = readPolicy(options.policyPath);
  const origin = process.env.JARVIS_REMOTE_PUBLIC_ORIGIN ?? PLACEHOLDER_ORIGIN;
  let rpId = process.env.JARVIS_REMOTE_RP_ID;
  if (rpId === undefined) {
    try {
      rpId = new URL(origin).hostname;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      rpId = "remote-approval.invalid";
    }
  }
  const sealed = sealedDecision(db);
  const keyPath = options.decisionKeyPath ?? process.env.JARVIS_DECISION_SIGNING_KEY_FILE;
  const loaded = keyPath === undefined ? undefined : readEd25519PrivateKeyFile(keyPath);
  const signerConfigured = loaded !== undefined;
  const signer = new ControlReceiptSigner(
    loaded ?? generateKeyPairSync("ed25519").privateKey,
    sealed?.key_id ?? "unready-decision",
    sealed?.principal_id ?? "unready",
  );
  const ingressPath = options.ingressKeyPath ?? process.env.JARVIS_REMOTE_INGRESS_KEY_FILE;
  const ingressKey = ingressPath === undefined ? undefined : readKeyBytes(ingressPath);
  return new RemoteApprovalService({
    db,
    control: new ControlPlane(db),
    policy: { owner_principal: policy.owner_principal, remote_approval: policy.remote_approval },
    origin,
    rpId,
    signer,
    signerConfigured,
    resolver: createProductionIngressResolver({
      db, key: ingressKey, origin, now: () => new Date(),
      nonceTtlSeconds: policy.remote_approval.ingress_nonce_ttl_seconds,
    }),
  });
}

function readKeyBytes(path: string): Buffer | undefined {
  if (!isAbsolute(path)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 32 || (stat.mode & 0o077) !== 0) return undefined;
    const bytes = Buffer.alloc(32);
    if (readSync(fd, bytes, 0, 32, 0) !== 32) return undefined;
    return bytes;
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function readPolicy(explicitPath: string | undefined) {
  let fd: number | undefined;
  try {
    // Source execution and emitted artifacts each have one fixed resource location.
    // There is no cwd/parent fallback if an installed artifact is incomplete.
    const path = explicitPath ?? fileURLToPath(new URL(import.meta.url.endsWith(".ts")
      ? "../config/personal-os-policy.json" : "./personal-os-policy.json", import.meta.url));
    if (!isAbsolute(path)) throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 262144) throw new Error();
    const buffer = Buffer.alloc(262145);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, size);
      if (count === 0) break;
      size += count;
    }
    const bytes = buffer.subarray(0, size);
    const after = fstatSync(fd);
    if (bytes.length > 262144 || bytes.length !== before.size || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error();
    return parsePersonalOsPolicy(JSON.parse(bytes.toString("utf8")));
  } catch { throw new JarvisError("REMOTE_APPROVAL_POLICY_UNAVAILABLE"); }
  finally { if (fd !== undefined) closeSync(fd); }
}
