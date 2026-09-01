import { createPublicKey, type KeyObject } from "node:crypto";
import { signCommandApproval, type CommandApprovalReceipt } from "./control-plane.js";

export class ControlReceiptSigner {
  constructor(
    private readonly key: KeyObject,
    readonly keyId: string,
    readonly principalId: string,
  ) {}

  spkiPem(): string {
    return createPublicKey(this.key).export({ type: "spki", format: "pem" }).toString();
  }

  signVerifiedRemoteDecision(payload: Omit<CommandApprovalReceipt, "signature">): CommandApprovalReceipt {
    return signCommandApproval(payload, this.key);
  }
}
