# Historical completion evidence must retain certification bytes

Reading a native task completion currently follows TaskPublicationJournal.read,
which loads only the certification proof digest. An isolated completed task with
its certification proof_json replaced by `{}` still reads as completed. The
regression expecting TASK_COMPLETION_INVALID failed before the change.

Require the bounded original proof bytes to match the digest bound by the
publication before returning a historical publication or completion. Keep this
read-only; do not renew expired execution authority or retry publication effects.
Migrations and immutable-table guards remain unchanged. Tests remove guards only
in the isolated fixture to model stored evidence corruption.

This is a prerequisite for the actual evening source reader, not a new proof
format. Native task certification signs `orca-jarvis/task-candidate-verification/v1`,
while evening verification signs `orca-jarvis/evening-closeout-verification/v1`.
Copying or relabelling those signatures, or issuing a synthetic substitute proof,
is HOLD. The future source contract must preserve and independently verify the
native proof, publication and completion bindings, plus privacy and time scope.
Historical digest integrity does not itself establish a fresh independent
verification or a claim that the Git ref has never changed.

Validation: initial regression 1 failed / 15 skipped. After correction, 3 integration
files passed 44 tests. After adding a compiled Node subprocess that reopens the
corrupted DB, final 2 files passed 19 tests (25.38s), including transaction crash
and concurrent completion tests. These overlapping counts are not additive.
Build, lint and all TypeScript checks exited 0. The subprocess returned
TASK_COMPLETION_INVALID; the reader's connection total_changes stayed unchanged.
Fixtures use actual Git/Node/SQLite with synthetic task input; production is not
activated or accepted by these results. Evidence is stored under
`/home/jm/.cache/jarvis-test-runtime-qa-20260908/completion-proof-bytes-*.log`.

Fresh read-only review `/root/historical_proof_bytes_review`: ship, 0 blocking
findings. Requested gpt-5.6-sol/high; actual model/effort were not exposed.
