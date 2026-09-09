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
