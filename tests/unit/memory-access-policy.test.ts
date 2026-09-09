import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFileMemoryAccessScopeResolver, createFileMemoryWriteScopeResolver, type AuthenticatedMemorySession } from "../../src/memory-access-policy.js";
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
it("applies explicit agent grants to fresh authenticated sessions without sharing their identities", () => {
  const f = fixture(); let current: AuthenticatedMemorySession | undefined = session;
  const base = Object.fromEntries(Object.entries(policy).filter(([key]) => key !== "sessions"));
  const grant = { agent_id: 'agent:test', projects: ['project:a'], methods: ['sb_read_page', 'sb_search'] };
  const v2 = { ...base, schema_version: 2, agents: [grant] };
  f.save(v2);
  const resolve = createFileMemoryAccessScopeResolver(f.path, 'provider:test', () => current);
  expect(resolve(now, request)).toMatchObject({ session_id: 'session:test', projects: ['project:a'], valid_until: session.expires_at });
  current = { ...session, session_id: 'session:new' };
  expect(resolve(now, request)).toMatchObject({ session_id: 'session:new', projects: ['project:a'] });
  current = { ...session, agent_id: 'agent:other' };
  expect(resolve(now, request)).toBeUndefined();
  current = undefined; expect(resolve(now, request)).toBeUndefined();
  current = session; expect(resolve(new Date(session.expires_at), request)).toBeUndefined();
  f.save({ ...v2, agents: [] }); expect(resolve(now, request)).toBeUndefined();
  f.save({ ...v2, agents: [{ ...grant, projects: ['project:b'] }] });
  expect(resolve(now, request)?.projects).toEqual(['project:b']);
  f.save(policy); current = { ...session, session_id: 'session:new' };
  expect(resolve(now, request)).toBeUndefined();
});
it("rejects mixed policy versions, duplicate agents and wildcard projects", () => {
  const f = fixture(); const resolve = createFileMemoryAccessScopeResolver(f.path, 'provider:test', () => session);
  const base = Object.fromEntries(Object.entries(policy).filter(([key]) => key !== "sessions"));
  const grant = { agent_id: 'agent:test', projects: ['project:a'], methods: ['sb_search'] };
  const v2 = { ...base, schema_version: 2, agents: [grant] };
  for (const invalid of [{ ...v2, sessions: policy.sessions }, { ...v2, schema_version: 4 },
    { ...v2, agents: [grant, grant] }, { ...v2, agents: [{ ...grant, session_id: 'session:test' }] },
    { ...v2, agents: [{ ...grant, projects: ['*'] }] }]) {
    f.save(invalid); expect(resolve(now, request)).toBeUndefined();
  }
});
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

it('requires explicit status method permission', () => {
  const f = fixture();
  const resolve = createFileMemoryAccessScopeResolver(f.path, 'provider:test', () => session);
  const status = { method: 'sb_generation_status', arguments: {} };
  expect(resolve(now, status)).toBeUndefined();
  f.save({ ...policy, sessions: [{ ...policy.sessions[0], methods: ['sb_generation_status', 'sb_read_page', 'sb_search'] }] });
  expect(resolve(now, status)?.session_id).toBe(session.session_id);
});

it("requires explicit v3 write grants and keeps read claims read-only", () => {
  const f = fixture(); let current: AuthenticatedMemorySession | undefined = session;
  const read = createFileMemoryAccessScopeResolver(f.path, "provider:test", () => current);
  const write = createFileMemoryWriteScopeResolver(f.path, "provider:test", () => current);
  expect(write(now)).toBeUndefined();
  const base = Object.fromEntries(Object.entries(policy).filter(([key]) => key !== "sessions"));
  const grant = { agent_id: "agent:test", projects: ["project:a"], methods: ["sb_search", "sb_write_request"] };
  f.save({ ...base, schema_version: 2, agents: [grant] });
  expect(write(now)).toBeUndefined(); expect(read(now, request)).toBeUndefined();
  f.save({ ...base, schema_version: 3, agents: [{ ...grant, methods: ["sb_search"] }] });
  expect(write(now)).toBeUndefined(); expect(read(now, request)).toBeDefined();
  f.save({ ...base, schema_version: 3, agents: [grant] });
  const scope = write(now);
  expect(scope).toMatchObject({ method: "sb_write_request", projects: ["project:a"], session_id: session.session_id });
  expect(Object.isFrozen(scope?.projects)).toBe(true);
  expect(read(now, { ...request, method: "sb_write_request" })).toBeUndefined();
  expect(read(now, request)).toBeDefined();
  current = { ...session, agent_id: "agent:other" }; expect(write(now)).toBeUndefined();
  current = session; expect(write(new Date(session.expires_at))).toBeUndefined();
  f.save({ ...base, schema_version: 3, agents: [] }); expect(write(now)).toBeUndefined();
});

it('requires an explicit v3 request-status grant and never grants a write from it', () => {
  const f = fixture();
  const read = createFileMemoryAccessScopeResolver(f.path, 'provider:test', () => session);
  const query = { method: 'sb_request_status', arguments: { request: {} } };
  expect(read(now, query)).toBeUndefined();
  const base = Object.fromEntries(Object.entries(policy).filter(([key]) => key !== 'sessions'));
  const grant = { agent_id: 'agent:test', projects: ['project:a'], methods: ['sb_request_status'] };
  f.save({ ...base, schema_version: 2, agents: [grant] });
  expect(read(now, query)).toBeUndefined();
  f.save({ ...base, schema_version: 3, agents: [grant] });
  expect(read(now, query)?.projects).toEqual(['project:a']);
  expect(createFileMemoryWriteScopeResolver(f.path, 'provider:test', () => session)(now)).toBeUndefined();
  f.save({ ...base, schema_version: 3, agents: [] });
  expect(read(now, query)).toBeUndefined();
});
