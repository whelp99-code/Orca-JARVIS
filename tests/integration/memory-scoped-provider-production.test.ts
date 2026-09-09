import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createProductionScopedProviderVerifier } from "../../src/memory-scoped-provider-production.js";
import { registerMemoryScopedOutbox } from "../../src/memory-scoped-outbox.js";
import { claimMemoryScopedOutbox, markMemoryScopedOutboxDispatch } from "../../src/memory-scoped-outbox-worker.js";
import { scopedOutboxFixture } from "../fixtures/scoped-outbox.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";

it("uses the server session and current policy on every provider verification", async () => {
  const f = await scopedOutboxFixture();
  try {
    const r = registerMemoryScopedOutbox(f.options, f.claimed), options = { ...f.options, roots: f.dispatch.roots };
    const lease = claimMemoryScopedOutbox(options, r.outbox_id, "worker:fixture", 1000)!;
    const dispatched = markMemoryScopedOutboxDispatch(options, lease, 30000);
    const policyPath = join(f.database.root, "write-policy.json");
    const policy = { schema_version: 3, provider_instance_id: "provider:fixture", principal_id: "principal:owner",
      policy_revision: "policy:1", valid_from: f.now.toISOString(), valid_until: dispatched.request.expires_at,
      agents: [{ agent_id: "agent:fixture", projects: ["project:a"], methods: ["sb_write_request"] }] };
    writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 });
    let session = { principal_id: "principal:owner" as const, agent_id: "agent:fixture", session_id: "session:fixture",
      expires_at: dispatched.request.expires_at };
    let authenticated = true;
    const verify = createProductionScopedProviderVerifier(f.database.authority, { policy_path: policyPath,
      provider_instance_id: "provider:fixture", spool_root: f.options.spoolRoot, roots: f.dispatch.roots,
      authenticated_session: () => authenticated ? session : undefined, clock: () => f.now });
    expect(verify(dispatched.request).kind).toBe("current_scoped_dispatch");
    session = { ...session, session_id: "session:other" };
    expect(() => verify(dispatched.request)).toThrow();
    session = { ...session, session_id: "session:fixture" };
    authenticated = false;
    expect(() => verify(dispatched.request)).toThrow();
    authenticated = true;
    writeFileSync(policyPath, JSON.stringify({ ...policy, agents: [] }));
    expect(() => verify(dispatched.request)).toThrow();
    expect(f.database.authority.db.prepare("SELECT state FROM memory_outbox").get()).toEqual({ state: "dispatching" });
    expect(f.database.authority.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { closeMemoryDatabase(f.database); }
});
