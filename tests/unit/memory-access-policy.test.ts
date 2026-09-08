import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFileMemoryAccessScopeResolver, type AuthenticatedMemorySession } from "../../src/memory-access-policy.js";
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
const now = new Date("2026-09-09T00:00:00.000Z");
const session: AuthenticatedMemorySession = { principal_id: "principal:owner", agent_id: "agent:test", session_id: "session:test",
  expires_at: "2026-09-09T00:00:20.000Z" };
const request = { method: "sb_search", arguments: { query: "memory", limit: 2 } };
const policy = { schema_version: 1, provider_instance_id: "provider:test", principal_id: "principal:owner",
  policy_revision: "policy:1", valid_from: now.toISOString(), valid_until: "2026-09-09T00:01:00.000Z",
  sessions: [{ agent_id: "agent:test", session_id: "session:test", projects: ["project:a"], methods: ["sb_read_page", "sb_search"] }] };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "memory-access-policy-")); folders.push(root);
  const path = join(root, "policy.json");
  const save = (value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  save(policy);
  return { path, root, save };
}
it("matches current session and explicit policy, refreshes changes, caps expiry", () => {
  const f = fixture(); let current: AuthenticatedMemorySession | undefined = session;
  const resolve = createFileMemoryAccessScopeResolver(f.path, "provider:test", () => current);
  expect(resolve(now, request)).toMatchObject({ projects: ["project:a"], valid_until: session.expires_at, policy_revision: "policy:1" });
  f.save({ ...policy, policy_revision: "policy:2" });
  expect(resolve(now, request)?.policy_revision).toBe("policy:2");
  f.save({ ...policy, sessions: [] });
  expect(resolve(now, request)).toBeUndefined();
  f.save(policy); current = undefined;
  expect(resolve(now, request)).toBeUndefined();
  current = { ...session, session_id: "session:other" };
  expect(resolve(now, request)).toBeUndefined();
});
it("rejects methods, wrong provider, expiry, duplicate and malformed grants", () => {
  const f = fixture(); const resolve = createFileMemoryAccessScopeResolver(f.path, "provider:test", () => session);
  expect(resolve(now, { ...request, method: "sb_remember" })).toBeUndefined();
  for (const changed of [{ ...policy, provider_instance_id: "other" }, { ...policy, valid_until: now.toISOString() },
    { ...policy, sessions: [...policy.sessions, ...policy.sessions] },
    { ...policy, sessions: [{ ...policy.sessions[0], projects: ["*"] }] }]) {
    f.save(changed); expect(resolve(now, request)).toBeUndefined();
  }
  f.save(policy);
  expect(resolve(new Date(session.expires_at), request)).toBeUndefined();
});
it("does not reuse old grants after file loss, corruption or unsafe permissions", () => {
  const f = fixture(); const resolve = createFileMemoryAccessScopeResolver(f.path, "provider:test", () => session);
  expect(resolve(now, request)).toBeDefined();
  unlinkSync(f.path); expect(resolve(now, request)).toBeUndefined();
  writeFileSync(f.path, '{"schema_version":1,"schema_version":1}', { mode: 0o600 });
  expect(resolve(now, request)).toBeUndefined();
  f.save(policy); chmodSync(f.path, 0o644);
  expect(resolve(now, request)).toBeUndefined();
  chmodSync(f.path, 0o600);
  const link = join(f.root, "link.json"); symlinkSync(f.path, link);
  expect(createFileMemoryAccessScopeResolver(link, "provider:test", () => session)(now, request)).toBeUndefined();
});
