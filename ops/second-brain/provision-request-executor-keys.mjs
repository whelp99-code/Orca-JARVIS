#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { AuthorityDb } from "../../dist/src/db.js";
import * as keyAuthority from "../../dist/src/memory-effect-delegation.js";

const PRODUCTION = Object.freeze({
  db: "/home/jm/.local/state/orca-jarvis/jarvis.sqlite",
  config: "/home/jm/.config/second-brain/config.toml",
  providerRepo: "/home/jm/orca/workspaces/second-brain-app/jarvis-personal-operating-system",
  keyRoot: "/home/jm/.config/orca-jarvis/second-brain-keys",
  marker: "/home/jm/.config/second-brain/request-executor.enabled",
  receipt: "/home/jm/.config/second-brain/request-executor-keys.json",
});
const DEFAULT_PROVIDER = "provider:second-brain:linux";
const TARGET_KEYS = Object.freeze([
  "provider_instance_id",
  "provider_release_sha",
  "provider_signing_key_id",
  "provider_private_key",
  "jarvis_signing_key_id",
  "jarvis_public_key",
]);
const MANAGED_COMMENT = "# Managed by Orca-JARVIS request-executor key provisioning.";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parse(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        production: { type: "boolean" },
        "fixture-root": { type: "string" },
        "provider-release-sha": { type: "string" },
        "provider-instance-id": { type: "string" },
        apply: { type: "boolean" },
      },
      strict: true,
    }));
  } catch {
    fail("REQUEST_EXECUTOR_KEY_USAGE");
  }
  if (values.apply !== true) fail("REQUEST_EXECUTOR_KEY_APPLY_REQUIRED");
  const fixtureRoot = values["fixture-root"];
  if (values.production === true === (fixtureRoot !== undefined)) fail("REQUEST_EXECUTOR_KEY_MODE_INVALID");
  if (fixtureRoot === undefined) {
    if (values["provider-release-sha"] !== undefined || values["provider-instance-id"] !== undefined) {
      fail("REQUEST_EXECUTOR_KEY_PRODUCTION_OVERRIDE_FORBIDDEN");
    }
    return { ...PRODUCTION, production: true, providerReleaseSha: undefined,
      providerInstanceId: DEFAULT_PROVIDER };
  }
  const root = resolve(fixtureRoot);
  if (root === "/" || root.startsWith("/home/jm/.local/state/orca-jarvis")
    || root.startsWith("/home/jm/.config/second-brain")
    || root.startsWith("/home/jm/.config/orca-jarvis")) {
    fail("REQUEST_EXECUTOR_KEY_FIXTURE_ROOT_INVALID");
  }
  return {
    production: false,
    db: join(root, "jarvis.sqlite"),
    config: join(root, "config.toml"),
    providerRepo: join(root, "provider-repo"),
    keyRoot: join(root, "keys"),
    marker: join(root, "request-executor.enabled"),
    receipt: join(root, "request-executor-keys.json"),
    providerReleaseSha: values["provider-release-sha"],
    providerInstanceId: values["provider-instance-id"] ?? "provider:second-brain:fixture",
  };
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path)
    || stat.uid !== process.getuid?.()) fail("REQUEST_EXECUTOR_KEY_PATH_UNSAFE");
  chmodSync(path, 0o700);
}

function atomicWrite(path, body, mode = 0o600) {
  privateDirectory(dirname(path));
  const temporary = join(dirname(path), `.${path.split("/").at(-1)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(temporary, "wx", mode);
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, mode);
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

function securePrivateKey(path) {
  if (!existsSync(path)) {
    const pair = generateKeyPairSync("ed25519");
    atomicWrite(path, pair.privateKey.export({ format: "pem", type: "pkcs8" }), 0o600);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path)
    || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    fail("REQUEST_EXECUTOR_KEY_PATH_UNSAFE");
  }
  const key = createPrivateKey(readFileSync(path));
  if (key.asymmetricKeyType !== "ed25519") fail("REQUEST_EXECUTOR_KEY_TYPE_INVALID");
  return key;
}

function fingerprint(key) {
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

function keyMaterial(key, role) {
  const publicKey = createPublicKey(key);
  const privateJwk = key.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  if (typeof privateJwk.d !== "string" || typeof publicJwk.x !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(privateJwk.d) || !/^[A-Za-z0-9_-]{43}$/.test(publicJwk.x)) {
    fail("REQUEST_EXECUTOR_KEY_JWK_INVALID");
  }
  const keyFingerprint = fingerprint(key);
  return {
    key,
    keyId: `${role}:second-brain:linux:${keyFingerprint.slice(7, 23)}`,
    fingerprint: keyFingerprint,
    privateSeed: privateJwk.d,
    publicX: publicJwk.x,
    publicPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

function providerRelease(options) {
  const supplied = options.providerReleaseSha;
  const value = supplied ?? execFileSync("git", ["-C", options.providerRepo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(value)) fail("REQUEST_EXECUTOR_PROVIDER_RELEASE_INVALID");
  if (options.production) {
    const dirty = execFileSync("git", ["-C", options.providerRepo, "status", "--porcelain"], {
      encoding: "utf8",
    });
    if (dirty.trim() !== "") fail("REQUEST_EXECUTOR_PROVIDER_REPO_DIRTY");
  }
  return value;
}

function rootAssignments(text) {
  const lines = text.split(/\r?\n/);
  const table = lines.findIndex(line => /^\s*\[/.test(line));
  const boundary = table < 0 ? lines.length : table;
  const values = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*"([^"\\]*)"\s*(?:#.*)?$/.exec(lines[index]);
    if (match === null || !TARGET_KEYS.includes(match[1])) continue;
    if (index >= boundary || values.has(match[1])) fail("REQUEST_EXECUTOR_CONFIG_AMBIGUOUS");
    values.set(match[1], match[2]);
  }
  return { lines, boundary, values };
}

function updatedConfig(path, desired) {
  if (!existsSync(path)) fail("REQUEST_EXECUTOR_CONFIG_MISSING");
  const original = readFileSync(path, "utf8");
  const parsed = rootAssignments(original);
  for (const [key, value] of parsed.values) {
    if (value !== desired[key]) fail("REQUEST_EXECUTOR_CONFIG_CONFLICT");
  }
  const prefix = parsed.lines.slice(0, parsed.boundary)
    .filter(line => line !== MANAGED_COMMENT)
    .filter(line => {
      const match = /^\s*([A-Za-z0-9_]+)\s*=/.exec(line);
      return match === null || !TARGET_KEYS.includes(match[1]);
    });
  while (prefix.at(-1)?.trim() === "") prefix.pop();
  const managed = [MANAGED_COMMENT, ...TARGET_KEYS.map(key => `${key} = ${JSON.stringify(desired[key])}`)];
  const suffix = parsed.lines.slice(parsed.boundary);
  const body = [...prefix, "", ...managed, ...(suffix.length > 0 ? ["", ...suffix] : []), ""]
    .join("\n").replace(/\n{3,}$/u, "\n\n");
  if (body === original) return null;
  const backup = `${path}.pre-request-executor-${new Date().toISOString().replaceAll(":", "").replaceAll("-", "")}`;
  copyFileSync(path, backup);
  chmodSync(backup, 0o600);
  atomicWrite(path, body, 0o600);
  return backup;
}

function registrationFunctions() {
  const delegationName = ["register", "Memory", "Effect", "Delegation", "Key"].join("");
  const providerName = ["register", "Memory", "Provider", "Proof", "Key"].join("");
  const delegation = Reflect.get(keyAuthority, delegationName);
  const provider = Reflect.get(keyAuthority, providerName);
  if (typeof delegation !== "function" || typeof provider !== "function") {
    fail("REQUEST_EXECUTOR_AUTHORITY_API_MISSING");
  }
  return { delegation, provider };
}

async function registerAuthority(options, material) {
  const db = new AuthorityDb(options.db);
  try {
    await db.migrate();
    const api = registrationFunctions();
    db.db.transaction(() => {
      api.delegation(db, {
        key_id: material.jarvis.keyId,
        principal_id: "principal:owner",
        public_key_pem: material.jarvis.publicPem,
        valid_from: material.validFrom,
        valid_until: material.validUntil,
      }, material.now);
      api.provider(db, {
        key_id: material.provider.keyId,
        provider_instance_id: material.providerInstanceId,
        provider_release_sha: material.providerReleaseSha,
        public_key_pem: material.provider.publicPem,
        valid_from: material.validFrom,
        valid_until: material.validUntil,
      }, material.now);
    })();
    const delegation = db.db.prepare(
      "SELECT key_fingerprint,state,valid_from,valid_until FROM memory_effect_delegation_keys WHERE key_id=?",
    ).get(material.jarvis.keyId);
    const provider = db.db.prepare(
      "SELECT key_fingerprint,state,provider_instance_id,provider_release_sha FROM memory_provider_proof_keys WHERE key_id=?",
    ).get(material.provider.keyId);
    if (delegation?.key_fingerprint !== material.jarvis.fingerprint || delegation.state !== "active"
      || delegation.valid_from !== material.validFrom || delegation.valid_until !== material.validUntil
      || provider?.key_fingerprint !== material.provider.fingerprint || provider.state !== "active"
      || provider.provider_instance_id !== material.providerInstanceId
      || provider.provider_release_sha !== material.providerReleaseSha) {
      fail("REQUEST_EXECUTOR_AUTHORITY_VERIFY_FAILED");
    }
  } finally {
    db.close();
  }
}

function readReceipt(path) {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    fail("REQUEST_EXECUTOR_RECEIPT_UNSAFE");
  }
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value?.schema_version !== 1) fail("REQUEST_EXECUTOR_RECEIPT_INVALID");
  return value;
}

async function main(argv) {
  const options = parse(argv);
  privateDirectory(options.keyRoot);
  const jarvisPath = join(options.keyRoot, "jarvis-delegation-private.pem");
  const providerPath = join(options.keyRoot, "provider-proof-private.pem");
  const jarvis = keyMaterial(securePrivateKey(jarvisPath), "jarvis");
  const provider = keyMaterial(securePrivateKey(providerPath), "provider");
  const providerReleaseSha = providerRelease(options);
  const providerInstanceId = options.providerInstanceId;
  if (!/^[A-Za-z0-9:._-]{1,128}$/.test(providerInstanceId)) {
    fail("REQUEST_EXECUTOR_PROVIDER_ID_INVALID");
  }
  const prior = readReceipt(options.receipt);
  const now = new Date();
  const validFrom = prior?.valid_from ?? new Date(now.getTime() - 5 * 60_000).toISOString();
  const validUntil = prior?.valid_until ?? new Date(now.getTime() + 366 * 86_400_000).toISOString();
  const expectedPrior = prior === undefined ? undefined : {
    provider_instance_id: providerInstanceId,
    provider_release_sha: providerReleaseSha,
    jarvis_key_id: jarvis.keyId,
    jarvis_fingerprint: jarvis.fingerprint,
    provider_key_id: provider.keyId,
    provider_fingerprint: provider.fingerprint,
    valid_from: validFrom,
    valid_until: validUntil,
  };
  if (expectedPrior !== undefined) {
    for (const [key, value] of Object.entries(expectedPrior)) {
      if (prior[key] !== value) fail("REQUEST_EXECUTOR_RECEIPT_CONFLICT");
    }
  }
  const desired = {
    provider_instance_id: providerInstanceId,
    provider_release_sha: providerReleaseSha,
    provider_signing_key_id: provider.keyId,
    provider_private_key: provider.privateSeed,
    jarvis_signing_key_id: jarvis.keyId,
    jarvis_public_key: jarvis.publicX,
  };
  const configBackup = updatedConfig(options.config, desired);
  await registerAuthority(options, {
    now, validFrom, validUntil, providerInstanceId, providerReleaseSha, jarvis, provider,
  });
  const receipt = {
    schema_version: 1,
    provider_instance_id: providerInstanceId,
    provider_release_sha: providerReleaseSha,
    jarvis_key_id: jarvis.keyId,
    jarvis_fingerprint: jarvis.fingerprint,
    provider_key_id: provider.keyId,
    provider_fingerprint: provider.fingerprint,
    valid_from: validFrom,
    valid_until: validUntil,
    registered_at: prior?.registered_at ?? now.toISOString(),
  };
  atomicWrite(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`, 0o600);
  const receiptDigest = createHash("sha256").update(readFileSync(options.receipt)).digest("hex");
  atomicWrite(options.marker, `${receiptDigest}\n`, 0o600);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: options.production ? "production" : "fixture",
    provider_instance_id: providerInstanceId,
    provider_release_sha: providerReleaseSha,
    jarvis_key_id: jarvis.keyId,
    jarvis_fingerprint: jarvis.fingerprint,
    provider_key_id: provider.keyId,
    provider_fingerprint: provider.fingerprint,
    valid_from: validFrom,
    valid_until: validUntil,
    config_backup_created: configBackup !== null,
    marker_enabled: true,
  })}\n`);
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(error => {
    const code = error instanceof Error && "code" in error ? String(error.code) : "REQUEST_EXECUTOR_KEY_FAILED";
    process.stderr.write(`${code}\n`);
    process.exit(2);
  });
}
