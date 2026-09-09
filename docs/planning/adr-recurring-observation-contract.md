# Repeated collection contract investigation at 602b2fe

This is an implementation design draft, not working collector evidence.

Observed constraints:
- personal-observations.ts derives task source ID from environment only; observation identity and idempotency derive from checkpoint while canonical bytes also include checked_at.
- personal-observation-store.ts orders checkpoints strictly by observed_at within source_id. Existing immutable rows and migrations must remain unchanged.
- personal-context-evidence.ts checks exact source ID, digest and observed_at, then reads stored freshness. A refresh receipt alone cannot extend an old observation's freshness for context consumers.
- task-timeline.ts generated_at is the local read time; task.updated_at is source state time. Changing generated_at is not proof of a remote terminal read.
- orca-bound-observation.ts authenticates the selected terminal binding through structured list/read matching but returns state unknown. Its output alone cannot justify working=true or a task completion claim.

Required next implementation boundary:
1. Introduce a versioned collected-snapshot representation, retaining the existing normalizer and immutable observation history for existing callers.
2. Partition checkpoint streams by configured environment, worktree and task/binding identity. Scope membership must remain the configured source/worktree pair, separate from the derived stream ID.
3. Preserve source_updated_at in the snapshot payload and use trusted collection completion as observation time only when an actual collector has read the source. Bind snapshot identity/checkpoint to that collection, so exact retries replay and new reads are distinct observations.
4. Do not expose an arbitrary timestamp switch on the old normalize/admit API as a substitute for collection proof. Implement the producer and versioned admission together, collecting outside the SQLite write transaction.
5. Recheck source version, binding identity, complete scope outcomes, timestamp bounds, cap status and suppression before admission. Context evidence must bind the newly recorded snapshot bytes.
6. Validate unchanged task across two actual reads, two tasks with identical source update time, restart/replay, concurrent admission, stale binding, old snapshot resubmission, partial scope, source removal and context freshness at expiry.

Known risks to resolve before activation:
- A new snapshot ID must not evade an existing task/source suppression decision.
- Snapshot volume needs an explicit retention path; one new permanent row per poll is not an acceptable implicit lifecycle.
- A local task timeline and a remote terminal are different source claims. Prefer an honest local task-timeline collector first if no authenticated remote task-state contract is available.

The initial investigation preserved product sources during canonical session 60065;
that session subsequently completed successfully.

## Revalidated compiled evidence after CLI work

The compiled observation implementation remains unchanged from the accepted timeline
completeness build. Repeated checkpoint probe: PERSONAL_OBSERVATION_IDENTITY_CONFLICT,
zero failed-admission byte changes, two observations and one receipt. Replaying the
old request does not make its expired receipt ready. Two tasks in the same environment
with equal update time: normalized two records, one source ID, PERSONAL_CHECKPOINT_STALE,
zero failed-admission byte changes.

A third probe quarantined one observation, then admitted the same task/source with a
new cursor and later valid source update time. The old receipt read unavailable and
the new receipt read ready, with two stored observations. Current quarantine is exact
projection-ID scoped. This is not evidence that existing policy promises source-wide
quarantine, nor that a real provider bypassed an authorization boundary. It proves
that changing observation IDs alone cannot preserve a desired source-wide hold.

Decision for recurring collection: do not change the existing immutable observation
contract in place, and do not silently reinterpret row quarantine as source quarantine.
A versioned collector contract must name separate source/subject and snapshot identities
and specify how an explicit source hold is created, checked, retained after source-row
disposal, and released. Existing row suppression continues to protect historical rows.
Collector activation remains held until this contract and its actual producer are tested
together; unrelated development remains available.

The first truthful source candidate is the local task timeline. A structured terminal
read that yields state unknown must not be converted into verified working/completed
state. Local timeline collection and remote terminal state collection need distinct
source metadata and acceptance cases.

Local QA evidence directory /home/jm/.cache/jarvis-test-runtime-qa-20260908:
refresh-unchanged-checkpoint.json, refresh-multiple-tasks.json,
refresh-source-quarantine-probe.json. These are isolated fixture observations, not
production activation or resolved defects.

## Local collection producer milestone

`LocalTimelineCollection.collect(taskId)` reads the actual local authority timeline
inside a deferred read transaction. The result names `local_task_timeline`, carries
separate started/completed/source-updated timestamps, an independent collection UUID,
and canonical context bytes with their digest. A truncated context yields `capped`.
The producer refuses nested transactions, invalid task IDs, invalid clocks, future
source timestamps and reads lasting at least five minutes.

This producer attests neither a worktree nor remote executor liveness. The existing
timeline can aggregate related graph records; assigning it a configured worktree
without verifying those relationships would overstate its scope. Collection objects
are not authenticated admission receipts and must not be accepted as caller-supplied
proof by a future persistence API.

Verification: integration three tests passed; typecheck, zero-warning lint and backend
build exited0. A separate compiled Node process read a migrated isolated database
twice with the real clock, verified distinct collection IDs and unchanged DB bytes.
No operational service was connected. Independent read-only review by
/root/refresh_receipt_review returned ship; no fix-first findings. Observed reviewer
model/effort and API-equivalent usage costs are unavailable. The context digest
includes generated_at, so it is a collected-byte digest, not an unchanged-state key.

Remaining implementation must cover bounded snapshot storage and replay horizon,
stable subject holds surviving eviction, source/scope revalidation at admission,
versioned context resolution and daily-loop integration. Existing observation,
checkpoint and refresh receipt histories remain unchanged. Fresh-authority compaction
is a suppression/rebuild workflow, not a live periodic expiry adapter; the service
currently supplies no observation retention adapter. Historical refresh receipts
survive compaction and become unavailable when their source is removed.

## Bounded local snapshot storage candidate

The proposed `LocalTimelineSnapshotStore` calls the local collector itself; it has
no API accepting an externally supplied snapshot. Explicit subject registration is
limited to 64 rows. Each subject stores at most one canonical snapshot, bounded by
262144 encoded bytes, expiring five minutes after collection start. Replacing a
snapshot invalidates the old collection ID rather than resolving it to newer bytes.
No per-poll audit/checkpoint/receipt history is appended.

A hold clears the payload and increments a subject generation. Release also clears
payload; recollection is required. Generation changes between collection and locked
admission reject the result. Expiry keeps registration and hold metadata. The cache
is disposable: fresh-authority reconstruction selects NULL for payload/ID/expiry,
and restore copies current subject metadata with NULL payloads, preserving current
holds without copying cached content. Existing migration bytes remain unchanged;
085_local_timeline_snapshots.sql adds the candidate schema.

Reads resolve only the exact ID and revalidate source bytes; collection and admission
both use actual timeline reads. Freshness is checked after source revalidation too.
The digest describes collected bytes, including generated_at; it is not a semantic
unchanged-state key. This is local task scope, not environment/worktree attestation.

Validation: cache integration6 tests passed; existing observation-refresh-compaction
1 test passed; existing authority compaction and restore high-water2 tests passed
(2 files,10.77s). Typecheck, zero-warning lint and backend build exited0. A compiled
separate Node process verified saved snapshot after reopen and held subject after a
second reopen. The initial default /tmp probe failed SQLITE_IOERR_WRITE during DB
construction; a rerun in the task QA cache directory exited0.

Independent read-only review by /root/refresh_receipt_review returned ship after
the encoded-byte guard was added. Final typecheck/lint/backend build exited0 after
that guard; cache integration6 tests passed again. Reviewer model/effort and
API-equivalent token cost are not observable. No CLI/service activation, daily-loop adapter, or
versioned context-consumer integration is claimed. Subject lifecycle management and
runtime scheduling remain required before automatic operation.
