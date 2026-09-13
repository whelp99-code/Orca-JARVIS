import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthorityDb } from "../../src/db.js";
import { ControlPlane, signCommandApproval } from "../../src/index.js";
import type { CommandApprovalReceipt } from "../../src/index.js";
import { localKey } from "../helpers.js";

export const FIXTURE_OWNER_PRINCIPAL = "principal:owner";
export const FIXTURE_DECISION_KEY_ID = "decision-fixture-owner";

type FixtureAnchor = { readonly key: KeyObject; readonly keyId: string; readonly principal: string };
const sealed = new Map<string, FixtureAnchor>();

/**
 * Seals a fixture database with a real decision anchor through the product's own initialization
 * path, keeping the private half so the fixture can sign the owner's approvals.
 *
 * Any ranked action needs an owner import decision behind its principle, so a database that is to
 * carry a recommendation has to hold genuine owner authority. Inserting the key rows by hand would
 * forge exactly the bootstrap the citation boundary later verifies.
 *
 * A database the harness already sealed keeps the anchor it was sealed with: forcing a second one
 * is refused by the product, and rightly so, so the fixture signs with that anchor instead.
 */
export async function sealFixtureAuthority(db: AuthorityDb): Promise<void> {
  if (sealed.has(db.filename)) { await db.migrate(); return; }
  await db.migrate();
  const existing = db.db.prepare(`SELECT k.key_id AS key_id, k.principal_id AS principal_id
    FROM trusted_authority_keys k JOIN authority_key_purposes p ON p.key_id=k.key_id
    WHERE p.purpose='decision' ORDER BY k.key_id LIMIT 1`).get() as
    { key_id: string; principal_id: string } | undefined;
  if (existing !== undefined) {
    sealed.set(db.filename, { key: localKey(db), keyId: existing.key_id, principal: existing.principal_id });
    return;
  }
  const decision = generateKeyPairSync("ed25519");
  const verifier = generateKeyPairSync("ed25519");
  const directory = await mkdtemp(join(tmpdir(), "jarvis-fixture-anchor-"));
  const anchor = async (name: string, key: KeyObject): Promise<string> => {
    const target = join(directory, `${name}.pub.pem`);
    await writeFile(target, key.export({ type: "spki", format: "pem" }));
    return target;
  };
  await db.initialize({
    decision: { keyId: FIXTURE_DECISION_KEY_ID, principal: FIXTURE_OWNER_PRINCIPAL,
      publicKeyPath: await anchor("decision", decision.publicKey) },
    verifier: { keyId: "verifier-fixture", principal: "fixture-independent-verifier",
      publicKeyPath: await anchor("verifier", verifier.publicKey) },
  });
  sealed.set(db.filename, { key: decision.privateKey, keyId: FIXTURE_DECISION_KEY_ID,
    principal: FIXTURE_OWNER_PRINCIPAL });
}

export type FixtureOwnerApproval = { readonly request_id: string; readonly command_digest: string };

/**
 * Decides one command this database already staged, with a receipt signed by its own anchor.
 *
 * A product path that stages its own command - a memory confirmation, say - needs the owner's
 * signature on that exact command, not on a request the fixture invented beside it. A receipt may
 * live at most fifteen minutes, so a longer command window is clamped rather than forged.
 */
export function decideFixtureOwnerCommand(db: AuthorityDb, command: {
  readonly request_id: string; readonly command_digest: string; readonly expires_at: string;
}, at: string): void {
  const anchor = sealed.get(db.filename);
  if (anchor === undefined) throw new TypeError("fixture authority must be sealed before deciding");
  const receiptExpires = new Date(Math.min(Date.parse(command.expires_at), Date.parse(at) + 600_000)).toISOString();
  new ControlPlane(db).decide(signCommandApproval({ schema_version: 1,
    receipt_id: `receipt:${command.request_id}`, request_id: command.request_id, decision: "approve",
    command_digest: command.command_digest, signer_principal_id: anchor.principal,
    authenticated_session_id: "owner-session", key_id: anchor.keyId, algorithm: "Ed25519",
    issued_at: at, not_before: at, expires_at: receiptExpires,
    nonce: `receipt-nonce-${command.request_id}`, max_uses: 1, status: "issued" }, anchor.key),
  new Date(at));
}

/**
 * Stages one control command and decides it with an owner-signed receipt, so an owner citation has
 * a real approval to resolve against. A command approval receipt may live at most fifteen minutes
 * while the request it decides outlives it, so the two windows are deliberately different.
 */
export function approveFixtureOwnerDecision(db: AuthorityDb, requestId: string,
  at: string): FixtureOwnerApproval {
  const anchor = sealed.get(db.filename);
  if (anchor === undefined) throw new TypeError("fixture authority must be sealed before approving");
  const shift = (ms: number): string => new Date(Date.parse(at) + ms).toISOString();
  const now = new Date(at);
  const control = new ControlPlane(db);
  const request = control.stage({ schema_version: 1, request_id: requestId, action: "workflow.start",
    action_level: 2, target: { environment: "local" },
    args: { run_id: `run-${requestId}`, loop_id: "loop-fixture", correlation_id: `corr-${requestId}`,
      input: {}, budget: { max_tokens: 1 } },
    reversible: true, requested_by: anchor.principal, requested_at: shift(-3_600_000),
    expires_at: shift(7_200_000), nonce: `nonce-${requestId}` }, now);
  const payload: Omit<CommandApprovalReceipt, "signature"> = { schema_version: 1,
    receipt_id: `receipt:${requestId}`, request_id: requestId, decision: "approve",
    command_digest: request.command_digest, signer_principal_id: anchor.principal,
    authenticated_session_id: "session:owner", key_id: anchor.keyId, algorithm: "Ed25519",
    issued_at: at, not_before: at, expires_at: shift(600_000),
    nonce: `receipt-nonce-${requestId}`, max_uses: 1, status: "issued" };
  control.decide(signCommandApproval(payload, anchor.key), now);
  return { request_id: requestId, command_digest: request.command_digest };
}
