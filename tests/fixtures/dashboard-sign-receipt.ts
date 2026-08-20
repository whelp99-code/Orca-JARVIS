import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { signCommandApproval, type CommandApprovalReceipt } from "../../src/control-plane.js";
import { DECISION_KEY_ID, DECISION_PRINCIPAL } from "./dashboard-fixture-ids.js";
import { loadControlCommand } from "./dashboard-fingerprint.js";

export type SignFixtureReceiptInput = {
  readonly dbPath: string;
  readonly decisionKeyPath: string;
  readonly requestId: string;
  readonly decision: "approve" | "reject";
  readonly now?: Date;
  readonly untrusted?: boolean;
};

function decisionKey(path: string): KeyObject {
  return createPrivateKey(readFileSync(path, "utf8"));
}

export function signFixtureReceipt(input: SignFixtureReceiptInput): CommandApprovalReceipt {
  const now = input.now ?? new Date();
  const command = loadControlCommand(input.dbPath, input.requestId);
  const issued = now.toISOString();
  const receiptWindow = new Date(now.getTime() + 15 * 60_000).toISOString();
  const expiresAt = Date.parse(receiptWindow) <= Date.parse(command.expires_at)
    ? receiptWindow
    : command.expires_at;
  const key = input.untrusted === true
    ? generateKeyPairSync("ed25519").privateKey
    : decisionKey(input.decisionKeyPath);
  return signCommandApproval({
    schema_version: 1,
    receipt_id: `${input.decision}-${command.request_id}-${now.getTime()}`,
    request_id: command.request_id,
    decision: input.decision,
    command_digest: command.command_digest,
    signer_principal_id: DECISION_PRINCIPAL,
    authenticated_session_id: `e2e-session-${command.request_id}`,
    key_id: DECISION_KEY_ID,
    algorithm: "Ed25519",
    issued_at: issued,
    not_before: issued,
    expires_at: expiresAt,
    nonce: `e2e-approval-${command.request_id}-${now.getTime()}`,
    max_uses: 1,
    status: "issued",
  }, key);
}
