import type { ControlReceiptSigner } from "./remote-approval-signer.js";
import type { RemoteApprovalStore } from "./remote-approval-store.js";

/** `file`: a provisioned key loaded; `unconfigured`: no path; `rejected`: a path whose file the loader refused. */
export type SignerSource = "file" | "unconfigured" | "rejected";

export type RemoteReadiness = Readonly<{ remote_ready: boolean; reason: string | null }>;

export type ReadinessInput = Readonly<{
  store: RemoteApprovalStore;
  signer: ControlReceiptSigner;
  signerSource: SignerSource;
}>;

function assertNeverSigner(value: never): never {
  throw new Error(`unexpected signer source ${JSON.stringify(value)}`);
}

/** Whether the store and the decision signer can mint a receipt, and why not when they cannot. */
export function classifyReadiness(input: ReadinessInput): RemoteReadiness {
  const counts = input.store.quarantineCounts();
  if (counts.remote_principals_count + counts.webauthn_credentials_count
    + counts.webauthn_challenges_count + counts.webauthn_assertions_count !== 0) {
    return { remote_ready: false, reason: "legacy_quarantine" };
  }
  switch (input.signerSource) {
    case "unconfigured": return { remote_ready: false, reason: "signer_unconfigured" };
    case "rejected": return { remote_ready: false, reason: "signer_rejected" };
    case "file": break;
    default: return assertNeverSigner(input.signerSource);
  }
  const sealed = input.store.sealedDecision(input.signer.keyId);
  if (!sealed) return { remote_ready: false, reason: "signer_unsealed" };
  if (sealed.principal_id !== input.signer.principalId || sealed.public_key_pem !== input.signer.spkiPem()) {
    return { remote_ready: false, reason: "signer_mismatch" };
  }
  return { remote_ready: true, reason: null };
}
