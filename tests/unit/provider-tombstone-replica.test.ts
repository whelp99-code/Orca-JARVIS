import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { AuthorityDb } from "../../src/db.js";
import { JarvisError } from "../../src/jarvis-error.js";
import { MEMORY_TOMBSTONE_GENESIS_ROOT } from "../../src/second-brain-effect-v2.js";
import {
  PROVIDER_TOMBSTONE_REPLICA_DOMAIN, learnProviderTombstoneReplica, providerTombstoneLinkRoot,
  verifyProviderTombstoneChain, verifyProviderTombstoneReplica, type ProviderTombstoneReplica,
} from "../../src/provider-tombstone-replica.js";
import { tempDb } from "../helpers.js";

const AT = "2026-09-27T01:02:03.000Z";
const DIGEST = (nibble: string) => `sha256:${nibble.repeat(64)}`;

function link(sequence: number, previous: string, payload = DIGEST("a")) {
  const core = {
    sequence, operation: "forget" as const, lane_id: `owner-effect:${sequence}`,
    target_manifest_digest: DIGEST("b"), scope_digest: DIGEST("c"),
    authority_receipt_digest: DIGEST("d"), payload_digest: payload,
    keyed_subject_digest: "subject-digest-not-hmac", effective_at: AT, previous_root: previous,
  };
  const set_root = providerTombstoneLinkRoot(core);
  return { ...core, set_root, tombstone_id: `memtomb:v1:${set_root.slice(7)}` };
}

function target(sequence: number) {
  return {
    sequence, target_digest: DIGEST("e"), source_identity_digest: "source-full",
    content_identity_digest: "content-full", citation_identity_digest: "citation-full",
    subject_identity_digest: "subject-digest-not-hmac", page_content_digest: DIGEST("f"),
  };
}

function document(entries: ReturnType<typeof link>[], declared: { sequence: number; set_root: string },
  privateKey: KeyObject, signing_key_id = "provider:second-brain:linux:c852ba9de1acb279"): ProviderTombstoneReplica {
  const body = {
    schema_version: 1 as const, kind: "provider_tombstone_replica" as const,
    provider_instance_id: "provider:second-brain:linux", signing_key_id, issued_at: AT,
    sequence: declared.sequence, set_root: declared.set_root, entries, targets: entries.map(entry => target(entry.sequence)),
  };
  const signature = sign(null, Buffer.from(PROVIDER_TOMBSTONE_REPLICA_DOMAIN + canonicalize(body)), privateKey).toString("base64url");
  return { ...body, signature };
}

describe("provider tombstone replica verification", () => {
  const keys = generateKeyPairSync("ed25519");
  const map = new Map<string, KeyObject>([["provider:second-brain:linux:c852ba9de1acb279", keys.publicKey]]);
  const first = link(1, MEMORY_TOMBSTONE_GENESIS_ROOT);

  it("rejects a tampered link, a gap, a stale tip, and a wrong signature", () => {
    const tampered = { ...first, payload_digest: DIGEST("9") };
    expect(() => verifyProviderTombstoneChain([tampered], { sequence: 1, set_root: first.set_root }))
      .toThrowError(new JarvisError("PROVIDER_TOMBSTONE_REPLICA_TAMPERED"));
    const skipped = link(2, first.set_root);
    expect(() => verifyProviderTombstoneChain([skipped], { sequence: 1, set_root: skipped.set_root }))
      .toThrowError(new JarvisError("PROVIDER_TOMBSTONE_REPLICA_GAP"));
    const stale = document([first], { sequence: 0, set_root: MEMORY_TOMBSTONE_GENESIS_ROOT }, keys.privateKey);
    expect(() => verifyProviderTombstoneReplica(stale, map)).toThrowError(new JarvisError("PROVIDER_TOMBSTONE_REPLICA_STALE"));
    const signed = document([first], { sequence: 1, set_root: first.set_root }, keys.privateKey);
    expect(() => verifyProviderTombstoneReplica({ ...signed, signature: `${"A".repeat(86)}` }, map))
      .toThrowError(new JarvisError("PROVIDER_TOMBSTONE_REPLICA_SIGNATURE_INVALID"));
    expect(verifyProviderTombstoneReplica(signed, map).set_root).toBe(first.set_root);
  });

  it("records a verified replica and refuses a second different head", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate();
    try {
      const signed = document([first], { sequence: 1, set_root: first.set_root }, keys.privateKey);
      expect(learnProviderTombstoneReplica(db, signed, map, AT)).toEqual({ sequence: 1, set_root: first.set_root });
      expect(learnProviderTombstoneReplica(db, signed, map, AT)).toEqual({ sequence: 1, set_root: first.set_root });
      const second = link(2, first.set_root, DIGEST("1"));
      const extended = document([first, second], { sequence: 2, set_root: second.set_root }, keys.privateKey);
      expect(() => learnProviderTombstoneReplica(db, extended, map, AT)).toThrowError(new JarvisError("PROVIDER_TOMBSTONE_REPLICA_CONFLICT"));
    } finally { db.close(); }
  });
});
