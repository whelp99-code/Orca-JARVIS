# Task performance from verified execution records

Scope: backlog 25. Query actual `task.execute` requests in a half-open creation
window `[from, to)`, and report their current state at observation time. This is a
request cohort, not a historical reconstruction of states at `to` and not a count
of unique business tasks. Generic workflow starts are excluded.

Use a single deferred SQLite snapshot and the existing signed completion-evidence
reader. A completed state alone cannot count as a verified success. Missing,
invalid, or revoked completion evidence is counted separately and makes the
terminal success-rate measurement unavailable. No source contents, paths, IDs,
approval identities, or model output are included in this aggregate report.

The terminal denominator is completed + failed requests. Pending, approved,
claimed, uncertain, rejected, and cancelled requests are shown separately. Empty
denominators return null. Approval wait measures request creation to locally
accepted approval (`control_command_receipts.created_at`), not signer-issued time.
Completion latency measures request creation to verified completion; neither is
provider-only execution latency. p95 uses nearest-rank on observed valid samples.
Open approval age uses only pending requests without an accepted receipt.

The bounded report rejects cohorts exceeding 1,000 requests rather than silently
reporting a truncated success rate. Provider-reported cost estimates are exposed
separately with completeness checks; authoritative billing cost, true rework and
external duplicate effects remain unavailable. `report routing-shadow` compares
policy decisions on the same historical inputs; it does not measure candidate
execution outcomes. The performance report therefore marks shadow outcome
comparison as `candidate_execution_outcomes_not_recorded`. No policy promotion
or dispatch is performed.

CLI: `jarvis report task-performance FROM TO --db EXISTING_DB`. Validate dates and
arguments before opening the database. The normal authority connection is used
for schema validation; aggregation itself performs no writes, migrations, Git,
provider, or network operations. Require an existing database and an explicit
path. CLI startup retains the authority connection's normal SQLite configuration.


## Verification, 2026-09-09

- Backend build, 27 tests/3 files (30.22s), lint, and all three typechecks exited 0
  (handle18627). Metrics tests cover verified completion, unchanged aggregate-read
  total_changes, replay once, revoked verifier evidence, explicit non-success
  states, half-open windows, cohort overflow, missing DB, and null empty samples.
  The compiled CLI also read a synthetic failed-request cohort in another process.
- First test attempt exited 1: a future window was rejected and a fake completed
  row was rejected by the DB completion guard. Tests now use a past CLI window and
  a normally completed execution with subsequently revoked verifier authority.
- Initial real-Claude acceptance: one model call and one independent verifier,
  result commit `2b758522213555c96c7fcb886b7951235e89538c`; compiled CLI verified
  one success and completion latency 32251ms. The fixture's fixed approval clock
  predated the request, so approval_wait returned samples0/invalid_samples1/null
  rather than a negative or invented wait. This evidence is retained separately:
  `/home/jm/.cache/jarvis-test-runtime-qa-20260908/performance-real-9AaDhJ/receipt.json`.
  The corrected live harness signs at actual reception time for the final check.
- Actual execution uses an isolated fixture DB/Git source and test Ed25519 operator
  approval. It does not authorize production activation. Cost and billing evidence
  remain unavailable, and a single successful sample is not a reliability estimate.

- Final real-Claude run handle69511 exited0: model1/verifier1, result commit
  `2477a11b05f68b52eb549620e746fcce2fa29c9a`, measured success1/1, approval wait2ms,
  completion latency34211ms. Both distributions samples1/invalid0; empty open
  approval distribution null. Preparation writes0, source HEAD/status preserved,
  replay additional model/verifier calls0 and Git refs unchanged. Receipt:
  `/home/jm/.cache/jarvis-test-runtime-qa-20260908/performance-real-I1mbZx/receipt.json`.
  The harness cleaned its fixture and private verifier key on exit.

- Independent review found that a completion timestamp preceding the immutable
  request was excluded only from latency, not from verified success. The reader
  now classifies it as invalid completion evidence before incrementing success.
  A focused reader-boundary regression injects that timestamp over an otherwise
  real executor completion and checks success0/unverified1/ratio null/invalid latency1.

- Post-review final gate79747: backend build,27tests/3files32.08s,lint,3typechecks
  exit0. Final actual-model/CLI gate33812: model1/verifier1, commit
  `f9891579131171417f86e61fc86be51f8c2ac352`, success1/1, approval1ms, latency37474ms;
  both samples1/invalid0. Full non-internal table content snapshots before/after
  the separate CLI were identical (in addition to aggregate total_changes checks).
  Receipt: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/performance-real-mkY4LI/receipt.json`.
  Three separate actual-model acceptance runs occurred in this unit; the last
  includes all product corrections. Each used one model and one verifier call.

## Availability wording correction

Performance/routing-shadow integration: 2 files / 9 tests passed. Backend build
exited 0. A separate compiled CLI process on a migrated fixture DB returned exit0
and the new candidate_execution_outcomes_not_recorded status, with no obsolete
comparison_contract_not_recorded value. Receipt:
/home/jm/.cache/jarvis-test-runtime-qa-20260908/performance-status-result.json.
This is a reporting correction, not newly implemented cost or outcome collection.
