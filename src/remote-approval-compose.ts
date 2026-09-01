import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ControlPlane } from "./control-plane.js";
import type { AuthorityDb } from "./db.js";
import { parsePersonalOsPolicy } from "./personal-os-policy.js";
import { RemoteApprovalService } from "./remote-approval.js";
import { ControlReceiptSigner } from "./remote-approval-signer.js";
import type { RemoteIngressResolver } from "./remote-approval-types.js";

const PLACEHOLDER_ORIGIN = "https://remote-approval.invalid";

function sealedDecision(db: AuthorityDb): { key_id: string; principal_id: string } | undefined {
  return db.db.prepare(
    `SELECT k.key_id, k.principal_id FROM trusted_authority_keys k
     JOIN authority_key_purposes p ON p.key_id=k.key_id
     WHERE p.purpose='decision' LIMIT 1`,
  ).get() as { key_id: string; principal_id: string } | undefined;
}

function productionResolver(): RemoteIngressResolver {
  return () => null;
}

export function composeRemoteApproval(db: AuthorityDb): RemoteApprovalService {
  const policy = parsePersonalOsPolicy(JSON.parse(readFileSync(resolve("config/personal-os-policy.json"), "utf8")));
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
  const pair = generateKeyPairSync("ed25519");
  const signer = new ControlReceiptSigner(
    pair.privateKey,
    sealed?.key_id ?? "unready-decision",
    sealed?.principal_id ?? "unready",
  );
  return new RemoteApprovalService({
    db,
    control: new ControlPlane(db),
    policy: { owner_principal: policy.owner_principal, remote_approval: policy.remote_approval },
    origin,
    rpId,
    signer,
    resolver: productionResolver(),
  });
}
