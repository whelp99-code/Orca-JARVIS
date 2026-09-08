# Native evening durable usage

Daily usage now dispatches schema v2 evening details to the native envelope's
durable verifier, using the externally supplied closeout key. Run ID, correlation
and date must match the ledger. Items use signed native_completion_count, work is
one completed summary, bytes are the complete canonical UTF-8 artifact size.
Suppression does not refund prior output usage. This does not authorize publication
or live display; those require original proof revalidation and deletion lineage.
Existing v1 verification/counting is preserved.

Validation: evening persistence integration 16 passed (9.68s), lint/typecheck exit 0.
Backend build exited 0 before the additional populated accounting fixture; production
source bytes did not subsequently change. A compiled Node process (PID 337818)
reopened an isolated DB and observed items=0, work=1, bytes=1392. Script:
`/home/jm/.cache/jarvis-test-runtime-qa-20260908/native-v2-usage-live.mjs`.
Its first run omitted DB initialization and failed with missing table; correcting
the harness to use initialized test DB resolved that fixture setup error.
The populated fixture is opaque signed cost data, not original native proof or
publication acceptance. Production deployment/activation remains outside this unit.

Fresh independent review `/root/native_evening_usage_review`: ship, findings 0.
Requested gpt-5.6-luna/high; realized model/effort unavailable in runtime metadata.
