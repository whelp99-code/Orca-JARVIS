import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";

const ScopeSchema = z.object({
  schema_version: z.literal(1),
  mode: z.literal("allow_list"),
  projects: z.array(z.string().min(1).max(512)).min(1),
}).strict();

export type MemoryProjectScope = z.infer<typeof ScopeSchema>;

/**
 * Where the owner writes the policy: beside the authority database it governs.
 *
 * A path is not configuration anyone has to wire, and every process that opens the database can
 * find it from the name it already holds. Writing the document is therefore the whole act of
 * turning the policy on, and removing it is the whole act of turning it off.
 */
export function memoryProjectScopePath(databaseFilename: string): string {
  return join(dirname(databaseFilename), "memory-project-scope.json");
}

/**
 * The policy in force for this database right now, or nothing when the owner has not written one.
 *
 * Read each time rather than captured at construction: the document is the owner's statement, and
 * an edit takes effect when they make it rather than when something is next restarted. It is small
 * and read through a descriptor that refuses symlinks, so the file that is measured is the file
 * that is parsed.
 */
export function activeMemoryProjectScope(authority: AuthorityDb): MemoryProjectScope | undefined {
  const path = memoryProjectScopePath(authority.filename);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    // Absent is the answer "no policy". Anything else - a symlink, a directory, no permission - is
    // a document that exists and cannot be read exactly, which is not the same thing.
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return undefined;
    throw new JarvisError("MEMORY_PROJECT_SCOPE_CONFIG_INVALID");
  }
  let decoded: unknown;
  try {
    const identity = fstatSync(descriptor);
    if (!identity.isFile() || identity.size > 8192) throw new Error("not a bounded regular file");
    decoded = JSON.parse(readFileSync(descriptor, "utf8"));
  } catch {
    throw new JarvisError("MEMORY_PROJECT_SCOPE_CONFIG_INVALID");
  } finally {
    closeSync(descriptor);
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
 * This is the identity the control plane already accepted: a work item names the census snapshot
 * it was proposed against, and that snapshot names its project. Nothing invents a mapping from any
 * other namespace. A continuation acceptance is followed to the work item it accepted, because
 * that is the one alias in this product that can reach a work item at all; a task that only ever
 * existed as a workflow run has no work item and therefore no project this database can prove, and
 * says so rather than guessing.
 */
export function candidateTaskProject(authority: AuthorityDb, taskId: string): string | null {
  const projects = authority.db.prepare(
    `SELECT DISTINCT s.project_id FROM census_snapshots s JOIN work_items w ON w.snapshot_id=s.id
     WHERE w.id=? OR w.id=(SELECT work_id FROM continuation_acceptances WHERE id=?)`)
    .pluck().all(taskId, taskId).map(String);
  // One task, one project. Anything else is an identity this cannot resolve.
  return projects.length === 1 ? projects[0] ?? null : null;
}

/**
 * Refuses to bind a candidate to a task whose project the owner did not list.
 *
 * Without a document this does nothing at all, which is the state every deployment that has not
 * written one is in. With one, a task whose project cannot be proved is refused as well: the
 * document names the projects that may contribute, and "unknown" is not among them.
 */
export function assertCandidateProjectInScope(authority: AuthorityDb, taskId: string): void {
  const scope = activeMemoryProjectScope(authority);
  if (scope === undefined) return;
  const project = candidateTaskProject(authority, taskId);
  if (project === null) throw new JarvisError("MEMORY_CANDIDATE_PROJECT_UNVERIFIED");
  if (!scope.projects.includes(project)) {
    throw new JarvisError("MEMORY_CANDIDATE_PROJECT_OUT_OF_SCOPE");
  }
}

/**
 * The same question for the paths that read rather than admit.
 *
 * Admission is not the only moment that matters: a candidate can be admitted before the document
 * exists, and the owner can narrow the list afterwards. These paths answer with a boolean rather
 * than an error, so a document that cannot be read exactly closes them - refusing to show or send
 * derived memory is recoverable, and showing it under a policy nobody could read is not.
 */
export function taskProjectOutOfScope(authority: AuthorityDb, taskId: string): boolean {
  try {
    assertCandidateProjectInScope(authority, taskId);
    return false;
  } catch (error) {
    if (error instanceof JarvisError) return true;
    throw error;
  }
}
