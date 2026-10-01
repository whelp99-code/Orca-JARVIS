import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { JarvisError } from "../../src/jarvis-error.js";
import { memoryReadHighWater, signMemoryReadFence, signObservedMemoryReadFence } from "../../src/memory-read-fence.js";
import { PROVIDER_TOMBSTONE_REPLICA_DOMAIN, providerTombstoneLinkRoot } from "../../src/provider-tombstone-replica.js";
import { learnProviderTombstoneReplica } from "../../src/provider-tombstone-replica-learn.js";
import { MEMORY_TOMBSTONE_GENESIS_ROOT } from "../../src/second-brain-effect-v2.js";
import { isMemoryReadSuppressed } from "../../src/memory-read-privacy.js";
import { MemoryOutboxService } from "../../src/memory-outbox.js";
import { claimAction, evidence, FixtureReader, OUTBOX_ARTIFACT_DIGEST, outboxFixture } from "../fixtures/memory-outbox-fixture.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { MEMORY_NOW } from "../fixtures/memory-candidate-fixture.js";
import { task30Python } from "../fixtures/task30-provider-runtime.js";
import type { SecondBrainReadOutcome } from "../../src/second-brain-adapter-types.js";

const AT = "2026-09-27T01:02:03.000Z";
const PROVIDER = "provider:second-brain:linux";
const KEY_ID = "provider:second-brain:linux:c852ba9de1acb279";

function replica(privateKey: KeyObject) {
  const core = {
    sequence: 1, operation: "forget" as const, lane_id: "owner-effect:page",
    target_manifest_digest: `sha256:${"b".repeat(64)}`, scope_digest: `sha256:${"c".repeat(64)}`,
    authority_receipt_digest: `sha256:${"d".repeat(64)}`, payload_digest: `sha256:${"a".repeat(64)}`,
    keyed_subject_digest: "subject-digest-not-hmac", effective_at: AT,
    previous_root: MEMORY_TOMBSTONE_GENESIS_ROOT,
  };
  const set_root = providerTombstoneLinkRoot(core);
  const body = {
    schema_version: 1, kind: "provider_tombstone_replica", provider_instance_id: PROVIDER,
    signing_key_id: KEY_ID, issued_at: AT, sequence: 1, set_root,
    entries: [{ ...core, set_root, tombstone_id: `memtomb:v1:${set_root.slice(7)}` }],
    targets: [{
      sequence: 1, target_digest: `sha256:${"e".repeat(64)}`, source_identity_digest: "source-full",
      content_identity_digest: "content-full", citation_identity_digest: "citation-full",
      subject_identity_digest: "subject-digest-not-hmac", page_content_digest: `sha256:${"f".repeat(64)}`,
    }],
  };
  const signature = sign(null, Buffer.from(PROVIDER_TOMBSTONE_REPLICA_DOMAIN + canonicalize(body)), privateKey).toString("base64url");
  return { document: { ...body, signature }, set_root };
}

function pythonFenceCheck(fence: unknown, sequence: number, setRoot: string, publicKey: KeyObject): string {
  const raw = publicKey.export({ format: "der", type: "spki" });
  const script = `
import base64, json, sys
from cryptography.hazmat.primitives.serialization import load_der_public_key
from sb.delegations import DelegationRejected, verify_read_fence
from datetime import UTC, datetime
fence, sequence, set_root, der = json.loads(sys.stdin.read())
key = load_der_public_key(base64.b64decode(der))
try:
    verify_read_fence(fence, {fence["signing_key_id"]: key}, fence["provider_instance_id"],
        datetime(2026, 9, 27, 1, 2, 3, tzinfo=UTC), sequence, set_root)
except DelegationRejected as exc:
    print(str(exc))
else:
    print("ACCEPTED")
`;
  const result = spawnSync(task30Python(), ["-c", script], {
    input: JSON.stringify([fence, sequence, setRoot, Buffer.from(raw).toString("base64")]),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "python fence check failed");
  return result.stdout.trim();
}

describe("SB-originated tombstone read fence", () => {
  it("reproduces TOMBSTONE_SET_STALE, then settles a proved remember only after the replica is learned", async () => {
    const pair = generateKeyPairSync("ed25519");
    const readerKeys = generateKeyPairSync("ed25519");
    const built = replica(pair.privateKey);
    const fixture = await outboxFixture();
    const seen: SecondBrainReadOutcome[] = [];
    const reader = new FixtureReader({ kind: "current", checked_at: MEMORY_NOW, evidence: [evidence(OUTBOX_ARTIFACT_DIGEST)] });
    const accept = () => {
      const high = memoryReadHighWater(fixture.database.authority);
      return high.sequence === 1 && high.set_root === built.set_root;
    };
    reader.readPage = () => {
      const outcome: SecondBrainReadOutcome = accept()
        ? { kind: "current", checked_at: MEMORY_NOW, evidence: [evidence(OUTBOX_ARTIFACT_DIGEST)] }
        : { kind: "unavailable", code: "TOMBSTONE_SET_STALE", checked_at: MEMORY_NOW };
      seen.push(outcome);
      return Promise.resolve(outcome);
    };
    reader.recentChanges = () => reader.readPage();
    const service = new MemoryOutboxService({
      authority: fixture.database.authority, writer: fixture.writer, reader, clock: () => fixture.clock.now,
      artifactDeadlineMs: 30_000, leaseMs: 10_000,
      candidate_dispatch_spool_root: join(fixture.database.root, "candidate-dispatch"),
      candidate_review_spool_root: join(fixture.database.root, "candidate-review"),
    });
    try {
      const identity = {
        provider_instance_id: PROVIDER, signing_key_id: "jarvis-reader", private_key: readerKeys.privateKey, nonce: () => "fixed",
      };
      const genesis = signMemoryReadFence(identity, "memory_read", { sequence: 0, set_root: MEMORY_TOMBSTONE_GENESIS_ROOT }, new Date(AT));
      expect(pythonFenceCheck(genesis, 1, built.set_root, readerKeys.publicKey)).toBe("TOMBSTONE_SET_STALE");
      expect(() => signObservedMemoryReadFence(fixture.database.authority, identity, "memory_read",
        { sequence: 1, set_root: built.set_root }, new Date(AT))).toThrowError(new JarvisError("MEMORY_READ_FENCE_UNVERIFIED_HEAD"));
      const queued = service.enqueue(claimAction(fixture));
      const blocked = await service.runOnce("worker-stale", 1);
      expect(blocked.settled).toBe(0);
      expect(service.get(queued.outbox_id)?.state).toBe("reconciling");
      expect(seen.some(item => item.kind === "unavailable" && item.code === "TOMBSTONE_SET_STALE")).toBe(true);
      learnProviderTombstoneReplica(fixture.database.authority, built.document,
        new Map([[KEY_ID, pair.publicKey]]), AT, PROVIDER);
      const observed = signObservedMemoryReadFence(fixture.database.authority, identity, "memory_read",
        memoryReadHighWater(fixture.database.authority), new Date(AT));
      expect(pythonFenceCheck(observed, 1, built.set_root, readerKeys.publicKey)).toBe("ACCEPTED");
      const settled = await service.runOnce("worker-learned", 1);
      expect(settled.settled).toBe(1);
      expect(service.get(queued.outbox_id)?.state).toBe("settled");
      const suppressed = isMemoryReadSuppressed(fixture.database.authority, {
        ...evidence(OUTBOX_ARTIFACT_DIGEST), record: {
          record_id: "rec", record_digest: `sha256:${"1".repeat(64)}`, source_identity_full: "source-full",
          content_identity_full: "content-full", citation_identity_full: "citation-full",
          source_owner_class: "provider_owned", source_owner_id_digest: `sha256:${"2".repeat(64)}`,
          origin_label: "page", generation: {
            provider_instance_id: PROVIDER, generation_id: `sbgen:v1:${"3".repeat(64)}`,
            generation_manifest_digest: `sha256:${"4".repeat(64)}`, vault_head: "a".repeat(40), vault_tree: "b".repeat(40),
            tombstone_sequence: 1, tombstone_set_root: built.set_root,
          },
        },
      }, () => "unused");
      expect(suppressed).toBe(true);
    } finally { closeMemoryDatabase(fixture.database); }
  });
});
