# Dashboard native completion evidence

Use the internal native completion evidence reader for the existing task execution
GET endpoint, after its current visible-command filter. Keep the public response
shape limited to the completion summary; do not expose the original proof body.
Pass the dashboard observation clock to reject future completions consistently.

A revoked verification no longer supplies completion detail. The existing route
maps TASK_COMPLETION_INVALID to HTTP 409 without provider calls or state changes.
The immutable historical command state is not rewritten, and this read is not a
request to retry execution. Missing completion stays null. Existing Origin/CSRF
and command privacy filters remain in effect.

This connects original signature verification to an existing product consumer.
Evening report source selection, project/privacy lineage for its new output,
native evidence serialization and scheduled execution remain incomplete.

Validation: initial HTTP regression returned 200 instead of expected 409 (1 failed,
23 passed). After wiring the reader, two files passed 43 tests. The final dashboard
file passed 24 tests in 22.79s, including a separate compiled Node HTTP server
reopening the same revoked-evidence DB and returning 409/TASK_COMPLETION_INVALID.
These overlapping counts are not additive. Build, lint and TypeScript checks
exited 0. The provider remained called once; the reader connection's total_changes
did not increase. Test inputs are synthetic; no production restart or deploy.
Logs: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/dashboard-native-evidence-*.log`.

Fresh read-only review `/root/dashboard_native_evidence_review`: ship, 0 blocking
findings. Requested gpt-5.6-luna/high; actual model/effort were not exposed.
