# Backlog25 remaining evidence contract

Original design baseline: c0f0350. Historical design sections below are retained.

## Current reconciliation at 0b47991

Explicit signed original/rework/retry declarations are now implemented through
staging, generic ingress, approval input, execution and the performance reader.
`src/task-work-lineage-performance.ts` reports declaration counts, excludes retry
from the business denominator, leaves missing legacy coverage unknown and verifies
completion evidence separately. It does not infer business outcomes from titles.
Current source evidence: task-work-lineage.ts, task-work-lineage-binding.ts,
task-work-lineage-visibility.ts and task-work-lineage-performance.ts. Acceptance
and current limits are recorded in ../task-work-lineage.md. Rework is no longer
an unimplemented reason in task-performance.ts.

The following three measurement gaps remain explicit in task-performance.ts:

| Requirement | Current source result | Required next evidence |
| --- | --- | --- |
| Billing-backed cost per success | billing_usage_not_recorded | Attributed billing records, currency and complete coverage of measured attempts |
| Duplicate external effects | external_effect_observation_not_recorded | Provider effect identifiers and reconciled outcomes across attempts |
| Executed candidate comparison | candidate_execution_outcomes_not_recorded | Comparable executions and verified results for both policies |

task-usage-performance.ts aggregates Claude client estimates with
billing_verified=false. task-routing-shadow.ts replays policies over historical
inputs with executable=false and policy_promoted=false. Neither provides the
missing evidence above. Policy automatic promotion remains held.

Compiled CLI readback in the current development shell returned one registration
(claude-code) and three templates (code-fix, incident-report, technical-review).
`routing probe-runtime claude-code` returned not_probed with
TASK_EXECUTOR_CONFIGURATION_MISSING: JARVIS_TASK_CLAUDE_PATH,
JARVIS_TASK_VERIFIER_KEY_PATH and JARVIS_TASK_VERIFIER_KEY_ID were absent.
This does not measure the production service environment or revoke earlier
isolated authenticated execution evidence. Do not silently select another
executor or treat the successful CLI exit as readiness.

Next measurement work must define authenticated receipt ingestion and attribution
before exposing billing or external-effect rates. No real billing records or
provider reconciliation source has been supplied by this reconciliation. Pending
evidence is not zero cost, zero duplicates, or a policy improvement.

### Read-only reconfirmation — 2026-09-10

`inspectTaskExecutors` and `probeTaskExecutorRuntime("claude-code")` were run from
the compiled `dist/src/task-executor-registry.js` against the current development
shell environment. No value or secret was read or printed; these surfaces report
configuration key names and states only.

Result, unchanged from the readback above: one registration `claude-code`,
`registration=registered`, `configuration=missing`, `execution_available=false`,
`missing_configuration` = `JARVIS_TASK_CLAUDE_PATH`,
`JARVIS_TASK_VERIFIER_KEY_PATH`, `JARVIS_TASK_VERIFIER_KEY_ID`, and runtime
preflight `state=not_probed`, `scope=local_runtime_preflight`,
`remote_verification=not_performed`,
`reason_code=TASK_EXECUTOR_CONFIGURATION_MISSING`. The descriptor still declares
`mode=verified_git_commit`, `verification=independent_verifier` and
`automatic_retry=false`.

Scope of this reading, repeated because it is easy to overclaim: it measures this
development shell, not the production service environment, and it neither revokes
nor renews the earlier isolated authenticated execution evidence. A successful
process exit here is not readiness.

Consequence for the remaining operator work: with all three settings absent there
is no configured execution path, so carrying one real permitted task through
TaskSpec, approval, durable dispatch, execution evidence, signature verification
and completion cannot begin from this checkout. That step needs operator-supplied
executor path, verifier key path and key ID in the target environment, which this
handoff explicitly excludes from development scope. Do not substitute another
executor and do not treat a probe as execution.

## Historical implementation before work-lineage development

`src/task-performance.ts` reports verified terminal success, accepted-approval wait,
completion latency and provider cost estimates for a bounded request cohort.
It explicitly returns these four unavailable reasons:

| Requirement | Current reason | Evidence still needed |
| --- | --- | --- |
| Billing cost per success | billing_usage_not_recorded | Billing records attributable to the measured requests, currency and completeness |
| Rework | business_task_lineage_not_recorded | Explicit business-work relationship between distinct requests |
| Duplicate external effects | external_effect_observation_not_recorded | Provider effect identifiers and reconciled outcomes across attempts |
| Shadow outcome comparison | candidate_execution_outcomes_not_recorded | Comparable candidate executions and verified outcomes, beyond routing decisions |

`src/task-executor-registry.ts` has one compiled execution registration, claude-code.
Its inspection, authentication probe and local runtime probe are distinct. A passed
local preflight does not grant execution authority or attest remote verification.
`src/task-templates.ts` contains code-fix, incident-report and technical-review v1;
adding another template is not a substitute for the missing measurement evidence.

## Next implementation boundary: explicit rework lineage

Do not infer rework from repeated titles, failed attempts, Git similarity, request
replay or a shared workflow. Those can be retries, independent tasks or transport
recovery. The input must explicitly identify the prior request and the new request,
name the relationship (rework versus retry), and bind both existing request identities.

Record the relationship before the new execution is approved, include its identity
in approved input, and preserve it through completion. Reject self-links, cycles,
unknown requests and links crossing the allowed project scope. An arbitrary caller
must not relabel already approved or completed work retroactively.

Define the cohort denominator and lineage completeness before exposing a ratio.
Legacy requests without lineage are unknown, not zero rework. A technical retry is
reported separately. Suppression and revoked completion evidence must not disappear
from the completeness accounting or silently improve the measured result.

Acceptance: two distinct approved requests for one explicit rework relationship,
independent work with the same title, retry without rework, missing/foreign prior
request, cycle, post-approval mutation, suppression and cohort boundary. Reopen the
database and run the compiled performance CLI to confirm persistent attribution.
Use a new migration if storage is required; preserve shipped migrations.

This contract is the next investigation target. No relationship schema, recording
API or rework metric has been implemented by this document. Backlog01–25 remains
the full objective; other gaps and reported holds are not removed.

## Staging integration choice

Inspection after a314732 found an existing persistence and approval boundary:
`stageTaskExecution` stores canonical command args and compares them byte-for-byte
on request replay. `validateTaskExecutionAction` currently requires exactly plan
and execution_plan_digest. Control approval binds command_digest, so relationship
metadata can be signed as an optional versioned command argument without changing
the existing execution plan v1/v2 or introducing a parallel relation table.

Implementation sequence:
1. Add a strict work_lineage v1 argument with explicit original/rework/retry kind.
   Original has no predecessor; rework/retry bind prior request ID and command digest.
   Absence remains legacy/unknown rather than original.
2. Extend staging and action validation together. Before storage, verify predecessor
   action, immutable digest, repository identity and temporal ordering. New requests
   may point only to already existing requests; immutable links prevent later cycles.
   Do not use repository path alone as project identity.
3. Revalidate the relationship on generic execution paths, not only dashboard input.
   Replays preserve the originally approved relationship and never relabel it.
4. Extend the existing JSON-file CLI and dashboard preparation/staging boundary so
   users can inspect the relationship before approval. Request metadata must survive
   preparation and appear in the approval review; hidden inferred defaults are excluded.
5. Derive measured counts from immutable command args with bounded predecessor reads.
   Distinguish unknown legacy coverage, explicit originals, rework and technical retry.
   Verify completion/suppression before reporting successful rework outcomes.

No runtime changes are made by this design update. The next code unit must include
the producer and validation/consumer boundary together; a disconnected schema helper
would not implement the requested workflow.
