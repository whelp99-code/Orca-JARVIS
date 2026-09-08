# Native evening v2 envelope

Preserve the canonical native source JSON as a bounded string in a separately
domain-signed v2 envelope. This preserves original signatures and numeric values
without changing the daily detail depth/integer grammar or migration bytes.

Separate envelope validation (shape, bytes, digest and external closeout key) from
live source validation. Durable usage must retain signed published costs even if
source evidence is later suppressed. Publication and display require live source
validation; envelope verification alone does not establish current completion.

The scope is explicitly native task completions. Open work, decisions, memory
candidates, tomorrow actions and risks are unavailable, so this artifact is always
degraded as a full evening report. Source partial/no_data remains in source JSON.
Existing evening v1 is untouched. The new envelope is not yet wired into storage,
usage, Today, derived deletion lineage or scheduled execution.

Live validation rejects an envelope generated after its supplied observation time
and compares its canonical source snapshot to the currently visible, trusted source
at the original cutoff. An altered snapshot is unavailable, not silently refreshed.
The outer verifier deliberately does not claim independent native proof validity.

Validation: related file 21 passed / 28.86s; after adding the future-time guard,
focused test 1 passed / 20 skipped (8.76s), with overlapping coverage. Build, lint
and all TypeScript checks exited 0. The final build recorded 1,099 artifacts and
72 migrations. A compiled Node subprocess reopened the DB and verified the original
source digest; `parseStoreDetail` preserved the envelope. Count tampering, wrong
key, future envelope and hidden live source were rejected; signed durable count
remained one after hiding the source. No production changes were made.
Logs: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/native-evening-envelope-*.log`.

Review correction: evidence records retain the 1,048,576-byte budget. Source JSON
has a separate 1,052,672-byte cap, reserving 4 KiB for its closed metadata and up
to 100 separators. The complete envelope cap is 2,138,112 bytes, allowing JSON
string escaping to double source bytes plus 32 KiB for bounded scope/identity fields.
The boundary fixture signs synthetic opaque records containing quotes/backslashes:
exactly 1 MiB evidence survives source wrapping and envelope JSON round-trip;
1 MiB + 1 is rejected, and synthetic evidence cannot pass live DB validation.
This wire-format fixture does not establish native proof validity at that size.
After correction: related integration file 21 passed (21.64s); build, lint and
all TypeScript checks exited 0. Logs: `native-envelope-boundary-*.log` in the cache above.

Earlier fixed baseline full verify also completed: commit
`5acad5526912196fa762a6dd0fd6f2c4ab70c8ff`, exit 0, backend 2,920 tests across
426 files; dashboard 248 tests across 35 files. Before/after HEAD was identical,
changed tracked files 0, tracked bytes unchanged. That gate excludes this envelope
and the subsequent native source unit. Evidence: `verify-native-dashboard-after.json`
and `verify-native-dashboard.log` in the same cache directory.

Second review correction: parse source JSON with controlled syntax-error rejection
and an iterative depth check (maximum 64) before recursive canonicalization. A
10,000-level valid JSON source and malformed JSON both reject with
`EVENING_CLOSEOUT_INPUT_INVALID`. Focused integration 1 passed / 20 skipped
(3.87s), including compiled DB reopen; backend build exit 0, 1,099 artifacts and
72 migrations. Final finite-number guard also rejects JSON overflow (`1e999`)
before canonicalization. Final focused test 1 passed / 20 skipped (3.31s), backend
build/lint/all TypeScript checks exit 0. Fresh review `/root/native_envelope_ship_review`
returned ship, findings 0; requested gpt-5.6-sol/high, realized model/effort unobservable.
Subsequent usage changes were explicitly excluded from this envelope review.
