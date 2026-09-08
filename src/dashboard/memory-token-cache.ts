import { createHash, createHmac, randomBytes } from "node:crypto";
import type { SecondBrainEvidence } from "../second-brain-adapter-types.js";
import { createMemoryMembership } from "../memory-membership.js";
import type { MemoryMembership } from "../memory-read-privacy.js";

const TOKEN_TTL_MS = 300_000;
const TOKEN_CAPACITY = 256;
const DEFAULT_POLICY_DIGEST = `sha256:${createHash("sha256")
  .update("orca-jarvis/memory-ui-policy/v1\0").update("1").digest("hex")}`;
export type MemoryTokenSelection = {
  readonly token: string; readonly owner_session_id: string; readonly session_incarnation: string;
  readonly privacy_epoch: number; readonly policy_digest: string; readonly page_id: string;
  readonly record_id: string; readonly record_digest: string; readonly record_revision: string;
  readonly provider_instance_id: string; readonly generation_id: string;
  readonly generation_manifest_digest: string; readonly vault_head: string; readonly vault_tree: string;
  readonly tombstone_sequence: number; readonly tombstone_set_root: string;
  readonly sensitivity: SecondBrainEvidence["sensitivity"];
  readonly source_owner_class: "provider_owned" | "external_read_only";
  readonly source_identity_full: string; readonly content_identity_full: string;
  readonly citation_identity_full: string; readonly issued_at: string; readonly expires_at: string;
};
export type MemoryTokenAuthority = Partial<Pick<MemoryTokenSelection,
  "owner_session_id" | "session_incarnation" | "privacy_epoch" | "policy_digest"
  | "provider_instance_id" | "generation_id" | "generation_manifest_digest"
  | "vault_head" | "vault_tree" | "tombstone_sequence" | "tombstone_set_root"
  | "sensitivity" | "source_owner_class">>;
export class MemoryTokenCache {
  /** Insertion-order mutation is the bounded LRU cache's purpose. */
  private readonly entries = new Map<string, MemoryTokenSelection>();
  private readonly member: MemoryMembership;
  constructor(private readonly revisionKey: Buffer, private readonly clock: () => Date) {
    if (revisionKey.byteLength !== 32) throw new TypeError("MEMORY_TOKEN_CONFIG_INVALID");
    this.revisionKey = Buffer.from(revisionKey);
    this.member = createMemoryMembership(revisionKey);
  }
  issue(evidence: SecondBrainEvidence, sessionId: string, privacyEpoch: number,
    policyDigest = DEFAULT_POLICY_DIGEST, sessionIncarnation = sessionId): {
    readonly token: string; readonly record_revision: string;
  } | undefined {
    const binding = evidence.record;
    if (binding === null) return undefined;
    const issued = this.clock(); const expires = new Date(issued.getTime() + TOKEN_TTL_MS);
    const token = randomBytes(32).toString("base64url");
    const recordRevision = this.revision("record", sessionId,
      `${binding.record_id}\0${binding.record_digest}`);
    const selection: MemoryTokenSelection = { token, owner_session_id: sessionId,
      session_incarnation: sessionIncarnation, privacy_epoch: privacyEpoch, policy_digest: policyDigest,
      page_id: evidence.page_id, record_id: binding.record_id, record_digest: binding.record_digest,
      record_revision: recordRevision, provider_instance_id: binding.generation.provider_instance_id,
      generation_id: binding.generation.generation_id,
      generation_manifest_digest: binding.generation.generation_manifest_digest,
      vault_head: binding.generation.vault_head, vault_tree: binding.generation.vault_tree,
      tombstone_sequence: binding.generation.tombstone_sequence,
      tombstone_set_root: binding.generation.tombstone_set_root, sensitivity: evidence.sensitivity,
      source_owner_class: binding.source_owner_class, source_identity_full: binding.source_identity_full,
      content_identity_full: binding.content_identity_full, citation_identity_full: binding.citation_identity_full,
      issued_at: issued.toISOString(), expires_at: expires.toISOString() };
    this.entries.set(token, selection);
    while (this.entries.size > TOKEN_CAPACITY) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
    return { token, record_revision: recordRevision };
  }
  get(token: string, sessionId: string, privacyEpoch: number,
    authority?: MemoryTokenAuthority): MemoryTokenSelection | undefined;
  get(token: string, authority: MemoryTokenAuthority): MemoryTokenSelection | undefined;
  get(token: string, sessionOrAuthority: string | MemoryTokenAuthority,
    privacyEpoch?: number, authority: MemoryTokenAuthority = {}): MemoryTokenSelection | undefined {
    const entry = this.entries.get(token);
    if (entry === undefined) return undefined;
    this.entries.delete(token);
    const expected: MemoryTokenAuthority = typeof sessionOrAuthority === "string"
      ? { ...authority, owner_session_id: sessionOrAuthority, privacy_epoch: privacyEpoch }
      : sessionOrAuthority;
    if (!matchesAuthority(entry, expected) || this.clock().getTime() >= Date.parse(entry.expires_at)) {
      return undefined;
    }
    return entry;
  }
  clear(): void { this.entries.clear(); }
  membership(kind: "source" | "content" | "citation" | "record", value: string): string {
    return this.member(kind, value);
  }
  revision(kind: "query" | "record" | "origin" | "candidate" | "resource",
    sessionId: string, value: string): string {
    return `hmac-sha256:${createHmac("sha256", this.revisionKey)
      .update(`orca-jarvis/memory-outward-${kind}/v1\0`).update(sessionId).update("\0").update(value).digest("hex")}`;
  }
}

function matchesAuthority(
  entry: MemoryTokenSelection,
  expected: MemoryTokenAuthority,
): boolean {
  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && entry[key as keyof MemoryTokenSelection] !== value) return false;
  }
  return true;
}
