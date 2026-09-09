# Remote audit retention query index

Migration082 adds a partial index matching the adapter's existing LIKE remote.%
predicate and created_at,event_id ordering. It changes neither cutoff eligibility
nor deletion authority. Prior migration bytes remain unchanged.

On an isolated100000-row database,25iterations returned the same ordered100IDs.
Before: table scan and temporary sort, median17.311400ms/p9518.099225ms.
After: index search on created_at, median0.059479ms/p950.071629ms.
Separate limits1/2/100, ASCII case variants, local records and strict cutoff
boundary returned identical results; integrity ok/FK0. These are synthetic
single-host samples, not production latency guarantees.

A separate100000-row file database required47.632754ms to create the index,
with allocated database pages increasing4739072bytes. This is one sample of
DDL execution and page allocation, not production lock time or filesystem size.

Independent runtime_probe_review: ship, findings0. The existing default SQLite
LIKE semantics are required. Do not introduce case_sensitive_like without replacing
the schema/query contract and rebuilding the index: review demonstrated DDL rejection
or divergent indexed/nonindexed results when that deprecated PRAGMA is changed.

After applying the exact reviewed SQL: adapter/upgrade/allocation8tests passed,
backend build exit0 with89migration files, and compiled two-process acceptance
exit0. First actor claimed1/retired1; restart claimed0/retired1; FK0 in both.
No production migration, deployment or service activation was performed.
The canonical3896-test gate at d66c50c precedes this index; it is not represented
as a full gate for082. SQL-only index verification uses the focused regressions,
build and actual process acceptance above.

Evidence under /home/jm/.cache/jarvis-test-runtime-qa-20260908/:
remote-audit-query-index-experiment.json, remote-audit-index-boundary.json,
remote-audit-index-migration-cost.json, remote-audit-retirement-live.json.
