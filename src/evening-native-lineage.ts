import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { invalidCloseout } from "./evening-closeout-parse-values.js";
import type { readEveningNativeSource } from "./evening-native-source.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import type { MemoryProjectionDependency, MemoryProjectionRef } from "./memory-projection-types.js";
import { isMemorySuppressed } from "./memory-suppression.js";

type Row = Record<string, string | null>;
const columns = "target_digest,keyed_subject_digest,source_identity_digest,content_identity_digest,citation_identity_digest,source_context_id";
const dependency = (row: Row): MemoryProjectionDependency => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));

/** Requires recorded control-payload provenance; legacy untracked task sources stay unavailable. */
export function nativeEveningDependencies(db: AuthorityDb, source: ReturnType<typeof readEveningNativeSource>) {
  const projections = new MemoryProjectionAuthority(db);
  const result = new Map<string, MemoryProjectionDependency>();
  for (const { completion, proof } of source.records) {
    const requestId = proof.request.request_id;
    if (!projections.hasLineage({ kind: "control_payload", id: requestId, component_id: requestId })) return invalidCloseout();
    const ids = [...new Set([requestId, completion.run_id, completion.completion_id,
      completion.publication_id, completion.verification_id, completion.artifact_id])];
    if (ids.some(id => projections.isProjectionIdSuppressed(id))) return invalidCloseout();
    const rows = db.db.prepare(`SELECT ${columns} FROM memory_projection_dependencies
      WHERE projection_id IN (${ids.map(() => "?").join(",")}) LIMIT 1025`).all(...ids) as Row[];
    if (rows.length === 0 || rows.length > 1024) return invalidCloseout();
    for (const row of rows) {
      const value = dependency(row);
      if (isMemorySuppressed(db, value)) return invalidCloseout();
      result.set(canonicalize(value), value);
      if (result.size > 1024) return invalidCloseout();
    }
  }
  return [...result.values()];
}

export function bindNativeEvening(db: AuthorityDb, refs: readonly MemoryProjectionRef[],
  dependencies: readonly MemoryProjectionDependency[], at: Date): void {
  const projections = new MemoryProjectionAuthority(db);
  for (const value of dependencies) if (isMemorySuppressed(db, value)) return invalidCloseout();
  for (const ref of refs) {
    for (let i = 0; i < dependencies.length; i += 64) projections.bind(ref, dependencies.slice(i, i + 64), at);
  }
  verifyNativeEveningLineage(db, refs, dependencies);
}

export function verifyNativeEveningLineage(db: AuthorityDb, refs: readonly MemoryProjectionRef[],
  dependencies: readonly MemoryProjectionDependency[]): void {
  const projections = new MemoryProjectionAuthority(db);
  for (const ref of refs) {
    if (projections.isSuppressed(ref)) return invalidCloseout();
    const rows = db.db.prepare(`SELECT ${columns} FROM memory_projection_dependencies
      WHERE projection_kind=? AND projection_id=? AND component_id=?`).all(ref.kind, ref.id, ref.component_id) as Row[];
    const stored = new Set(rows.map(row => canonicalize(dependency(row))));
    const expected = new Set(dependencies.map(value => canonicalize(value)));
    if (stored.size !== expected.size || [...expected].some(value => !stored.has(value))) return invalidCloseout();
  }
}
