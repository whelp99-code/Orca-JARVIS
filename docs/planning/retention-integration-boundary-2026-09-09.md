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
| audit | 032/033: immutable audit deletion triggers | Hold |
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
5. File cleanup needs a separate durable operation with recovery and authority
   checks around each irreversible step. It cannot be injected into the synchronous
   SQL adapter or reported complete when only a cleanup request was created.
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
