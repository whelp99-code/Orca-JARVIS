import { createHash } from "node:crypto";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import type { SuppressedProjection } from "./memory-compaction-sanitize.js";

const AUTHORITY_TABLES = [
  "memory_tombstone_chain",
  "memory_tombstone_delegation_links",
  "memory_suppressions",
  "memory_resolved_target_metadata",
  "memory_projection_authority",
  "memory_projection_dependencies",
  "memory_projection_suppressions",
  "memory_projection_quarantine",
  "memory_suppression_events",
] as const;

export function restoreBlockedProjections(
  source: AuthorityDb,
  current: AuthorityDb,
): readonly SuppressedProjection[] {
  current.db.prepare("ATTACH DATABASE ? AS restore_source").run(source.filename);
  try {
    const rows = current.db.prepare(
      `SELECT DISTINCT d.projection_kind AS kind,d.projection_id AS id,d.component_id
       FROM restore_source.memory_projection_dependencies d JOIN memory_suppressions s ON
         d.target_digest=s.target_digest
         OR (d.source_identity_digest IS NOT NULL
           AND d.source_identity_digest=s.source_identity_digest)
         OR (d.content_identity_digest IS NOT NULL
           AND d.content_identity_digest=s.content_identity_digest)
         OR (d.citation_identity_digest IS NOT NULL
           AND d.citation_identity_digest=s.citation_identity_digest)
       WHERE s.state='active'
       UNION
       SELECT 'candidate' AS kind,c.candidate_id AS id,c.candidate_id AS component_id
       FROM restore_source.memory_candidates c JOIN memory_suppressions s ON
         replace(c.content_digest,'sha256:','')=replace(s.content_identity_digest,'sha256:','')
       WHERE s.state='active'
       ORDER BY kind,id,component_id`,
    ).all();
    return [...rows.map(projectionRow), ...blockedOutboxes(source, current),
      ...blockedControls(source, current)];
  } finally {
    current.db.exec("DETACH DATABASE restore_source");
  }
}

export function applyCurrentRestoreAuthority(current: AuthorityDb, candidate: AuthorityDb): void {
  const triggers = candidate.db.prepare(
    "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL ORDER BY name",
  ).all().map(value => {
    if (value === null || typeof value !== "object") throw new JarvisError("MEMORY_RESTORE_SCHEMA_INVALID");
    const name = Reflect.get(value, "name"); const sql = Reflect.get(value, "sql");
    if (typeof name !== "string" || typeof sql !== "string") {
      throw new JarvisError("MEMORY_RESTORE_SCHEMA_INVALID");
    }
    return { name, sql };
  });
  candidate.db.pragma("foreign_keys=OFF");
  for (const trigger of triggers) candidate.db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
  candidate.db.prepare("ATTACH DATABASE ? AS current_authority").run(current.filename);
  try {
    for (const table of AUTHORITY_TABLES) {
      const columns = candidate.db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all().flatMap(value => {
        if (value === null || typeof value !== "object") return [];
        const name = Reflect.get(value, "name"); const hidden = Reflect.get(value, "hidden");
        return typeof name === "string" && hidden === 0 ? [name] : [];
      });
      const list = columns.map(quote).join(",");
      candidate.db.exec(`DELETE FROM ${quote(table)}`);
      candidate.db.exec(`INSERT INTO ${quote(table)}(${list})
        SELECT ${list} FROM current_authority.${quote(table)}`);
    }
  } finally {
    candidate.db.exec("DETACH DATABASE current_authority");
  }
  for (const trigger of triggers) candidate.db.exec(trigger.sql);
  candidate.db.pragma("foreign_keys=ON");
  if ((candidate.db.pragma("foreign_key_check") as readonly unknown[]).length !== 0
    || String(candidate.db.pragma("integrity_check", { simple: true })) !== "ok") {
    throw new JarvisError("MEMORY_RESTORE_INTEGRITY_INVALID");
  }
}

function blockedOutboxes(
  source: AuthorityDb,
  current: AuthorityDb,
): readonly SuppressedProjection[] {
  // memory_outbox carries no request content, so an outbox row is matched by the
  // source identity of its candidate; content-identity suppression is enforced by
  // the projection layer that owns the only copy of the bytes.
  const blockedSources = blockedSourceIdentities(current);
  return source.db.prepare("SELECT outbox_id,candidate_id FROM memory_outbox").all().flatMap(value => {
    if (value === null || typeof value !== "object") return [];
    const id = Reflect.get(value, "outbox_id"); const candidateId = Reflect.get(value, "candidate_id");
    if (typeof id !== "string" || typeof candidateId !== "string") return [];
    const sourceMatch = blockedSources.has(createHash("sha256").update(candidateId).digest("hex"));
    return sourceMatch ? [{ kind: "outbox", id, component_id: id }] : [];
  });
}

function blockedControls(
  source: AuthorityDb,
  current: AuthorityDb,
): readonly SuppressedProjection[] {
  const blocked = blockedContentIdentities(current);
  const blockedSources = blockedSourceIdentities(current);
  return source.db.prepare(
    "SELECT request_id,args_json FROM control_command_requests",
  ).all().flatMap(value => {
    if (value === null || typeof value !== "object") return [];
    const id = Reflect.get(value, "request_id"); const encoded = Reflect.get(value, "args_json");
    if (typeof id !== "string" || typeof encoded !== "string") return [];
    const parsed: unknown = JSON.parse(encoded);
    const content = requestContent(parsed); const candidateId = requestCandidateId(parsed);
    const contentMatch = content !== undefined && candidateId !== undefined
      && contentIdentities(content, candidateId).some(identity => blocked.has(identity));
    const sourceMatch = candidateId !== undefined
      && blockedSources.has(createHash("sha256").update(candidateId).digest("hex"));
    return contentMatch || sourceMatch ? [{ kind: "restore_control", id, component_id: id }] : [];
  });
}

function blockedContentIdentities(current: AuthorityDb): ReadonlySet<string> {
  return new Set(current.db.prepare(
    "SELECT content_identity_digest FROM memory_suppressions WHERE state='active'",
  ).all().flatMap(value => {
    const observed = value !== null && typeof value === "object"
      ? Reflect.get(value, "content_identity_digest") : undefined;
    return typeof observed === "string" ? [observed.replace(/^sha256:/, "")] : [];
  }));
}

function contentIdentities(content: string, candidateId: string): readonly string[] {
  const citation = createHash("sha256").update(candidateId).digest("hex").slice(0, 16);
  return [content, `${content} [^${citation}]`]
    .map(value => createHash("sha256").update(value).digest("hex"));
}

function blockedSourceIdentities(current: AuthorityDb): ReadonlySet<string> {
  return new Set(current.db.prepare(
    "SELECT source_identity_digest FROM memory_suppressions WHERE state='active'",
  ).all().flatMap(value => {
    const observed = value !== null && typeof value === "object"
      ? Reflect.get(value, "source_identity_digest") : undefined;
    return typeof observed === "string" ? [observed.replace(/^sha256:/, "")] : [];
  }));
}

function requestCandidateId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const nested = Reflect.get(value, "request");
  const request = nested !== null && typeof nested === "object" ? nested : value;
  const candidateId = Reflect.get(request, "candidate_id");
  return typeof candidateId === "string" ? candidateId : undefined;
}

function requestContent(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const nested = Reflect.get(value, "request");
  const request = nested !== null && typeof nested === "object" ? nested : value;
  const payload = Reflect.get(request, "payload");
  if (payload === null || typeof payload !== "object") return undefined;
  const content = Reflect.get(payload, "content");
  return typeof content === "string" ? content : undefined;
}

function projectionRow(value: unknown): SuppressedProjection {
  if (value === null || typeof value !== "object") throw new JarvisError("MEMORY_RESTORE_INVENTORY_INCOMPLETE");
  const kind = Reflect.get(value, "kind"); const id = Reflect.get(value, "id");
  const component = Reflect.get(value, "component_id");
  if (typeof kind !== "string" || typeof id !== "string" || typeof component !== "string") {
    throw new JarvisError("MEMORY_RESTORE_INVENTORY_INCOMPLETE");
  }
  return { kind, id, component_id: component };
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
