import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AuthorityDb } from "../../src/db.js";
import {
  DECISION_KEY_ID,
  DECISION_PRINCIPAL,
  VERIFIER_KEY_ID,
  VERIFIER_PRINCIPAL,
} from "./dashboard-fixture-ids.js";

export type FixtureEnv = {
  readonly tempRoot: string;
  readonly dbPath: string;
  readonly db: AuthorityDb;
  readonly decisionKeyPath: string;
  readonly verifierKeyPath: string;
  readonly worktree: string;
  readonly staticRoot: string;
};

function writeKeyPair(directory: string, name: string): { readonly privatePath: string; readonly publicPath: string } {
  const pair = generateKeyPairSync("ed25519");
  const privatePath = join(directory, `${name}.pem`);
  const publicPath = join(directory, `${name}.pub.pem`);
  writeFileSync(privatePath, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(publicPath, pair.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
  chmodSync(privatePath, 0o600);
  chmodSync(publicPath, 0o600);
  return { privatePath, publicPath };
}

export async function createFixtureEnv(staticRoot: string): Promise<FixtureEnv> {
  const tempRoot = mkdtempSync(join(tmpdir(), "jarvis-e2e-"));
  chmodSync(tempRoot, 0o700);
  const keysRoot = join(tempRoot, "keys");
  mkdirSync(keysRoot, { mode: 0o700 });
  chmodSync(keysRoot, 0o700);
  const decision = writeKeyPair(keysRoot, "decision");
  const verifier = writeKeyPair(keysRoot, "verifier");
  const worktree = join(tempRoot, "worktree");
  mkdirSync(worktree, { mode: 0o700 });
  const dbPath = join(tempRoot, "authority.sqlite");
  const db = new AuthorityDb(dbPath);
  await db.initialize({
    decision: { keyId: DECISION_KEY_ID, principal: DECISION_PRINCIPAL, publicKeyPath: decision.publicPath },
    verifier: { keyId: VERIFIER_KEY_ID, principal: VERIFIER_PRINCIPAL, publicKeyPath: verifier.publicPath },
  });
  return {
    tempRoot,
    dbPath,
    db,
    decisionKeyPath: decision.privatePath,
    verifierKeyPath: verifier.privatePath,
    worktree,
    staticRoot: resolve(staticRoot),
  };
}
