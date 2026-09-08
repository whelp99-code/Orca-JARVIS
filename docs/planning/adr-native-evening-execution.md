# Native evening daily execution

2026-09-08: implementation decision for backlog 12.

Add an explicit evening composition of DailyControlLoop, reusing its date,
recovery, lease and phase selection. Default placeholder execution must not be
mistaken for native report publication. The composition accepts operator-owned
source config, trusted public key and a signing handle; none come from task text.

The executor validates the current claim and phase before source generation or
signing. It uses one immediate transaction for generation and NativeEveningStore
publication; that store performs finish-time original-source, lease, budget and
lineage checks. Its atomic publication also completes the run, so executor
completion is a read-only verification rather than a second ledger completion.
Only the current KST day is eligible for this composition. No-data reports retain
degraded readiness and explicit unavailable sections.

Keep unknown source provenance rejected. This composition does not establish
runtime provenance, external signing-key provisioning, CLI/service installation,
other evening sections or deployed automatic operation. Those remain backlog 12
dependencies; this is the reusable execution path needed to connect them.

Verify scheduler restart/idempotency, populated and empty publication, wrong
phase, missing provenance, stale claims, signer failure/elapsed lease and budget
rollback. Synthetic certification fixtures are not actual worker acceptance.

Validation: final 6 integration cases passed (5.95s), lint and all three
TypeScript configurations exited 0. Backend build and the two reviewability
tests passed before the final test-only addition. Compiled Node process 601825
published one empty report; separate process 601955 reopened it with the original
public key, observed one publication and did not invoke its rejecting signer.
An initial experiment regenerated a fixture key in the child and correctly failed
signature validation; preserving the parent's public key fixed the experiment.
The real process result is isolated empty-data coverage, not populated runtime
provenance or deployed scheduler acceptance.

Review correction: preflight now rejects suppressed run/step and invalid single
evening step shape before invoking the signer. Expired claims were already
rejected by store.start before generation; the new test also asserts zero signer
calls. `runNext` returns false because atomic publication leaves no further step;
the regression explicitly verifies the persisted report after this return value.
After that correction, all 10 execution and 2 reviewability tests passed (7.84s),
backend build/lint/typecheck exited 0, and compiled processes 622115/622372 repeated
the publish/reopen experiment successfully with one publication and no new signing.
