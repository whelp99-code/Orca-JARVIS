# Projection identifier lookup indexes

Migration 086 adds projection_id indexes to quarantine and suppression tables.
It preserves the existing payload-specific indexes and all shipped migration bytes.
Task-level suppression intentionally checks all projection kinds for one identifier.
Without an index starting with that identifier, approval lineage traversal scans
the suppression tables for each visited request, including the current request.

## Exploratory measurements

Compiled local SQLite probe, 10% pending and 90% rejected legacy task.execute
requests, 1000 unrelated quarantines, 50-item page including total count:

| Requests | Before sample p95 | Indexed sample p95 | Response bytes |
| --- | --- | --- | --- |
| 10000 | 124.04ms | 2.71ms | 11490 |
| 100000 | 1121.21ms | 22.10ms | 11585 |

Five samples per population/variant, collected while canonical tests were running.
These are exploratory same-host samples, not production SLOs. Returned bytes and
counts matched; reads made zero DB changes. These synthetic rows do not certify
execution or completion. The first attempted fixture used completed rows and was
correctly rejected by the completion-receipt trigger; the measured fixture uses
rejected rows without disabling triggers.

A separate 64-request chain created through real staging returned identical page,
legacy list, pending summary and common command objects before/after indexing.
Root payload quarantine then hid all 64 requests; reads preserved DB bytes.
One combined-query sample was 794.42ms before and 34.66ms after, not p95.

The candidate passed the compiled MigrationStore upgrade from 92 to 93 records:
prior checksums and quarantine rows preserved, readiness pending before upgrade,
ready after upgrade, repeated migrate left DB bytes unchanged. Both identifier
lookups used SEARCH in EXPLAIN QUERY PLAN.

Evidence scripts and JSON receipts are under
`/home/jm/.cache/jarvis-test-runtime-qa-20260908`:
`lineage-page-scale.mjs`, `lineage-page-scale.json`, `lineage-index-chain.mjs`,
`lineage-index-chain.json`, `projection-index-migration.json`.

Production deployment is not performed. Generic all-command list pagination and
other backlog16 capacity requirements remain open; these indexes address only
identifier suppression lookup cost. Corrected full verification and independent
review remain required for work-lineage acceptance.
