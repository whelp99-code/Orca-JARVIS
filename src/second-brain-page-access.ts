import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";

export type PageAccessScope = { readonly owner: string; readonly projects: readonly string[]; readonly policy_revision: string };
const fail = (): never => { throw new JarvisError("SECOND_BRAIN_PAGE_ACCESS_INVALID"); };
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const digest = /^sha256:[0-9a-f]{64}$/;
function object(value: unknown, keys: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(" ") !== keys) return fail();
  return { ...value };
}
/** Verify closed source classifications from an authenticated page response.
 * Checksums correlate bytes; they do not authenticate the provider on their own. */
export function parseSecondBrainPageAccess(value: unknown, scope: PageAccessScope | undefined) {
  if (scope === undefined) return fail();
  const root = object(value, "complete schema_version sources");
  if (root.schema_version !== 1 || root.complete !== true || !Array.isArray(root.sources)
    || root.sources.length < 1 || root.sources.length > 64) return fail();
  let previous = "";
  const sources = root.sources.map(item => {
    const source = object(item, "classification classification_digest source_ref_digest");
    const classification = object(source.classification, "owner policy_revision projects schema_version");
    const ref = source.source_ref_digest;
    const owner = classification.owner; const revision = classification.policy_revision;
    const projects = classification.projects;
    if (typeof ref !== "string" || !digest.test(ref) || ref <= previous
      || classification.schema_version !== 1 || typeof owner !== "string" || !owner.startsWith("principal:")
      || !id.test(owner) || !id.test(owner.slice(10)) || owner !== scope.owner
      || typeof revision !== "string" || !id.test(revision) || revision !== scope.policy_revision
      || !Array.isArray(projects) || projects.length > 64) return fail();
    previous = ref;
    const checked: string[] = [];
    for (const project of projects) {
      if (typeof project !== "string" || !project.startsWith("project:") || !id.test(project) || !id.test(project.slice(8))
        || (checked.length > 0 && project <= checked[checked.length - 1]!) || !scope.projects.includes(project)) return fail();
      checked.push(project);
    }
    if (!checked.length && scope.projects.length) return fail();
    const expected = 'sha256:' + createHash('sha256').update('second-brain/source-access-classification/v1\0')
      .update(ref).update('\0').update(canonicalize(classification)).digest('hex');
    if (source.classification_digest !== expected) return fail();
    return Object.freeze({ source_ref_digest: ref, classification_digest: expected,
      classification: Object.freeze({ schema_version: 1 as const, owner, projects: Object.freeze(checked), policy_revision: revision }) });
  });
  return Object.freeze({ schema_version: 1 as const, complete: true as const, sources: Object.freeze(sources) });
}
