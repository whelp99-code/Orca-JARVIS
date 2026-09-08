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

## Durable invocation observation and cohort estimates

The next implementation reuses immutable control_events, with one deterministic
event ID per existing control_effect_attempts invocation. The payload binds attempt,
request, approval receipt, lease fence, run and execution-plan digest. Replay checks
all metadata and canonical payload before returning without another insert;
conflicting observations fail. Current execution permission is deliberately not
required to record a historical attempted call after expiry/cancellation. No
completion receipt is overwritten and the event never grants authority.

The candidate runner records returned metadata before its post-call authority
check. A provider exception records unavailable coverage; it does not invent zero
spend. Missing/invalid metadata is also explicit. A persistence failure is an
execution error after a potentially incurred call, and must not trigger automatic
provider retry. A process killed before recording remains a missing observation.

The report adds provider_cost_estimate for all attempted calls in the same request
cohort, including failed work. It preserves partial observed sums but returns a
null per-verified-completion estimate if evidence is missing/invalid, successful
completion proof is invalid, there are no successes, or arithmetic exceeds the
supported numeric range. Values retain the CLI floating-point estimate; they are
not monetary ledger entries. Billing cost remains separately unavailable. The
existing 1000-request bound and a 1000-attempt bound reject truncated aggregation.

Validation:40 tests/4files33.16s, backend build/lint/three type checks exit0.
Cases include replay, late recording, wrong fence, immutable update/delete,
missing/invalid/failed provider coverage, verification failure, cancellation after
response, and corrupt event identity with intact payload digest. Compiled actual
Claude1/verifier1 completed43906ms, fixture result commit
22b90c164bacbec3fe278a455796fb27cee35288. Separate CLI report read the persisted
estimate0.18251399999999998 USD, reported1/missing0/invalid0, verified completion1,
per-completion same estimate. Replay added no provider/verifier call; report reads
preserved database rows. Receipt:
/home/jm/.cache/jarvis-test-runtime-qa-20260908/performance-real-nmBGZq/receipt.json.

Remaining: no authoritative billing evidence, no recovery of telemetry lost to
process termination, and no detailed cost recovery from rejected CLI error-result
envelopes. Such attempts retain unavailable coverage. Control events have their
existing append-only retention policy; no new cleanup bypass was introduced.
Rework, external duplicate observations, shadow comparison and full01–25 remain
open. No operational service/DB/configuration was changed by this acceptance.

## Failed result observations

The Claude adapter now parses bounded UTF-8 JSON before rejecting a nonzero exit.
Only coherent known result envelopes can attach normalized usage to a
TaskProviderFailure. Exit errors, error subtypes and absent structured candidate
output still fail execution; telemetry grants no approval or success. Malformed,
unknown, signalled, timed-out and output-limited results remain unavailable.
Only normalized counters/statuses and the CLI estimate cross the error boundary;
raw errors, prompts, session IDs and candidate data are excluded.

The executor records this telemetry against the same invocation before marking
uncertain. A replay requires fresh approval and cannot send the provider again.
No migration or historical event rewrite is needed. Existing metadata validation
and replay conflict rules still apply.

Official cost-tracking documentation, read 2026-09-09, states that crash results
(error_during_execution) may zero every counter and that error_max_budget_usd
omits the crossing response from usage but includes it in total_cost_usd.
Crash tokens and cost are therefore invalid for aggregation, even if numerically
nonnegative. Budget-error tokens are invalid while a valid cost estimate remains
reported. Unknown/crashed usage is never a measured zero-cost invocation.
Source: https://code.claude.com/docs/en/agent-sdk/cost-tracking#track-costs-on-failed-conversations

Targeted verification:79 tests/6files,34.02s, including executable transport
fixtures and durable failure/replay coverage. Build, lint and three type checks
passed. Actual compiled runtime with an isolated CLI wrapper adding
--max-budget-usd 0.000001 returned TASK_PROVIDER_FAILED/uncertain in2753ms:
provider1, verifier0, completion absent, replay rejected, original HEAD/status
and replay refs preserved. A separate CLI read reported the persisted estimated
USD0.002148, reported1/missing0/invalid0; verified completions0 and per-success
estimate null. Tokens remained invalid for the budget-error scope. Receipt:
/home/jm/.cache/jarvis-test-runtime-qa-20260908/failure-usage-real-bB9OuL/receipt.json.
The wrapper is acceptance-only, not an operational budget guarantee. The actual
estimate exceeded its configured cap; no financial enforcement is claimed.

Earlier acceptance attempts are not counted as failed-result validation:
F1zSFo stopped at an incorrectly expected replay response; heFeFV observed an
initial schema rejection without telemetry; 5Q4nxk completed despite a one-turn
limit (fixture estimate USD0.09681799999999999). Those scripts exited1 and did not
change production. Only bB9OuL passed the failed-result acceptance assertions.
Process-death recovery, authoritative billing, other providers, business rework,
external duplicate observations and shadow comparison remain open.
