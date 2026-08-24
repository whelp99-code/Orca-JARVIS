import { createHash } from "node:crypto";

export const CHANNELS = ["telegram", "discord", "slack"] as const;
export type ChannelName = (typeof CHANNELS)[number];
export const INTERACTIVE_OPS = ["edit", "delete", "reaction", "file", "interactive"] as const;
export type InteractiveOp = (typeof INTERACTIVE_OPS)[number];

export type InboundEnvelope = {
  readonly channel: ChannelName;
  readonly account: string;
  readonly sender: string;
  readonly thread: string;
  readonly message: string;
  readonly generation: string;
  readonly content: string;
};

export type AuthorityIngress = {
  commit(key: string): { readonly requestId: string; readonly created: boolean };
};

export type ChannelCapability = {
  readonly channel: ChannelName;
  readonly operations: readonly InteractiveOp[];
};

export type LegacyEffectClaim = {
  readonly claimId: string;
  readonly state: "pending" | "inflight" | "completed";
  readonly mappedRequestId?: string;
};

export function ingressIdempotencyKey(envelope: InboundEnvelope): string {
  const digest = createHash("sha256").update(envelope.content).digest("hex");
  return createHash("sha256").update([
    envelope.channel,
    envelope.account,
    envelope.sender,
    envelope.thread,
    envelope.message,
    envelope.generation,
    digest,
  ].join("\0")).digest("hex");
}

export class MemoryAuthorityIngress implements AuthorityIngress {
  private readonly keys = new Map<string, string>();
  commit(key: string): { readonly requestId: string; readonly created: boolean } {
    const existing = this.keys.get(key);
    if (existing) return { requestId: existing, created: false };
    const requestId = `req_${this.keys.size + 1}`;
    this.keys.set(key, requestId);
    return { requestId, created: true };
  }
  get size(): number { return this.keys.size; }
}

export class ChannelBridge {
  private readonly outbox: string[] = [];
  private readonly shellPersisted = new Set<string>();
  private persistShell = true;
  constructor(
    private readonly authority: AuthorityIngress,
    private readonly capabilities: readonly ChannelCapability[],
  ) {}

  setShellPersist(enabled: boolean): void {
    this.persistShell = enabled;
  }

  ingest(envelope: InboundEnvelope): { readonly requestId: string; readonly replayed: boolean; readonly acked: boolean } {
    const key = ingressIdempotencyKey(envelope);
    const committed = this.authority.commit(key);
    const deliveryKey = `deliver:${key}`;
    this.outbox.push(deliveryKey);
    const acked = this.persistShell;
    if (this.persistShell) this.shellPersisted.add(key);
    return { requestId: committed.requestId, replayed: !committed.created, acked };
  }

  redeliver(envelope: InboundEnvelope): { readonly requestId: string; readonly replayed: boolean } {
    const result = this.ingest(envelope);
    return { requestId: result.requestId, replayed: result.replayed };
  }

  invoke(channel: ChannelName, operation: InteractiveOp, fallback: "none" | "text" = "none"): { readonly ok: boolean; readonly code: string } {
    const cap = this.capabilities.find(item => item.channel === channel);
    if (cap?.operations.includes(operation)) return { ok: true, code: "ok" };
    if (fallback === "text") return { ok: true, code: "text_fallback" };
    return { ok: false, code: "unsupported" };
  }

  resolveCallback(expected: InboundEnvelope, actual: InboundEnvelope): { readonly ok: boolean; readonly code: string; readonly jarvisCalled: boolean } {
    const same = ingressIdempotencyKey(expected) === ingressIdempotencyKey({ ...actual, content: expected.content });
    if (!same) return { ok: false, code: "CALLBACK_IDENTITY_MISMATCH", jarvisCalled: false };
    this.authority.commit(ingressIdempotencyKey(actual));
    return { ok: true, code: "ok", jarvisCalled: true };
  }

  inventoryLegacy(claims: readonly LegacyEffectClaim[]): readonly { readonly claimId: string; readonly result: "mapped" | "blocked" }[] {
    return claims.filter(claim => claim.state !== "completed").map(claim => ({
      claimId: claim.claimId,
      result: claim.mappedRequestId ? "mapped" as const : "blocked" as const,
    }));
  }
}
