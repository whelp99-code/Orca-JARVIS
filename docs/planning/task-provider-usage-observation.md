# Task provider usage observation

2026-09-09. Backlog25 requires cost per successful task. The Claude task adapter
previously discarded every result field except structured_output and output bytes.
It now returns detached, frozen usage metadata separately from candidate content.

Four counters remain distinct: input, output, cache read and cache creation.
Every token counter must be a nonnegative safe integer; missing/invalid observation
states are explicit. The CLI cost estimate has its own status, so unavailable
counters do not erase a reported estimate, and missing cost never becomes zero.
Unneeded session IDs, model breakdowns, prompts and arbitrary result fields are
not copied. Existing candidate validation, approval, limits and process boundaries
are unchanged; missing or invalid telemetry does not invalidate a valid candidate.

Source: https://code.claude.com/docs/en/agent-sdk/cost-tracking (read 2026-09-09).
The official documentation identifies total_cost_usd as a client-side estimate,
not authoritative billing. We preserve the result-level value without repricing
or adding overlapping modelUsage/message totals. This adapter uses one fresh
non-streaming invocation with tools/subagents disabled. Other transport modes
require their own observation contract.

Validation: build, lint and all three type checks exit0. Usage/transport/source
reviewability29 tests and candidate/workflow/process-boundary34 tests passed.
Actual compiled Claude1/verifier1 execution completed in37253ms and replay invoked
neither again. Fixture Git result commit e027a1086f380ce8c97a4e1e2485196405786db9
is not a JARVIS source commit. Observed tokens: input4/output2749/cache read5139/
cache creation6770; CLI estimated USD0.1411745. Receipt:
/home/jm/.cache/jarvis-test-runtime-qa-20260908/performance-real-dUSQCO/receipt.json.
The acceptance retained source/refs/status, used an isolated signed approval,
and made no production service/DB/configuration changes.

Remaining: persist telemetry against the existing invocation identity, record
coverage for failed/interrupted calls, validate replay/deduplication and retention,
and aggregate estimates separately from billing over the same performance cohort.
The current task-performance report still marks cost_per_success unavailable;
this collection unit alone does not complete backlog25 or the full01–25 goal.
Historical candidate payloads and migrations were not changed.
