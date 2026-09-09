# Task work relationships

Implementation candidate; independent acceptance is pending.

Execution requests may explicitly declare original work, rework or a technical retry.
Omitted relationships remain unknown. No classification is inferred from titles,
failed execution, identical plans or request replay.

Add work_lineage to the JSON input for control plan-task, alongside request_id,
nonce, requested_by and plan:

```json
{"schema_version":1,"kind":"original"}
```

For rework or retry use the prior immutable request ID and its command digest:

```json
{
  "schema_version":1,
  "kind":"rework",
  "prior_request_id":"prior-request",
  "prior_command_digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000"
}
```

The zero digest is a placeholder; copy the actual prior command digest. The prior
request must exist, precede the new request strictly in time, remain visible and
use the same repository identity in a v2 execution plan. Self references fail.
The relationship is a user declaration, not proof that prior work was completed
or that rework was objectively necessary. No new authority is granted to either task.

The dashboard provides the same relationship fields and displays them before
staging and in the execution approval details. Editing them invalidates the preview.
The command digest includes the relationship. Changing an existing request's
relationship conflicts with replay; submit a new reviewed request instead.

The task-performance report exposes work_lineage counts and a declaration ratio:
rework / (original + rework). Technical retries are outside that denominator.
Unknown or invalid relationships make the ratio null. This is a request-cohort
measurement, including pending and rejected declarations, not a business success
rate. Verified completion counts are separate; revoked or missing completion
evidence is counted as invalid evidence rather than a successful rework outcome.

The feature uses existing immutable command storage and adds no migration.
External-effect duplication, authoritative billing and shadow execution outcomes
remain separate incomplete backlog requirements.

Relationships may contain at most 63 predecessor links. Registration rejects a
deeper chain before storage. Common command reads resolve ancestor visibility with
bounded traversal; late ancestor payload/task quarantine hides dependent requests.
This is read-time suppression, not a physical erasure receipt or a new retention policy.

Validation so far: lineage6tests, UI9tests, typecheck and zero-warning lint passed.
The lineage suite includes separate compiled CLI staging/reporting, a signed fixture
execution with one candidate/verifier invocation across replay, revoked completion
evidence, exact replay, unknown coverage, depth overflow and late ancestor quarantine.
An initial late-quarantine test failed because the dashboard exposed the predecessor
digest; common command visibility was corrected and the regression passed.
The compiled CLI scenario is isolated; no production agent task or deployment is claimed.

Independent review dispatch failed with "agent thread limit reached". The subsequent
live-agent list contained only the parent. No independent ship verdict exists.
This candidate must not be described as independently accepted. Broader final
verification and review remain required before closing this development item.

Browser regression at commit `988aa5ab09265f29cb076089e84b607a0606baf9`:
`npm run test:e2e` rebuilt backend/dashboard and exited 0; 26 tests passed in
1.1 minutes across Chromium 1440 and 1024 viewport projects. The log is
`/home/jm/.cache/jarvis-test-runtime-qa-20260908/work-lineage-browser-regression.log`.
These 13 scenarios per viewport cover existing overview, proposal, approval,
retry and accessibility flows. They do not exercise the new work-lineage form.
Next acceptance work must cover relationship selection, predecessor validation,
preview invalidation and persisted approval details through an actual browser.
The UI unit tests and compiled CLI integration are not substitutes for that flow.

The browser gap above is now covered by `e2e/task-lineage.spec.ts`, included in the
default E2E runner. Its compiled fixture starts the real dashboard server with an
isolated authority DB and committed Git repository, and stages/rejects an original
request using a signed decision. Chromium fills the rework form, checks required
predecessor inputs, invalidates previews on edits, stages through the HTTP API, and
reloads the page to verify the persisted predecessor ID/digest in approval details.
No approval or model execution is performed by this scenario.

Validation: typecheck, zero-warning lint and build exited 0. The first browser run
passed 26 existing cases and failed 2 new cases because the test selector matched
both an execution article and its nested approval article. After constraining the
selector to the named execution article, the focused run passed 2/2 in 17.9 seconds
at 1440 and 1024 widths, including horizontal overflow and console error checks.
Log: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/work-lineage-browser-final.log`.
The full canonical gate and independent implementation review are still outstanding.

Canonical gate subsequently passed at `3b6ac907f6d0f71ff7bb0cd251287893cf45bfb0`:
`npm run verify` exited 0, with backend 264 files/1832 tests and 264 files/1870
tests, dashboard 37 files/256 tests (3958 tests total). Runtime, lint, typecheck,
build, fixed-clock acceptance and CLI smoke passed. All 1837 tracked file hashes
were unchanged during the run. Receipt: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/verify-work-lineage-result.json`.

After that gate, `task-work-lineage-boundaries.test.ts` adds regression coverage
for foreign repository rejection without writes, predecessors outside the cohort,
retry exclusion, suppression completeness, two signed approvals and post-approval
relabel rejection. The two lineage files passed 8 tests in 6.56 seconds and the new
file passed zero-warning lint. These tests were added after the canonical gate;
its 3958-test count does not include them. Independent review remains outstanding.

Independent review identified two staging defects: generic `control request`
validated relationship shape without predecessor binding, and predecessor ordering
used lexical timestamps despite raw control requests accepting UTC offsets.
The compiled raw-ingress regression first observed a successful invalid insertion.
Generic insertion now checks lineage inside its transaction, and both binding and
visibility compare finite parsed instants. Regression coverage includes the real
compiled CLI and offset-equivalent timestamps. Three focused files passed 18 tests
in 9.22 seconds; backend build, typecheck and zero-warning lint exited 0.
The earlier full gate predates these corrections.

Acceptance remains held: the reviewer also found that a hidden descendant can
reach generic claim and consume its approval before failing, and noted unbounded
total list traversal cost. Resolve the claim boundary and assess list capacity
before obtaining a fresh independent acceptance review.

The quarantine claim defect was reproduced: the new direct-claim regression did
not throw before the fix. `nextApproved` now excludes hidden task execution requests,
and `claim` rechecks visibility inside its transaction before changing state or
redeeming approval. Direct claim and ApprovedCommandExecutor entry both reject
with unchanged serialized DB bytes and zero provider calls after ancestor quarantine.
Focused lineage/execution tests passed 24 tests; control-plane unit tests passed 11;
reviewability passed 2. Typecheck, zero-warning lint and backend build exited 0.
Evidence: `lineage-claim-before.log`, `lineage-claim-after.log`,
`lineage-claim-control-unit.log` under the existing QA directory.
The list traversal capacity finding and a fresh independent review remain open.

List reads now reuse already loaded ancestor rows and memoize payload/task
suppression only within a single deferred read transaction. No cache survives a
list call. A 64-request chain returned the same 65 commands with predecessor SQL
lookups reduced from 2016 to 0. Isolated compiled measurements were 105.8ms before
and 22.6ms after (one sample each, not p95); both preserved DB bytes.
The regression checks agreement with individual reads and observes new ancestor
quarantine on the next list call. Four lineage files passed 12 tests; dashboard
read/reviewability passed 7. Typecheck, lint and backend build exited 0.
Evidence: `lineage-list-baseline.json`, `lineage-list-after.json`,
`lineage-list-tests.log`, `lineage-list-read-regression.log` in the QA directory.
The generic list still returns all commands and uses O(N) memory with at most
64 in-memory predecessor steps per request. Full pagination/capacity work in
backlog16 remains open; this correction removes repeated ancestor SQL and repeated
suppression reads introduced by lineage. Independent acceptance is still pending.

Post-correction browser regression at `9547266`: the existing backend build and
dashboard assets completed `node scripts/run-tests.mjs e2e` with exit 0,
28/28 tests in 1.3 minutes across Chromium 1440 and 1024. This includes the two
real-server lineage form/staging/reload cases and 26 existing UI regressions.
Log: `lineage-final-browser-regression.log` in the QA directory. A fresh read-only
review was dispatched to `/root/lineage_fresh_review`; no verdict is recorded yet.

The fresh review and a parent compiled probe found hidden descendants still present
in dashboard approval pages and pending totals: common read returned absent while
the page returned child and pending total 1. These SQL surfaces now apply bounded
ancestor suppression within the same page/count transaction. Focused lineage/read
tests passed 12; existing pagination tests passed 4; typecheck and lint exited 0.
Completion ordering in the lineage metric now also compares finite parsed instants.
The reviewer subsequently clarified that this is defensive hardening, not a proven
reporting-path defect: readTaskPerformance rejects noncanonical row timestamps
before calling this helper, and completion evidence uses canonical UTC. The earlier
offset string example did not pass through that caller guard. No standalone helper
test is used to claim a production defect or a resolved reporting requirement.

The canonical run at `cea687c` (session98914) was deliberately terminated after
these defects were confirmed, with exit143. It is incomplete and not a passing
gate. Logs remain `verify-lineage-corrections.log`; no successful receipt was made.
Browser/full-gate revalidation and a fresh independent verdict are still required.
