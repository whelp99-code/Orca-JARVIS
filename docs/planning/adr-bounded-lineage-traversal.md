# Reject incomplete structured lineage traversal

2026-09-09. The structured lineage collector previously returned a partial set
when an object or array exceeded depth 8. A shallow known reference could then
make the child visible while a deeper reference was never examined. Existing
array traversal already incremented depth; it had the same silent-stop issue.

Return an explicit completeness flag. If traversal reaches an object beyond
depth 8 or exceeds 4096 visited array entries/object keys, quarantine the child
before binding any collected references. Stop visiting remaining branches after
the first incomplete result. Arrays count their entries; object keys count even
when not recognized as lineage. Cyclic input eventually reaches the depth bound
and is quarantined. A reference-bearing object at depth 8 remains supported.

This is a bounded contract, not permission to truncate context. Deep or wide
otherwise valid input may become unavailable; producers must provide a bounded
input or a separate explicit provenance contract. Historical projections are not
repaired. Non-JSON getters/proxies and whole-object key enumeration allocation
are not covered by this traversal bound; source admission and explicit memory/
parent-reference combination handling remain HOLD.

Caller audit: `publishCurrentState` in `src/state-projection.ts` binds lineage
before writing generation files but does not then reject a newly quarantined
generation. This patch establishes a quarantine record and blocks partial lineage
binding, not every caller's filesystem publication. Enforcing that publication
boundary remains a concrete follow-up; do not claim deep input is removed from
all externally published artifacts by this collector change alone.

Two tests (deep object and deep array with a shallow known source) failed before
the fix because the projection remained unsuppressed. The depth-boundary test
passed before and must stay supported. Additional cases cover wide and cyclic
input. No schema, shipped migration, or production configuration is changed.

Validation: 21 tests across five files passed (14.66s), including depth/width/cycle,
parent binding, eleven persisted read contexts, readiness and reviewability.
Backend build, lint and three TypeScript configurations exited 0. Compiled process
864247 bound a shallow known parent plus deep input in an isolated SQLite DB;
process 864324 reopened it and observed `lineage_unresolved`, visible count 0,
exit 0. This is a real process/persistence check with synthetic source identities,
not operational provider or full source-admission acceptance.
