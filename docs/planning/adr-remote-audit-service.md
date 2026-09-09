# Explicit remote audit service composition

The service accepts `--remote-audit-retention-limit N` (integer 1–1000) on
`service once` and `service run`. Omission does not schedule audit retention.
Staged personal-OS cycle channels reject activation. No deployment, production
migration, service restart, or operator configuration is part of this change.

The service creates one job per UTC date, with a cutoff at that date's midnight
minus 365 days. The job ID is fixed; its immutable key binds the batch limit.
A second process must use the same configuration. Only that job is claimed;
unrelated retention classes remain outside this service's claim scope.

Existing transactional retirement preserves minimal local history and commits the
job receipt atomically. A live lease yields pending. An expired lease can be
reclaimed with a higher fence before the UTC day's expiry. Completed jobs replay
the persisted result. Failed/uncertain jobs remain errors for that date; the next
date can create a new job. A prior day's expired job is not revived by this service.

This is one bounded batch per date, not a guarantee that all eligible events are
removed. Backlog larger than the limit remains for subsequent dates. No catch-up
loop or operator retry/reset command is implemented. Counts in adapter receipts
cover the selected batch only. Minimal retired event metadata remains linkable;
this does not provide anonymous history or tamper-proof evidence against a DB owner.
Continuous service emits retention output only when its serialized state changes.

## Validation

- Focused service and module-reviewability: 2 files, 6 tests passed.
- Retention runtime, remote adapter, daily service, review cleanup: 4 files,
  40 tests passed.
- Typecheck and lint passed before final documentation; build passed (Node24.19.0).
- Actual compiled CLI, three separate processes, temporary file DB: disabled jobs0;
  configured retired1/jobs1; restart same receipt; foreign-key violations0.
  Harness: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/remote-audit-service-live.mjs`.
  Receipt: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/remote-audit-service-live.json`.
- Failure injection preserves the source event and leaves no retired row, with
  failed state and fence1 after restart. Lease recovery advances fence1 to2,
  then replay leaves fence2 unchanged.

The canonical full verify run recorded on d66c50c predates this change; these
focused results are not a replacement claim for a full gate on this revision.
Broader development backlog and production operational acceptance remain open.
