import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";

const ScopeSchema = z.object({
  schema_version: z.literal(1),
  mode: z.literal("allow_list"),
  projects: z.array(z.string().min(1).max(128)).min(1),
}).strict();

export type MemoryProjectScope = z.infer<typeof ScopeSchema>;

/**
 * Reads the document that says which projects may contribute memory.
 *
 * There is no default list and none is inferred. A deployment that has not written this document
 * has no project policy, and the admission behaves exactly as it did before this existed; a
 * deployment that has written one is held to it exactly, which is why the record is closed and an
 * unknown key, an unknown mode or an empty list is refused rather than interpreted.
 */
export function readMemoryProjectScope(path: string): MemoryProjectScope {
  let decoded: unknown;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 8192) throw new Error("unreadable");
    decoded = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new JarvisError("MEMORY_PROJECT_SCOPE_CONFIG_INVALID");
  }
  const parsed = ScopeSchema.safeParse(decoded);
  if (!parsed.success || new Set(parsed.data.projects).size !== parsed.data.projects.length) {
    throw new JarvisError("MEMORY_PROJECT_SCOPE_CONFIG_INVALID");
  }
  return parsed.data;
}

/**
 * The project a task's work was proposed against, or null when the authority cannot name one.
 *
 * This is the identity the control plane already signed off on: a work item names the census
 * snapshot it was proposed against, and that snapshot names its project. Nothing here invents a
 * mapping from some other namespace - a task that never became a work item simply has no project
 * this database can prove, and says so.
 */
export function candidateTaskProject(authority: AuthorityDb, taskId: string): string | null {
  const value = authority.db.prepare(
    `SELECT s.project_id FROM work_items w JOIN census_snapshots s ON s.id=w.snapshot_id
     WHERE w.id=?`).pluck().get(taskId);
  return typeof value === "string" ? value : null;
}

/**
 * Refuses a candidate whose originating task belongs to a project the owner did not list.
 *
 * Without a scope this does nothing at all, which is the state every existing deployment is in.
 * With one, a task whose project cannot be proved is refused rather than admitted on the grounds
 * that nothing was found: the document names the projects that may contribute, and "unknown" is
 * not one of them. Candidates that carry no task are outside what the document can speak about -
 * they name no project - and are left to the contracts that already govern them.
 */
export function assertCandidateProjectInScope(
  authority: AuthorityDb, taskId: string, scope: MemoryProjectScope | undefined,
): void {
  if (scope === undefined) return;
  const project = candidateTaskProject(authority, taskId);
  if (project === null) throw new JarvisError("MEMORY_CANDIDATE_PROJECT_UNVERIFIED");
  if (!scope.projects.includes(project)) {
    throw new JarvisError("MEMORY_CANDIDATE_PROJECT_OUT_OF_SCOPE");
  }
}
