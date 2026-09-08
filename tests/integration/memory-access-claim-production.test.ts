import { verify } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { createProductionMemoryAccessClaim, type AuthorizedMemoryReadScope } from "../../src/memory-access-claim-production.js";
import { revokeMemoryEffectDelegationKey } from "../../src/memory-effect-delegation.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { memoryReadFenceFixture } from "../fixtures/memory-read-fence.js";
import { OUTBOX_NOW } from "../fixtures/memory-outbox-fixture.js";
const databases: MemoryDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) closeMemoryDatabase(db); });
const scope: AuthorizedMemoryReadScope = { principal_id: "principal:owner", agent_id: "agent:test", session_id: "session:test",
  projects: ["project:a"], policy_revision: "policy:1", valid_until: new Date(OUTBOX_NOW.getTime() + 10_000).toISOString() };
const request = { method: "sb_read_page", arguments: { id: "wiki/test" } };

it("uses current authority and scope, bounds expiry, preserves existing trust IDs", async () => {
  const db = await memoryDatabase(); databases.push(db);
  const { config, publicKey } = memoryReadFenceFixture(db, undefined,
    { provider_instance_id: `provider:${"p".repeat(128)}`, signing_key_id: "jarvis.keys/owner.v1" });
  let current: AuthorizedMemoryReadScope | undefined = scope;
  const issue = createProductionMemoryAccessClaim(db.authority, config, () => current);
  const result = issue(request, OUTBOX_NOW);
  expect(result.access_claim.expires_at).toBe(scope.valid_until);
  const { signature, ...unsigned } = result.access_claim;
  expect(verify(null, Buffer.from("orca-jarvis/memory-access-claim/v1\0" + canonicalize(unsigned)), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  current = undefined;
  expect(() => issue(request, OUTBOX_NOW)).toThrow("MEMORY_ACCESS_SCOPE_UNAVAILABLE");
  current = scope;
  revokeMemoryEffectDelegationKey(db.authority, config.signing_key_id);
  expect(() => issue(request, OUTBOX_NOW)).toThrow("MEMORY_READ_FENCE_KEY_UNAVAILABLE");
});

it("refuses expired scopes, duplicate projects and resolver mutation of the request", async () => {
  const db = await memoryDatabase(); databases.push(db);
  const { config } = memoryReadFenceFixture(db);
  for (const invalid of [{ ...scope, projects: ["project:a", "project:a"] }, { ...scope, valid_until: OUTBOX_NOW.toISOString() }]) {
    expect(() => createProductionMemoryAccessClaim(db.authority, config, () => invalid)(request, OUTBOX_NOW)).toThrow("MEMORY_ACCESS_SCOPE_UNAVAILABLE");
  }
  const mutable = { method: request.method, arguments: { id: "wiki/test" } };
  const issue = createProductionMemoryAccessClaim(db.authority, config, () => { mutable.arguments.id = "wiki/other"; return scope; });
  expect(() => issue(mutable, OUTBOX_NOW)).toThrow("MEMORY_ACCESS_SCOPE_UNAVAILABLE");
});
