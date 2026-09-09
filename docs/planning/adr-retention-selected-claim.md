# Retention claims scoped to one job

Status: implemented and independently reviewed.

A remote-audit-only scheduler must not use the existing broad claimDue call and
acquire unrelated notification/context jobs. claimDue now accepts optional jobId.
When supplied it filters inside the existing IMMEDIATE claim transaction before
selection/updates. Empty or non-string supplied values fail E_RETENTION_CLAIM;
unknown IDs return an empty list. Omitting jobId retains the existing broad API.
This selector narrows work ownership; it grants no deletion policy or authority.
Clock, eligibility, lease cap, fence and owner guards remain in the shared path.

Runtime/audit30tests passed, including unrelated notification preservation,
empty/unknown selection and repeated current-lease refusal. All3typechecks,
targeted ESLint and backend build exit0. Compiled two-process file-DB acceptance:
first actor claimed1/retired1, restart claimed0/retired1; unrelated notification
remained pending/fence0/owner-null in both. FK0. Fixture database removed.
Receipt: /home/jm/.cache/jarvis-test-runtime-qa-20260908/retention-selected-job-live.json.

No service scheduling, automatic deletion or production configuration changed.
The remote audit service composition remains the next implementation unit.

Independent runtime_probe_review: ship, no actionable findings. The optional-OR
filter retains the existing state-index plan rather than forcing primary-key lookup;
this unit establishes ownership isolation and makes no latency improvement claim.
