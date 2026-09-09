# Connector fixture schema reuse

2026-09-09; backlog18. Connector tests repeat the same empty 75-migration schema.
The preceding connector run took45.57s for63tests/6files (33324). Three initial
fresh DB measurements took437–452ms; serialized copies with checksum validation
15–17ms. This motivates an opt-in fixture optimization, not a production DB cache.

A module-private Promise holds a serialized in-memory DB after actual migrate().
No fixture writes, provider keys or connection objects enter that image. Each call
creates a separate exclusive0600 file via tempDb, opens a new AuthorityDb and
calls assertMigrationsReady against current migration bytes. Initialization failure
clears the promise; failed readiness closes the opened handle. Test runner scratch
cleanup owns fixture files, as before. No on-disk shared cache or cross-process lock.

Only personal-connector-sources opts in. Generic initialized()/tempDb helpers,
production initialization and migration tests remain unchanged. Migration applied_at
and legacy-quarantine installed_at are seed creation times, not each clone's time.
Do not use this fixture for tests asserting fresh installation timestamps or testing
migration application. Future migrations still undergo a full migration on first
module use and checksum checks on each clone; changed bytes must fail readiness.

Validation: build65tests/7files11.77s, lint and3typechecks exit0(96391). Existing63
connector assertions unchanged;2new tests compare complete sqlite_master and all
initial table rows except the two named installation timestamp fields (both checked
as canonical ISO dates), integrity/FK checks, simultaneous independent files,
mutation isolation and checksum refusal. Initial gate32187 failed solely on the
previously unaccounted quarantine installation timestamp; final whitelist is explicit.

Actual compiled fixture experiment56080 exit0, five samples: fresh initialization
513.4–545.5ms; one-time seed442.1ms; copy+checksum13.8–29.9ms. All5copied schemas
match fresh schemas,75journal entries and integrity/FK checks pass. All experiment
DB files removed. Synthetic fixture setup only; model0/production0. Wall times
are local observations under concurrent full verification, not a global speed SLA.
Receipt: /home/jm/.cache/jarvis-test-runtime-qa-20260908/connector-schema-pNpo4c/receipt.json
Script: /home/jm/.cache/jarvis-test-runtime-qa-20260908/connector-schema-live.mjs

Follow-up: the implementation now delegates to the shared test-only
`migratedTestDatabase` helper, retaining its readiness check and the tests above.
Generic initialized()/memoryDatabase() also opt in under the isolation and
invalidation rules in `adr-test-schema-fixture.md`. The preceding measurements
describe the earlier connector-only implementation.
