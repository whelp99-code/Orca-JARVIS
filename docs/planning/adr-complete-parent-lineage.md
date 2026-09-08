# Require lineage from every parent

2026-09-09. During backlog 12 native source admission inspection, the shared
`MemoryProjectionLineage.inherit` boundary admitted a child if the union of parent
dependencies was nonempty. One resolved parent therefore concealed another parent
with no recorded lineage. The child could remain visible with only partial
deletion dependencies.

Require nonempty dependencies for every supplied parent before binding any child
dependencies. A missing parent quarantines the child as `lineage_unresolved`;
existing quarantined-parent behavior remains `lineage_ambiguous`. Preserve union
binding when all parents resolve. Do not add synthetic identities or infer that
an untracked parent used no memory. Propagate quarantine to further descendants.

Two regression cases (known/missing parent in both orders) failed before the fix:
the child incorrectly remained unsuppressed. Also check two resolved parents
retain both dependency identities. Existing tombstone propagation remains covered.

This correction protects future inheritance. Historical rows do not retain a
parent-edge inventory, so this change cannot reconstruct or certify previously
incomplete ancestry. Historical repair needs original source evidence and remains
HOLD; no shipped migration or production database is changed.

Caller audit found a separate unresolved gap: `bindNotificationProjection` and
`bindStructuredProjection` filter parents with `hasLineage` before calling
`inherit`. This core change only checks supplied parents; it cannot recover ones
already discarded by a caller. Those producers need an explicit distinction
between confirmed non-memory input and unresolved memory input before their
filtering can be changed without indiscriminately hiding ordinary non-memory
tasks. End-to-end complete ancestry is therefore not established by this fix.

Native task admission is still incomplete: `stageTaskExecution` currently stages
only plan and plan digest, and native evening tests bind provenance directly in
fixtures. Copying workflow lineage alone does not establish the origins of added
plan/provider inputs. A follow-up must bind source declarations and provider input
identities to approval, carry them through execution, and test actual source
correction/deletion through the published report. Missing source evidence must
continue to block publication rather than become a no-memory declaration.

Validation: 17 tests across projection authority, native evening execution, and
runtime reviewability passed (10.35 seconds). Backend build, lint, and all three
TypeScript configurations exited 0. A compiled Node process (PID 786804) bound a
known parent and inherited it with a missing parent in an isolated SQLite DB.
A separate process (PID 786830) reopened that database and confirmed suppressed
true, visible rows 0, inherited dependencies 0, exit 0. This uses synthetic source
identities and proves persisted quarantine, not real upstream source admission.
