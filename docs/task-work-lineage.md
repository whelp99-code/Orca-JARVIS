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
