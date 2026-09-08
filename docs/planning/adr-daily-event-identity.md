# Versioned daily event identity

2026-09-09; backlog12/23. Legacy punctuation replacement maps event:a and
event_a to one key; both preparation orders reject the second event.

New in-day keys use event:v2:SHA256(JSON string of validated identity), with a domain prefix
in the hash. Scheduled identities stay unchanged. Under one IMMEDIATE transaction,
prepare first looks up the same local date/raw event ID and reuses its persisted
legacy or v2 key. Existing run ID/key/input digest and all replay comparisons remain
unchanged; altered event data must still conflict. Existing invalid identities are
rejected, not repaired. Pure deferred-key calculation describes the current v2 key;
a returned run_id remains the authoritative handle for a legacy persisted run.

New migration075 adds uniqueness on local date/raw event ID for version1 in-day
records. This prevents old/new writers from inserting the same event under distinct
keys. A historical duplicate blocks migration rather than deleting/merging evidence.
An index readiness guard prevents event preparation before migration075; scheduled
work is unaffected. Old writers can reject an event rather than become compatible;
mixed-version automatic operation remains unsupported. No shipped SQL changes.

Validate distinct colliding IDs in both orders, exact replay, changed-input refusal,
legacy key reuse, simultaneous writers, quiet-hour deferral and schema upgrade.
Real event effects and operational activation remain HOLD independently of identity.

## Validation

Initial changed implementation:126tests/9files passed. Final version-zero guard and
upgrade regression: backend build,127tests/9files59.62s, lint and3TypeScript checks
exit0(handle60232). Migration tests preserve reviewed SQL bytes and apply new
migrations repeatedly. Existing lease/quiet-hour/recovery/rollback cases pass.

Actual compiled-process acceptance (handle59971 exit0): the frozen80f58a5 build
created a legacy74-migration SQLite DB and event:a. Current code migrated it to75
and returned the same run; event_a became a different run. Two new Node writers
waited on an IPC start barrier and submitted event:b concurrently: identical run,
3totalrows. An old writer's event:b replay then failed with
DAILY_LOOP_IDENTITY_CONFLICT rather than inserting a duplicate; the new writer
replayed successfully with3rows. No models/effects/productionDB were used.

Receipt: /home/jm/.cache/jarvis-test-runtime-qa-20260908/event-identity-N2YtOn/receipt.json
Reproduction: /home/jm/.cache/jarvis-test-runtime-qa-20260908/daily-event-identity-live.mjs
Isolated SQLite files were removed. Synthetic events establish identity/storage
behavior; they do not prove a production connector or event handler is active.

Version-zero rows that occupy a candidate legacy key lack source identity and are
held with IDENTITY_CONFLICT. They are not automatically assigned a new v2 key.
Explicit data review is required for those old rows. New v2 rows retain record
version1 because the immutable JSON/step/checkpoint schema is unchanged.

Additional compiled SQLite migration check: two synthetic historical rows with
the same raw event ID under distinct keys cause075SQL to fail UNIQUE; both rows
remain byte-for-byte equivalent in the subsequent SQL snapshot. This used a
deliberately removed index in an isolated migrated DB, not production data.
