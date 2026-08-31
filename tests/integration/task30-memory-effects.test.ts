import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import {
  memoryEffectValidationOptions,
  registerMemoryEffectDelegationKey,
  registerMemoryProviderProofKey,
} from "../../src/memory-effect-delegation.js";
import { parseMemoryEffectRequest } from "../../src/memory-effect-write-request.js";
import { MemoryTombstoneChain } from "../../src/memory-tombstone-chain.js";
import type { MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";
import { tempDb } from "../helpers.js";

const contract = JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
  readonly vectors: { readonly correction: { readonly request: MemoryEffectWriteRequestV2 } };
};
const request = contract.vectors.correction.request;
function fixture<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("MEMORY_FIXTURE_INVALID");
  return value;
}
const tombstoneDelta = fixture(request.tombstone_chain_delta[0]);
const privateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
  ]),
  format: "der",
  type: "pkcs8",
});
const publicKey = createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString();
const NOW = new Date("2026-08-31T00:00:01.000Z");

async function database(): Promise<AuthorityDb> {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  return db;
}

describe("Task 30 proof-bound authority", () => {
  it("publishes the exact five forward architecture migrations", async () => {
    const db = await database();
    try {
      const migrations = (db.db.prepare(
        "SELECT id FROM schema_migrations WHERE id>='040_' ORDER BY id",
      ).all() as Array<{ readonly id: string }>).map(row => row.id);
      expect(migrations).toEqual([
        "040_memory_tombstone_authority.sql",
        "041_memory_correction_saga.sql",
        "042_memory_deletion_proof.sql",
        "043_memory_export_saga.sql",
        "044_memory_content_propagation.sql",
      ]);
      const tables = (db.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      ).all() as Array<{ readonly name: string }>).map(row => row.name);
      expect(tables).toEqual(expect.arrayContaining([
        "memory_tombstone_chain",
        "memory_tombstone_delegation_links",
        "memory_correction_requests",
        "memory_deletion_requests",
        "memory_export_requests",
        "memory_purge_jobs",
        "memory_surface_manifests",
      ]));
      expect(tables).not.toContain("memory_effect_requests");
    } finally { db.close(); }
  });

  it("appends one permanent tombstone and immediate content-free suppression", async () => {
    const db = await database();
    try {
      const chain = new MemoryTombstoneChain(db, Buffer.alloc(32, 7));
      const input = {
        operation: "correct" as const,
        lane_id: request.lane_id,
        targets: request.targets,
        target_manifest_digest: request.target_manifest_digest,
        scope_digest: request.scope_digest,
        authority_receipt_digest: tombstoneDelta.authority_receipt_digest,
        payload_digest: request.delegation.payload_digest,
        effective_at: request.created_at,
      };
      const first = chain.append(input);
      const replay = chain.append(input);
      expect(replay).toEqual({ ...first, replayed: true });
      expect(chain.highWater()).toEqual(first.high_water);
      expect(db.db.prepare("SELECT COUNT(*) AS count FROM memory_suppressions").get())
        .toEqual({ count: 1 });
      const physical = readFileSync(db.filename);
      const content = request.payload as { readonly content: string };
      expect(physical.includes(Buffer.from(content.content, "utf8"))).toBe(false);
      expect(() => db.db.prepare("DELETE FROM memory_tombstone_chain").run())
        .toThrow(/immutable memory tombstone chain/);
    } finally { db.close(); }
  });

  it("uses strict wire validation before cryptographic recomputation", async () => {
    const db = await database();
    try {
      registerMemoryEffectDelegationKey(db, { key_id: "jarvis:fixture",
        principal_id: "principal:owner", public_key_pem: publicKey,
        valid_from: "2026-08-31T00:00:00.000Z", valid_until: "2026-09-01T00:00:00.000Z" }, NOW);
      expect(parseMemoryEffectRequest(request,
        memoryEffectValidationOptions(db, NOW, "provider:fixture"))).toEqual(request);
      expect(parseMemoryEffectRequest({ ...request, unknown: true },
        memoryEffectValidationOptions(db, NOW, "provider:fixture"))).toBeUndefined();
    } finally { db.close(); }
  });

  it("pins provider proof keys to instance and release", async () => {
    const db = await database();
    try {
      expect(registerMemoryProviderProofKey(db, { key_id: "provider:fixture",
        provider_instance_id: "provider:fixture", provider_release_sha: "a".repeat(40),
        public_key_pem: publicKey, valid_from: "2026-08-31T00:00:00.000Z",
        valid_until: "2026-09-01T00:00:00.000Z" }, NOW)).toMatch(/^sha256:/);
      expect(db.db.prepare(
        "SELECT provider_instance_id,provider_release_sha,state FROM memory_provider_proof_keys",
      ).get()).toEqual({ provider_instance_id: "provider:fixture",
        provider_release_sha: "a".repeat(40), state: "active" });
    } finally { db.close(); }
  });
});
