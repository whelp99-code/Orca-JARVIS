import { randomUUID } from "node:crypto";
import { JarvisError } from "./db.js";
import type { TrustTier } from "./runner-trust.js";

export type CredentialHandle = {
  readonly handleId: string;
  readonly purpose: string;
  readonly expiresAt: string;
};

type StoredCredential = {
  readonly handleId: string;
  readonly purpose: string;
  readonly expiresAt: string;
  readonly secret: string;
  redeemed: boolean;
};

export class CredentialBroker {
  private readonly store = new Map<string, StoredCredential>();

  issue(purpose: string, secret: string, expiresAt: string): CredentialHandle {
    const handle: StoredCredential = { handleId: `cred_${randomUUID()}`, purpose, expiresAt, secret, redeemed: false };
    this.store.set(handle.handleId, handle);
    return { handleId: handle.handleId, purpose: handle.purpose, expiresAt: handle.expiresAt };
  }

  inspect(handleId: string): CredentialHandle {
    const stored = this.require(handleId);
    return { handleId: stored.handleId, purpose: stored.purpose, expiresAt: stored.expiresAt };
  }

  reveal(handleId: string, tier: TrustTier, actor: "executor" | "runner", now = new Date()): string {
    if (tier < 3) throw new JarvisError("CREDENTIAL_TIER_DENIED");
    if (actor !== "executor") throw new JarvisError("CREDENTIAL_RUNNER_DENIED");
    const stored = this.require(handleId);
    if (stored.redeemed) throw new JarvisError("CREDENTIAL_REDEEMED");
    if (Date.parse(stored.expiresAt) <= now.getTime()) throw new JarvisError("CREDENTIAL_EXPIRED");
    stored.redeemed = true;
    return stored.secret;
  }

  private require(handleId: string): StoredCredential {
    const stored = this.store.get(handleId);
    if (!stored) throw new JarvisError("CREDENTIAL_UNKNOWN");
    return stored;
  }
}
