# Bounded native completion source

Read actual task completion records for one KST date using an explicit repository
identity allowlist supplied by the trusted composition layer. This is an internal
configuration contract, not permission inferred from a public request. An empty
allowlist selects nothing; a missing/invalid configuration fails validation.

Select at most 101 candidate IDs, then apply the existing control payload privacy
filter and native completion evidence verification in one read snapshot. Check
repository scope again against the verified execution plan. Retain original proof
bytes; do not synthesize evening v1 verification objects. Enforce record and UTF-8
canonical evidence byte budgets. Report omitted/truncated data as partial rather
than claiming no data. Corrupt visible evidence fails the source read.

This step prepares actual native input. A versioned evening output and its derived
privacy lineage must be connected before publication; no scheduler or production
configuration is activated here.

Validation: final related file passed 20 tests in 25.22s; build, lint and all
TypeScript checks exited 0. A compiled Node subprocess reopened the fixture DB and
returned ready/one record/the same canonical evidence byte count. Checks cover
exact byte boundary and one byte under, empty/wrong repository scope, observation
before completion, quarantined command exclusion and corrupted visible proof.
The 100-candidate and multi-record cutoffs are implemented but not load-tested by
this single-completion fixture. Output selection stops at the first budget limit.
An earlier build failed with BACKEND_BUILD_SOURCE_CHANGED because the parent edited
source during that build; the final build ran after edits ended and passed.
Evidence: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/evening-native-source-verified-*.log`.
This is isolated synthetic Git/Node/SQLite evidence, not production acceptance.

Fresh read-only review `/root/evening_native_source_review`: ship, 0 fix-first
findings. Requested gpt-5.6-terra/high; actual model/effort were not exposed.
