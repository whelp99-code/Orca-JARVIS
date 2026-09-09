import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { MemoryAccessScopeResolver } from "./memory-access-claim-production.js";
import { parseSecondBrainStrictJsonBytes } from "./second-brain-strict-json.js";

export type AuthenticatedMemorySession = {
  readonly principal_id: "principal:owner";
  readonly agent_id: string;
  readonly session_id: string;
  readonly expires_at: string;
};
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function record(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(name => Object.hasOwn(value, name));
}
function instant(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : undefined;
}
function strings(value: unknown, valid: (item: string) => boolean): value is string[] {
  return Array.isArray(value) && value.length <= 64 && value.every(item => typeof item === "string" && valid(item))
    && new Set(value).size === value.length && [...value].sort().every((item, index) => item === value[index]);
}
function readPolicy(path: string): unknown {
  if (!isAbsolute(path)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0
      || (process.getuid !== undefined && before.uid !== process.getuid()) || before.size < 1 || before.size > 65_536) return undefined;
    const bytes = Buffer.alloc(65_537);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd); const entry = lstatSync(path);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || entry.isSymbolicLink() || entry.dev !== after.dev || entry.ino !== after.ino) return undefined;
    return parseSecondBrainStrictJsonBytes(bytes.subarray(0, length));
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Policy is operator-managed; getSession must return authenticated server state,
 * never request-body claims. No implicit grants and no cached last-good policy. */
function resolveFileScope(policyPath: string, provider: string,
  getSession: () => AuthenticatedMemorySession | undefined, at: Date, method: string, write: boolean): ReturnType<MemoryAccessScopeResolver> {
    const now = at.getTime(); const session = getSession();
    if (session === undefined || session.principal_id !== "principal:owner"
      || !id.test(session.agent_id) || !id.test(session.session_id) || !Number.isFinite(now)) return undefined;
    const sessionExpiry = instant(session.expires_at);
    if (sessionExpiry === undefined || sessionExpiry <= now) return undefined;
    const policy = readPolicy(policyPath);
    const version = typeof policy === "object" && policy !== null ? Reflect.get(policy, "schema_version") : undefined;
    if (write && version !== 3) return undefined;
    const agentPolicy = version === 2 || version === 3;
    const entries = agentPolicy ? "agents" : "sessions";
    if (!record(policy, ["schema_version", "provider_instance_id", "principal_id", "policy_revision", "valid_from", "valid_until", entries])
      || policy.schema_version !== (agentPolicy ? version : 1) || policy.provider_instance_id !== provider || policy.principal_id !== session.principal_id
      || typeof policy.policy_revision !== "string" || !id.test(policy.policy_revision)) return undefined;
    const rows = policy[entries];
    if (!Array.isArray(rows) || rows.length > 64) return undefined;
    const from = instant(policy.valid_from); const until = instant(policy.valid_until);
    if (from === undefined || until === undefined || !(from <= now && now < until)) return undefined;
    const seen = new Set<string>(); let selected: string[] | undefined;
    for (const row of rows) {
      if (!record(row, agentPolicy ? ["agent_id", "projects", "methods"] : ["agent_id", "session_id", "projects", "methods"])
        || typeof row.agent_id !== "string" || !id.test(row.agent_id)
        || (!agentPolicy && (typeof row.session_id !== "string" || !id.test(row.session_id)))
        || !strings(row.projects, item => item.startsWith("project:") && id.test(item) && id.test(item.slice(8)))
        || !strings(row.methods, item => item === "sb_read_page" || item === "sb_search" || item === "sb_generation_status" || (version === 3 && (item === "sb_write_request" || item === "sb_request_status")))) return undefined;
      const key = agentPolicy ? row.agent_id : `${row.agent_id}\0${row.session_id}`;
      if (seen.has(key)) return undefined;
      seen.add(key);
      if (row.agent_id === session.agent_id && (agentPolicy || row.session_id === session.session_id) && row.methods.includes(method)) {
        selected = row.projects;
      }
    }
    if (selected === undefined) return undefined;
    return { principal_id: session.principal_id, agent_id: session.agent_id, session_id: session.session_id,
      projects: [...selected], policy_revision: policy.policy_revision,
      valid_until: new Date(Math.min(until, sessionExpiry)).toISOString() };
}


const READ_METHODS = new Set(["sb_read_page", "sb_search", "sb_generation_status", "sb_request_status"]);

export function createFileMemoryAccessScopeResolver(policyPath: string, provider: string,
  getSession: () => AuthenticatedMemorySession | undefined): MemoryAccessScopeResolver {
  return (at, request) => READ_METHODS.has(request.method)
    ? resolveFileScope(policyPath, provider, getSession, at, request.method, false) : undefined;
}

export type AuthorizedMemoryWriteScope = NonNullable<ReturnType<MemoryAccessScopeResolver>> & {
  readonly method: "sb_write_request";
  readonly provider_instance_id: string;
};
export type MemoryWriteScopeResolver = (at: Date) => AuthorizedMemoryWriteScope | undefined;

/** Only policy v3 with explicit sb_write_request grants a write scope. This does
 * not issue a read claim, consume a review or authorize an unverified candidate. */
export function createFileMemoryWriteScopeResolver(policyPath: string, provider: string,
  getSession: () => AuthenticatedMemorySession | undefined): MemoryWriteScopeResolver {
  return at => {
    const scope = resolveFileScope(policyPath, provider, getSession, at, "sb_write_request", true);
    return scope === undefined ? undefined : Object.freeze({ ...scope,
      projects: Object.freeze([...scope.projects]), provider_instance_id: provider, method: "sb_write_request" as const });
  };
}
