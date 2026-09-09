# Task identity suppression at execution boundaries

Task IDs differ from workflow run and control request IDs. Existing workflow/control
read guards therefore do not prove that the task identity remains visible. A focused
dashboard test reproduced a quarantined task returning its execution detail.

Check the canonical plan task ID through the existing projection authority at every
execution binding validation, and check the requested task ID before execution-detail
queries. Read returns TASK_NOT_FOUND; binding throws TASK_EXECUTION_SOURCE_SUPPRESSED.
These are current suppression checks, not new authority or a replacement for existing
run/request checks. Existing readiness failure remains fail-closed.

This correction does not implement task-to-candidate/provider lineage, external deletion,
or recall of already emitted model/file effects. Those existing HOLD conditions remain.

Parent verification: 48 tests / 4 files passed in56.32s via canonical backend runner;
three TypeScript checks, lint, backend build and diff check exit0. Covered direct read/
prepare, approved pre-provider rejection with no writes, mid-provider quarantine with
uncertain/no verification/publication/completion/replay, and existing normal journeys.
Compiled isolated HTTP server: task execution GET200 before quarantine,404 afterward;
unrelated task200, read writes0, model/provider calls0. This is HTTP/SQLite behavior,
not a production deployment or real model cancellation acknowledgment.

Initial review and parent follow-up found completed execute replay precedes active
workflow binding. New execute calls now parse their stored plan and check task
suppression before returning historical completion. Active-workflow validation cannot
be applied to a legitimately completed workflow. Internal historical evidence readers
remain internal, and durable completion records are not rewritten.
Final expanded regression:49tests/4files58.72s, types/lint/backend build exit0;
compiled HTTP scenario rerun200→404/unrelated200/readwrites0/provider0.

First review: fix-first for replay visibility/completion using separate snapshots.
Both now execute within one deferred transaction. Two-connection regression commits
quarantine between visibility and completion reads: the already-started read retains
its consistent snapshot; the next call rejects. Stored completion remains unchanged.
Final atomic regression21tests/2files24.48s passed. A test mock needed an explicit
TypeScript this annotation (TS2683); corrected without changing runtime behavior.
Final types/lint/build and compiled HTTP rerun exit0. Fixed-clock acceptance and
CLI smoke exit0. Fresh task_identity_final_review returned ship/findings0 after
atomic correction; requested sol/high, realized metadata/usage unobservable.
