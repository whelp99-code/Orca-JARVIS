# Isolated migrated test schema

2026-09-09. Backlog18: repeated fresh migration dominates many test fixtures.
Four compiled local initializations took569–684ms; copying an uninitialized schema
then performing the same initialization took20–48ms. These are same-host samples,
not full-suite performance or production startup claims.

The test-only migratedTestDatabase helper builds the schema with the real migrator
in memory, serializes it, closes its private connection, and keeps one immutable
Buffer inside the current module instance. Each caller exclusively creates its own
file. initialized() and memoryDatabase() opt in; both still perform normal initialize
with fresh external anchors and generated policy keys. No production code changes.

The cache identity includes the resolved migration directory, filenames and bytes.
Recheck after asynchronous preparation and before copying; changed input fails
instead of publishing a mixed snapshot. Failed preparation is not cached. The
template contains migration seed data and journal timestamps, but no initialization,
trust anchors, policy keys, candidate data or per-test mutations. There is no
persistent on-disk cache or sharing of open database connections.

The earlier migratedConnectorDb fixture delegates to the same helper and retains
its assertMigrationsReady call. Its existing full seed-data equivalence tests remain
in force; do not maintain two separate schema caches. Serialization follows that
previously tested connector implementation. New key invalidation covers changes
between calls rather than silently keeping an obsolete schema image.

Migration, checksum, upgrade, recovery and startup tests that need a genuinely empty
database must keep constructing AuthorityDb directly. The helper is not evidence
that a migration was freshly applied on every test invocation. Existing production
initialize still invokes migrate and validates its journal/checksums on each clone.

Required checks: independent schema/journal equivalence to a fresh migration,
concurrent independent files, empty initial authority, distinct external/policy
keys, no mutation leakage to existing or future clones, input invalidation, normal
checksum rejection, and refusal to overwrite an existing destination. Keep full
canonical regression and compiled-process checks in addition to these fixtures.

The old frozen shard2 diagnostic also exposed a separate timing defect: one
memory-candidates-concurrency test exceeded Vitest's5s limit while its worker
deadline alone is5s. Give that suite15s for initialization plus the unchanged5s
worker deadline and finally/terminate cleanup. Do not enlarge worker/SQLite
timeouts or remove any race/convergence assertions. The diagnostic completed
1727passed/1timed-out in908.82s; it is not passing full-gate evidence.
