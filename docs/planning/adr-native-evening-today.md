# Native evening report on Today

Date: 2026-09-08. Scope: dashboard consumption and CLI configuration.

Today now reads schema-2 reports through NativeEveningStore, preserving its
publication marker, original completion proof, current suppression and exact
lineage checks. The existing summary shape and schema-1 path remain available.
The repository allowlist and source limits are trusted startup configuration;
they are not accepted from an HTTP query or inferred from the report.

Dashboard CLI accepts `--native-closeout-source` as a closed JSON object with
`repository_identities`, `max_records` and `max_bytes`. It requires the paired
closeout public-key options. JSON input is limited to 8192 UTF-8 bytes and parsed
before opening the database. Config parsing rejects sparse arrays and returns
frozen copies. Missing native configuration returns no native summary; a scope
mismatch or invalid original evidence fails the request.

## Evidence

- Final backend build, lint and all three TypeScript configurations exited 0.
- Final dashboard-cli and evening-native-store tests: 14 passed, 2 files.
- Earlier three-file integration run including personal integrity: 25 passed.
  These overlap and must not be added together.
- Real HTTP integration publishes one certified completion, returns count 1,
  checks zero database changes during reads, rejects mismatched scope, and hides
  the report after original-source quarantine.
- A separate compiled dashboard CLI process (PID 535665) returned HTTP 200 for
  a persisted empty native publication, count 0 and readiness degraded. This was
  an isolated database experiment, not production or rendered-browser acceptance.
- The frozen base full run found two reviewability failures caused by one
  181-character envelope line. After wrapping that line and three new dashboard
  lines, both reviewability files passed all 4 tests. Final build, 14 integration
  tests, lint and typecheck passed after the formatting corrections.

## Remaining scope

Native completion tasks without source provenance remain rejected. Automatic
producer scheduling, runtime provenance admission, other evening sections and
production/GUI acceptance remain open. The canonical verify run on frozen base
fa1a46df334dc383cf32f56ea0fd76d306e74ef1 is separate and excludes this change.

## Populated browser regression

On 2026-09-08, `e2e/native-evening.spec.ts` passed in Chromium at 1440x1000
and 1024x768 (2 passed, 8.2 seconds). It publishes a native completion into a
real temporary SQLite database using the existing Git publication fixture,
asserts the report identity/count/readiness from HTTP, loads the built dashboard
and checks `1 verified`. After source quarantine, HTTP rejects the report and a
browser reload shows `Today is unavailable` with no completion count.

Reproduce after `npm run build`:
`JARVIS_E2E_NO_FIXTURE=1 npx playwright test e2e/native-evening.spec.ts`.
The test creates its own isolated HTTP server; the flag disables unrelated
standard fixture servers. Default Playwright discovery also includes this test.
Final lint and all three TypeScript configurations exited 0.

Certification measurements and memory provenance are synthetic fixture inputs.
This proves the browser consumption path, not an actual agent's verification,
automatic provenance capture, deployed runtime, or suppression without reload.

The earlier frozen-base verify session 56386 terminated with exit 143 and no
after-snapshot file. The recorded first shard had 1445 passed and 2 reviewability
failures; the second shard did not produce a final summary. The cause of termination
is unestablished. Do not count this as a complete gate; the long-line failures were
fixed in a0fa93b and checked locally together with the Today changes.
