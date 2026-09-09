# Retention service integration boundary

Status: implementation design; not an implemented adapter or deletion authorization.
Baseline: 6a646d0, inspected 2026-09-09.

## Confirmed mismatch

`src/personal-os-runtime.ts` constructs RetentionRuntime with an empty adapter map
unless callers provide one. forServiceRun supplies none. DailyServiceCycles composes
morning and evening only. Consequently the existing service does not run retention.

The cutoff-bound runtime in `src/personal-os-retention.ts` executes its adapter inside
one immediate SQLite transaction and revalidates its lease before committing.
Adapters may only perform synchronous changes on that same connection.

| Class | Existing constraint | Direct age-based deletion |
| --- | --- | --- |
| observation | 032: personal_observations_immutable_delete and source checkpoint foreign keys | Hold |
| context | 032: personal_context_snapshots_immutable_delete and immutable evidence links | Hold |
| recommendation | 032: personal_recommendations_immutable_delete and immutable action/evidence links | Hold |
| notification | 036: notification_intents_immutable_delete; deliveries reference intents | Hold |
| audit | Context audit remains immutable; 056 replaces operation-audit deletion with a remote-event authorization guard | Hold for generic adapter; inspect existing remote-auth lifecycle |
| memory_candidate | File cleanup rejects an enclosing SQL transaction; prior isolated receipt documents this | Hold for direct composition |
| delete | Existing memory deletion requires explicit scoped authority; cutoff alone is insufficient | Hold for generic adapter |

These are source-level constraints, not measurements of production data eligibility.
No historical migration bytes or guards were changed during this inspection.

## Required implementation contract

1. Inventory payload-bearing columns, their readers and their reference graph before
   defining which bytes may expire. Preserve receipts, replay identities, source
   digests and authority chains needed by surviving records.
2. Introduce any supported lifecycle through a new migration and a named policy.
   A blanket trigger removal is not an acceptable adapter implementation.
3. Readers must represent retired payload explicitly. They must not treat missing
   payload as an empty successful observation, or return a digest for changed bytes.
4. For SQL-only retirement, keep the existing atomic policy/lease checks and prove
   rollback on expiry, database failure and policy mismatch.
5. File cleanup must execute outside the RetentionRuntime transaction. Reuse the
   existing committed candidate/outbox lifecycle where its eligibility applies; a
   new generic cutoff policy needs its own durable authorization and recovery.
   Do not inject filesystem effects into the synchronous SQL adapter or report
   completion when only a cleanup request was created.
6. Connect the supported lifecycle to the service with an explicit configuration,
   daily idempotency, bounded batches, restart recovery and per-class results.
   Unsupported classes remain explicit failures/unavailable, never zero-count success.

## Acceptance before enabling a class

Use an isolated real database containing expired and unexpired records plus linked
contexts, actions and receipts. Demonstrate the intended bytes are retired while
surviving readers, evidence verification and duplicate-request replay still work.
Repeat after restart and with two competing processes; verify one effective cleanup,
foreign_key_check with zero rows, exact cutoff boundaries, and no writes after lease
expiry. Test failures after each persisted phase for any filesystem lifecycle.
Record actual scanned/eligible/deleted/retained counts separately from logical
retirement; SQL deletion alone does not establish physical storage erasure.

This design keeps backlog 07/12 open. It identifies the required lifecycle work;
it does not replace actual retention with a status-only scheduler.


## Existing reusable file lifecycle — verified follow-up

`memory-outbox.ts` reconcileOnce invokes cleanupMemoryCandidateReviews after command
reconciliation. Cleanup errors are reported independently and retried on the next
cycle without changing a committed settlement. This is existing functionality,
not an absent retention implementation for all file payloads.

`memory-candidate-review-cleanup.ts` permits terminal candidates/outboxes and expired
unused automatically approved candidates; queued/claimed/dispatching/reconciling
outboxes retain their source bytes. Each candidate is checked under an immediate
transaction against persisted digests before the file is removed. The immutable
classification snapshot is preserved. This eligibility is not a generic cutoff.

Focused verification at baseline 0179551:
- Command: node scripts/run-tests.mjs integration
  tests/integration/memory-auto-expiry-cleanup.test.ts
  tests/integration/memory-outbox-saga.test.ts
- 2 files, 11 tests passed; exit 0; 4.93 seconds.
- Real temporary file deletion, expiry-boundary retention for queued work, preserved
  classification, cleanup-failure retry and settled outcomes are exercised.
- Evidence: /home/jm/.cache/jarvis-test-runtime-qa-20260908/retention-existing-spool-lifecycle-retry.log.
- Direct npx vitest attempt failed before collecting tests with two system -122
  write errors. The project runner selected its managed temporary environment and
  passed; no tests or guards were weakened.

Next implementation should first expose this existing lifecycle through the
configured service where needed, with bounded work and separate cleanup results.
The SQL RetentionRuntime adapter remains unsuitable for that composition. General
observation/context retirement still needs the reader and reference audit above.


## Streaming enumeration implementation

The candidate cleanup path now consumes a directory iterator instead of materializing
all filenames through readdirSync/filter/map. Existing paths() callers retain the
array API. The iterator closes its directory in finally, including consumer errors,
and rechecks the private root identity while scanning. Eligibility and file digest
checks remain in the existing cleanup transaction.

Focused existing lifecycle verification: 3 files / 24 tests passed, including review
handoff, outbox cleanup retry and expiry. Evidence:
/home/jm/.cache/jarvis-test-runtime-qa-20260908/retention-streaming-cleanup.log.
This removes the full-directory filename array from cleanup; it does not bound cycle
execution time or implement a resumable service batch. Those remain required before
claiming bounded scheduled retention.


### Compiled iterator acceptance

At a3facfe, build:backend exited 0. A standalone Node process used the compiled
MemoryCandidateReviewSpool against 10000 temporary JSON files, one non-JSON file,
one directory with a JSON suffix and one symlink with a JSON suffix.
Exactly 10000 paths were yielded; the other 3 entries were excluded. Directory
file descriptors measured through /proc/self/fd were 0 before, 1 during iteration,
and 0 after early break, consumer exception and complete traversal. Complete
traversal took 24.071809 ms in this single run; this is not a p95 or deletion-cost
measurement. Fixture files were removed in finally. Evidence:
/home/jm/.cache/jarvis-test-runtime-qa-20260908/retention-streaming-live-result.json.

Service integration inspection: cli-gjc-commands.ts owns the repeated `once`
callback and closes the GJC service in finally. A future resumable cleanup scanner
must also be closed there and run independently of daily publication errors. The
current DailyServiceCycles owns only morning/evening loops; no cleanup service
was enabled by this verification.


## Bounded scanner implementation

MemoryReviewCleanupScanner adds a process-local directory cursor. Each cycle accepts
1–1000 entries (default 64); every directory entry consumes the budget, including
non-JSON files, directories and symlinks. The batch reports scanned, removed, failed
and scan_complete. scan_complete describes directory traversal, not successful
retirement of every candidate. Individual failures retry on a future traversal;
they do not prevent later entries from being inspected. Each candidate retains the
existing SQL state and digest checks immediately before file removal.

The scanner holds a directory handle between cycles and must be closed on service
shutdown. Restart begins a fresh traversal and rechecks persisted eligibility;
there is no persisted directory offset. This is an entry-count bound, not a hard
wall-clock deadline. It is not yet wired into cli-gjc-commands.ts.

Verification: 3 files / 13 tests passed; lint and typecheck exit 0. New tests cover
ignored-entry bounds, resumed traversal, expiry changes between passes, corrupt
file reporting and repair, unchanged classification, foreign keys and closed use.
Log: /home/jm/.cache/jarvis-test-runtime-qa-20260908/retention-scanner-tests.log.
Native read-only cleanup_scanner_review returned ship with no blocking findings.
Requested model/effort: gpt-5.6-sol/high; actual model/effort unavailable.


Compiled scanner acceptance: build:backend exit 0. A
standalone process scanned 10000 ignored files in 157 calls with limit64; maximum
scanned per call was64, removed0, failed0. After beginning another pass and closing
the scanner, matching /proc/self/fd directory handles were0. Elapsed19.000322ms
for the single run; no latency percentile claim. This harness intentionally used
an authority stub that throws on database access because all files were ignored;
real deletion remains covered by the database-backed integration tests above.
Evidence: /home/jm/.cache/jarvis-test-runtime-qa-20260908/retention-scanner-live.json.


Review follow-up: exact-limit EOF is reported on the following call as scanned0,
scan_complete true. This is traversal completion only. The owner must close the
scanner on shutdown and surface failed counts, including infrastructure failures.
Concurrent directory mutation may defer entries to another pass; no hard latency
or persistent cursor guarantee is made. Added restart regression passes: close an
incomplete instance, reopen, delete an expired eligible file once, then scan empty.
Targeted scanner suite: 1 file/3 tests passed; retention-scanner-restart.log.


## Explicit service cleanup options

The service accepts `--memory-review-cleanup-root ABSOLUTE_PATH` on `service once`
and `service run`, optionally with `--memory-review-cleanup-limit N` (1–1000,
default64). The root must already exist, be private and belong to the current user.
Configuration binds its device/inode identity; replacement or removal becomes an
error, without creating a replacement directory or repairing its permissions.
No environment-variable fallback enables this service cleanup implicitly.

Example using isolated operator-provided paths:

```sh
jarvis service once --db /absolute/test/authority.sqlite --memory-review-cleanup-root /absolute/test/candidate-review --memory-review-cleanup-limit 64
```

The command may also perform its normal service work: it is not a cleanup-only
command. Combining the options with the staged control channel is rejected.
The cleanup uses existing candidate/outbox eligibility, not a generic age policy.

`memory_review_cleanup` reports processed/partial/error independently of the GJC
result. processed means the batch ran without entry failures, not that all files
were deleted. partial includes failed counts. scan_complete means end of this
directory traversal only. Continuous run emits structured
`service.memory-review-cleanup` output when the batch result changes. The service
closes its scanner in finally. Restart begins a fresh eligibility scan.

Verification before native review: integration3files12tests passed, including a
separate process importing compiled CLI code to delete a repaired expired review,
root deletion/replacement without recreation or chmod, staged-channel/config
rejection, scanner regression and existing morning/evening service behavior.
Evidence: /home/jm/.cache/jarvis-test-runtime-qa-20260908/service-cleanup-integration.log.
No production service was deployed or restarted. This completes only the candidate
review cleanup connection; broader retention remains open.


Service loop follow-up: the integration test drives two actual service callbacks
through a bounded mocked outer scheduler. Both batches scan2 entries with limit2,
then the owning command closes the scanner once and subsequent use fails closed.
The matching structured cleanup result is emitted once across the unchanged pair.
Service-focused suite: 1file4tests passed; service-cleanup-loop.log. This tests
callback composition and ownership, not operating-system signal shutdown.


Native service_cleanup_review: ship, 0 blocking/actionable findings. Requested
model/effort gpt-5.6-sol/high; actual runtime metadata and token usage unavailable.
Final service suite4tests and typecheck exit0 after correcting the test receiver
lookup from mock.instances to mock.contexts. CLI help now lists both options.
Review limits: no real timer/signal shutdown test yet; structured-output equality
is observed in the test log but has no direct assertion. These remain acceptance
follow-ups, not evidence of production activation.


## Actual timer and process restart acceptance

Tested compiled commit d7ebb92 against an isolated migrated database and7 ignored
files. Two separate `service run` processes used interval25ms and cleanup limit2.
Each emitted exactly2 cleanup rows: scanned2/incomplete, then scanned1/complete.
The unchanged intermediate scanned2 results were suppressed. Completion of the
first traversal was observed at351.315793ms and of the restarted process at
294.237455ms from spawning. These are single-run observations, not latency targets.
Both processes exited via SIGTERM; reopening the fixture DB yielded zero foreign
key violations. The test harness exited0 and removed its temporary fixture tree.

Evidence: /home/jm/.cache/jarvis-test-runtime-qa-20260908/service-cleanup-timer-live.json.
This uses the actual timer/CLI/process path, with no eligible candidate deletion;
compiled candidate deletion is verified separately by the service integration test.
SIGTERM uses default process termination, not a graceful shutdown handler. It does
not establish execution of finally on signal. Normal loop completion closes the
scanner as covered by the callback test. No production service was changed.


## Current-schema correction and payload inventory (99c29db)

An isolated in-memory AuthorityDb migrated with the current migration vector was
queried using table_info, foreign_key_list and sqlite_schema. Six target tables
were inspected; production data was not read or changed. Full column, incoming
foreign-key and trigger definitions are recorded at:
`/home/jm/.cache/jarvis-test-runtime-qa-20260908/retention-current-schema-inventory.json`.

| Table | Columns | Incoming FK edges | Payload-bearing candidates / constraint |
| --- | ---: | ---: | --- |
| personal_observations | 13 | 2 | canonical_envelope_json; immutable update/delete |
| personal_context_snapshots | 24 | 4 | canonical_envelope_json, declared_query; immutable update/delete |
| personal_recommendations | 15 | 3 | canonical_envelope_json; immutable update/delete |
| notification_intents | 12 | 1 | redacted_preview, deep_link; identity immutable/delete prohibited |
| personal_context_audit_events | 7 | 0 | identifiers/digests; immutable update/delete |
| personal_operation_audit_events | 23 | 0 | identifiers/digests and remote metadata; conditional remote deletion |

These are structural candidates, not a declaration that any column can safely be
purged. Foreign keys do not enumerate application-level digest/ID dependencies.
Reader and replay analysis is still required before any lifecycle migration.

Correction to the original audit hold: migration
`056_remote_approval_v2.sql` already replaces operation-audit immutable deletion
with `personal_operation_audit_guarded_delete`. It accepts only remote.* events
older than an applying remote_auth_retention_authorizations_v2 cutoff, joined to
a claimed audit job with remote-auth: job_key, matching fence and non-null owner.
The original claim that every audit row is unconditionally immutable was wrong.
The same migration supplies authorization and immutable tombstone tables.
A source search found no src implementation consuming these authorization tables.

Do not remove or replace this guard merely to add an adapter. A bounded remote
operation-audit adapter is the next lifecycle candidate to investigate. Before
implementation, bind authorization cutoff to the persisted job policy, preserve
required tombstones and replay evidence, enforce current lease ownership/expiry
through RetentionRuntime, and settle authorization in the same transaction.
The SQL guard alone does not check current time, lease expiry, policy_cutoff equality,
or require a tombstone for each removed row. It is therefore insufficient as a
standalone authorization API. No claim of an exploitable external endpoint is made.

Acceptance must include remote versus non-remote rows, strict cutoff equality,
missing/wrong fence or job authorization, expiry rollback, tombstone/authorization
rollback on injected failure, and restart/replay. Existing remote approval readers
must retain verifiable historical outcomes. General audit/context/notification
retention and service activation remain held until their own contracts are proven.
