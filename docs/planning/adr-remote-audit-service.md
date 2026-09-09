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

## Canonical gate result

Session37145 completed uninterrupted `npm run verify` with exit0. Backend shard1:
259files/1805tests,575.77s; shard2:259files/1845tests,522.97s. Dashboard:
37files/255tests,34.09s. Total3905test executions passed. Runtime, lint, three
TypeScript configurations, build, fixed-clock acceptance and CLI smoke finished.
Acceptance: pre_gjc_ready/stopped, completion_promoted=true, gjc_dispatched=false.

Build provenance records HEAD687b231 with dirty source, input digest
sha256:73a3f86a2c1605994c17fccd80de0ca3f38ecca61b724a6c86d4de271ef0270d,
artifact digest sha256:8f3ddb7a40fd3fb2c0c3ad14883ca75a8a431faf3b0a326e2bc522d2a441f891.
The implementation was committed during the run as ece7210; subsequent commits
through2e6527d changed only documentation. Post-run diff against ece7210 for
src/tests/dashboard/migrations/scripts/package files returned no changes. This
was not a clean-HEAD-at-start run and no before/after full-tree hash was captured.
Tracked worktree changes0; untracked node_modules link remains.

Log: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/remote-audit-service-verify.log`.
This closes this implementation's canonical gate, not production activation or
backlog01–25. Provider refresh admission remains the next implementation boundary.
# Expired daily job recovery — 2026-09-10 KST

Prior daily pending/claimed jobs were never revisited after the date changed.
A regression test reproduced both stale states. The configured service now
settles at most 100 expired audit jobs in its daily namespace per cycle, inside
the same immediate transaction that validates today's policy. It ignores rows
updated after the observed clock and leaves other retention jobs unchanged.

Pending becomes failed; claimed becomes uncertain because a stale claim is not
proof of successful completion. Both retain E_RETENTION_EXPIRED and release the
lease. Completed/failed/uncertain records are unchanged. No old effect is replayed,
no retention policy is extended and no additional audit payload is deleted by
this recovery step. The existing current-day adapter remains separately invoked.

Validation: original reproduction failed before the fix; existing service4tests
and expiry2tests passed, including the 100-job batch bound and no-write replay.
Typecheck/lint passed. The first build detected a concurrent test-file edit and
stopped with BACKEND_BUILD_SOURCE_CHANGED; the final stable backend build passed.
A separate compiled Node process with isolated SQLite confirmed old claimed→
uncertain, current-day completed and recreated-service replay writes0.
Receipt: /home/jm/.cache/jarvis-test-runtime-qa-20260908/remote-audit-expiry-compiled.json.
Independent review /root/pagination_acceptance returned SHIP with no findings.
Future-dated updates remain excluded until the clock catches up, and backlogs
over100 jobs require further cycles. No production activation or full-goal completion.

Follow-up compiled CLI acceptance: run
`node scripts/remote-audit-expiry-cli-probe.mjs <receipt.json>` after build:backend.
The probe creates a private file-backed DB with no GJC configuration, seeds expired
pending/claimed jobs, closes it, and starts three separate CLI processes. An
unconfigured `service once` leaves retention rows unchanged; configured execution
marks old pending failed/old claimed uncertain and completes today's empty batch;
the third process preserves all retention rows and the same completion response.
The temporary database is removed on exit. All three processes returned exit0 and
service state disconnected. This is not a live provider or production retention
deletion test. Receipt: shared QA remote-audit-expiry-cli.json. The probe guards
against a UTC date transition so different daily jobs are not called a replay.
