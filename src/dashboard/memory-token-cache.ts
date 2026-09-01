import { createHmac, randomBytes } from "node:crypto";
import type { SecondBrainEvidence } from "../second-brain-adapter-types.js";

const TOKEN_TTL_MS = 300_000;
const TOKEN_CAPACITY = 256;
export type MemoryTokenSelection = {
  readonly token: string; readonly session_id: string; readonly privacy_epoch: number;
  readonly page_id: string; readonly record_id: string; readonly record_digest: string;
  readonly issued_at: string; readonly expires_at: string;
};
export class MemoryTokenCache {
  /** Insertion-order mutation is the bounded LRU cache's purpose. */
  private readonly entries = new Map<string, MemoryTokenSelection>();
  constructor(private readonly revisionKey: Buffer, private readonly clock: () => Date) {
    if (revisionKey.byteLength !== 32) throw new TypeError("MEMORY_TOKEN_CONFIG_INVALID");
  }
  issue(evidence: SecondBrainEvidence, sessionId: string, privacyEpoch: number): {
    readonly token: string; readonly record_revision: string;
  } | undefined {
    const binding = evidence.record;
    if (binding === null) return undefined;
    const issued = this.clock(); const expires = new Date(issued.getTime() + TOKEN_TTL_MS);
    const token = randomBytes(32).toString("base64url");
    const selection: MemoryTokenSelection = { token, session_id: sessionId, privacy_epoch: privacyEpoch,
      page_id: evidence.page_id, record_id: binding.record_id, record_digest: binding.record_digest,
      issued_at: issued.toISOString(), expires_at: expires.toISOString() };
    this.entries.set(token, selection);
    while (this.entries.size > TOKEN_CAPACITY) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
    return { token, record_revision: this.revision("record", sessionId,
      `${binding.record_id}\0${binding.record_digest}`) };
  }
  get(token: string, sessionId: string, privacyEpoch: number): MemoryTokenSelection | undefined {
    const entry = this.entries.get(token);
    if (entry === undefined || entry.session_id !== sessionId || entry.privacy_epoch !== privacyEpoch
      || this.clock().getTime() >= Date.parse(entry.expires_at)) {
      this.entries.delete(token); return undefined;
    }
    this.entries.delete(token); this.entries.set(token, entry); return entry;
  }
  clear(): void { this.entries.clear(); }
  revision(kind: "query" | "record" | "origin" | "candidate" | "resource",
    sessionId: string, value: string): string {
    return `hmac-sha256:${createHmac("sha256", this.revisionKey)
      .update(`orca-jarvis/memory-outward-${kind}/v1\0`).update(sessionId).update("\0").update(value).digest("hex")}`;
  }
}
