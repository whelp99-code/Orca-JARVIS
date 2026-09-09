# Historical task-input routing comparison

Backlog 20/25, 2026-09-09. Compare two explicitly supplied routing policies on
the same stored task inputs before deciding whether to change routing.

```
jarvis report routing-shadow FROM TO BASELINE.json CANDIDATE.json --db EXISTING_DB
```

The cohort is `task.execute` requests created in `[FROM, TO)`, including requests
that have not executed. It is not a count of distinct business tasks. The baseline
file is an explicit comparison reference, not proof of deployed policy. Both files
use the existing bounded strict-JSON and versioned routing policy parser. Invalid
arguments, windows and policies are rejected before opening the database.

Within one deferred SQLite snapshot, use current projection readiness and control
payload suppression. Validate the execution command digest, target and plan digest.
Resolve exactly one original workflow.start request for its run; validate that
command digest and TaskSpec binding, task ID, specification digest and chronological
order. Use that immutable original input rather than mutable runtime output.
Missing, hidden, ambiguous or invalid sources count as unavailable inputs. Database
and projection failures propagate. More than 1,000 execution requests rejects the
report rather than truncating the denominator. Current revocation/expiry is not
reinterpreted as historical execution permission; this report grants no permission.

Report all four classified/review transitions. Compare proposed executor and
record-store sets only when both policies classify; order and rule-name changes
are not target-set changes. Decision digests still bind the complete policies and
matched rules. The cohort digest binds source command/specification digests and
both decisions, or an unavailable marker for missing input. Raw objectives, paths,
request IDs and matching terms are not emitted. Hashes are integrity identifiers,
not a claim that potentially guessable input has been anonymized.

Coverage is compared requests / total requests, null for an empty cohort. A larger
classification count does not prove a better policy. No candidate execution,
counterfactual success, latency or savings is measured. Outcome comparison is
explicitly unavailable; automatic policy promotion and agent execution are false.
The original performance report's outcome shadow comparison remains unavailable.
Actual outcome-based evaluation, approval-bound routing and operational activation
remain follow-up work; this input replay is only one part of backlog 25.

## Verification

- Initial build failed on TypeScript control-flow narrowing of an arrow-function
  `never` helper. Converted it to a function declaration; build23563 exited0.
- Five test files,34 tests passed in10.73s (29838): new report, existing performance,
  routing rules, strict JSON and repository reviewability. Lint/three typechecks
  77099 exited0. The new tests include a separate compiled CLI process.
- Additional compiled acceptance85833 exited0, parent PID3175504: two CLI child
  processes replayed one staged request, changed target set1, stable cohort digest,
  provider calls0, task still pending. Full non-internal table snapshots before
  and after were identical. Fixture DB removed on exit. Receipt and harness:
  `/home/jm/.cache/jarvis-test-runtime-qa-20260908/routing-shadow-live.json` and
  `routing-shadow-live.mjs`. This is actual CLI execution with isolated fixture
  input, not a production cohort or a candidate model outcome measurement.
- No SQL migration, deployment, service restart, production DB mutation or policy
  installation. Full01–25 remains open. Independent acceptance pending.

- Fresh independent routing_shadow_review: ship, findings0, packet5/5 matched.
  Parent rechecked5/5 hashes before acceptance. Requested sol/high; observed
  model/effort and token usage unavailable. No code changes after verification.
