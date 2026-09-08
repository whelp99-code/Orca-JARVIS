# Recover expired retention leases after process restart

2026-09-09, backlog 12. `RetentionRuntime.claimDue` previously selected pending
jobs only; an exited process's claimed job could never be resumed by a new runtime.

Use existing migration 033 reclaim guards: eligible claimed jobs must have an
expired lease, a different owner, and an unexpired job window. Reclaim without a
state transition and increment the fence. Pending claims also increment from zero.
Never resume failed, uncertain, completed, premature, or expired jobs. An expired
lease belonging to the same runtime instance is not reclaimed by that instance.

Select/update in one IMMEDIATE transaction, at most 100 jobs per call, ordered by
not-before and job ID. Use the injected clock after acquiring the transaction;
reject noncanonical/future request time or nonpositive/>15-minute lease duration.
Cap each lease at the job's fixed expiry. A failed update rolls back the whole
batch. Caller time cannot advance job eligibility beyond the observed clock.

Adapters remain synchronous SQLite-only changes in the existing execution
transaction. No service scheduler or destructive adapter is enabled here. External
side effects are outside that contract and must not be replayed through this
recovery path. Operator policy binding, concrete adapters, scheduling and actual
retention operation remain HOLD. No shipped migration changes are needed.

The restart regression failed before the change: a fresh owner received no work
at lease expiry. It now must acquire fence 2, reject the old owner, and invoke the
adapter once. Additional cases cover active lease protection, batch size, expiry
capping, future clock rejection and atomic rollback. The existing execution-clock
test resets its counter after claim because claiming now observes the clock too.

Validation: 15 tests across retention and reviewability passed (8.17s); backend
build, lint and all three TypeScript configurations exited 0. Compiled parent PID
1001785 claimed an isolated job; child PID 1001847 reopened the DB at injected lease
expiry, acquired fence 2 and deleted exactly one test-table row. The old owner was
rejected with `E_RETENTION_CLAIM`; child exit 0. Processes and SQLite operations
were real; clock and adapter data were fixtures, not production retention.
