# Generic command list pagination boundary

Discovery baseline: a951729. The discovery and requirements below describe the
pre-change boundary; the implementation status is recorded at the end.

## Observed call path

`executeControlCommand` handles `control list` by calling `ControlPlane.list()`,
which calls `listControlCommands`. The latter loads every command and builds an
in-memory predecessor map. A repository search found no other explicit
`control.list()` caller in src/dashboard, but the exported library method remains
an external compatibility surface. A text search cannot prove external non-use.

Dashboard pagination is not directly reusable: its index and membership include
only pending/approved/failed requests, while the CLI lists all command states.
Its response also omits command arguments that the generic command API returns.

## Required implementation and verification

1. Define a bounded CLI default and explicit continuation metadata; never truncate
   the current requests array silently. Preserve explicit full-export compatibility
   separately and document its memory cost. Keep the public list API contract until
   an explicit replacement/migration path exists.
2. Use a general requested_at/request_id seek index, not the partial actionable
   index. Keep ordering deterministic for equal timestamps and long identifiers.
3. Bound scanned rows as well as returned rows. A page consisting entirely of
   suppressed rows must still make forward progress with a valid continuation.
   Do not load all ancestors into RAM to produce a small page.
4. Apply current common visibility, including own task and ancestor suppression,
   within one read transaction. Cursor reuse must not cache permission or reveal
   hidden payloads. Define behavior when an anchor is removed/replaced.
5. Bound predecessor lookup/cache within each page and preserve the accepted
   maximum depth. A count of SQL prepare calls is not SQLite operation complexity.
6. Validate two compiled CLI invocations with persisted DB state and continuation;
   cover equal timestamps, hidden spans, late quarantine, all states and invalid
   cursor inputs. Reads must preserve DB bytes.
7. Measure 10k/100k populations with task.execute lineage and unrelated quarantine
   records as well as generic commands: p95 sample count, response bytes, scanned
   rows, query plans and memory. Record concurrent load and fixture limitations.

Do not declare backlog16 complete from projection_id indexes alone. Other overview
and command consumers require their existing evidence to be reconciled separately.

## Implemented CLI behavior

`jarvis control list --db PATH --json` returns at most100 requests and a page
object containing limit, returned, scanned, has_more and next_cursor.
Continue with `--cursor TOKEN`; `--limit N` accepts1..100. Empty requests with
has_more=true means a hidden span was scanned: continue using next_cursor.
At most500 candidate commands are examined per call, plus one lookahead row.
Current lineage reads remain bounded to64 predecessor steps per candidate.
The limit bounds rows, not arbitrary stored payload byte sizes.

`--all` preserves the original complete requests response explicitly and is
incompatible with --limit/--cursor. Library ControlPlane.list remains unchanged.
Consumers previously assuming an unpaged default must use --all or follow cursors.
No total count is advertised. New requests ordered before an already consumed
anchor require restarting pagination; this is current-state traversal, not a frozen
snapshot spanning processes. Removed/replaced anchors produce CONTROL_PAGE_STALE.
Each page uses one read transaction and reevaluates current suppression.
Migration087 adds the general ordering index without changing prior SQL bytes.

Five separate compiled CLI processes verified100 then5 requests, explicit all105,
invalid option combination and malformed cursor exit2, with unchanged DB bytes.
The new optional all flag initially defaulted to false and broke strict option
validation in timeline commands; using the existing booleanValue parser fixed it.

Exploratory five-sample measurements, half legacy task.execute / half workflow,
all-state population, 1KiB args and1000 unrelated quarantines:

| Rows | Full-list sample p95 | Page sample p95 | Full/page bytes |
| --- | --- | --- | --- |
| 10000 | 297.37ms | 45.68ms | 14103335 / 141230 |
| 100000 | 2847.42ms | 4.64ms | 141033335 / 141230 |

Reads made zero DB changes. The10k page median was3.86ms; its45.68ms sample
maximum is retained, not discarded. These are synthetic observations, not a
production SLO, full deep-lineage scale result or whole backlog16 acceptance.
Evidence in the QA directory: control-page-cli-result.json and
control-pagination-scale.json. Full verification and fresh review remain pending.

Canonical verification at0b996538613db0412c9357583e61507b4309f95f exited0:
backend266files1838tests +266files1872tests; dashboard37files256tests,
total569files3966tests. All1847tracked hashes unchanged. Runtime/lint/typecheck,
build, fixed-clock acceptance and CLI smoke passed. Receipt/log:
verify-pagination-result.json and verify-pagination.log in the QA directory.
Fresh read-only review /root/pagination_acceptance returned no fix-first findings
for c4fbef9/0b99653. Remaining limits: payload bytes are not capped per page;
lineage traversal may perform 500×64 bounded steps; synthetic benchmarks exclude
deep lineage and concurrent load. This does not establish production activation
or completion of the full backlog.

CLI help now documents the default/maximum page size, continuation across empty
pages, stale-anchor restart and explicit unbounded --all compatibility. Backend
build and compiled `control list --help` exited 0; existing cli-help integration
suite passed 6/6. This help-only follow-up did not rerun the canonical suite.

## Shared deep-lineage capacity measurement

Reproducible command after build:backend:
`node scripts/control-page-deep-lineage-probe.mjs <receipt.json>`.
The script uses the existing private test-environment launcher and removes its
fixture DB/repository. It stages 63 valid ancestors and 100 leaves sharing that
chain, then adds synthetic workflow rows to reach the specified population.
Statement get/all/run calls are counted; BEGIN/COMMIT and serialization checks
are excluded. Instrumentation is included in timings. Five samples per size:

| Total commands | Queries per 100-leaf page | Sample p95 | Response bytes |
| --- | --- | --- | --- |
| 10000 | 38503 | 311.71ms | 164286 |
| 100000 | 38503 | 311.52ms | 164286 |

All pages returned exactly the 100 leaves; DB bytes were unchanged. Receipt:
`/home/jm/.cache/jarvis-test-runtime-qa-20260908/control-page-deep-lineage.json`.
The first direct fixture attempt failed on /tmp quota; the launcher now uses
the repository's private scratch policy. A missing synthetic expiry was fixed
before the successful run. No provider or production operation was invoked.

This closes the missing shared-chain measurement, not the capacity work. The
next implementation should reuse ancestor rows and suppression observations only
inside a single page's read transaction. It must retain the 64-depth/cycle checks,
revalidate on every new page, and preserve late ancestor quarantine behavior.
No cross-request authority cache is justified by these measurements.

## Page-local observation reuse

The page reader now owns one deferred transaction and memoizes raw ancestor rows,
payload suppression and task suppression inside that call. It still walks each
root with an independent visited set and 64-step limit, checking every digest
and timestamp edge. The callback reader rejects calls after closure; all maps are
cleared on success or exception. No cached visibility verdict survives a page.

The same compiled instrumented probe returned 657 SQL calls per page, down from
38503. Five-sample p95: 10000 rows 41.72ms; 100000 rows 50.48ms. Response bytes
remain 164286, 100 leaf results, DB changes 0. Optimized receipt:
`/home/jm/.cache/jarvis-test-runtime-qa-20260908/control-page-deep-lineage-optimized.json`.
These are separate synthetic runs, not a controlled production latency guarantee.

Focused page/lineage/claim tests passed 3 files/4 tests; the expanded lineage-list
test also passed after adding reader-lifetime and one-observation-per-identity
checks. Typecheck, zero-warning lint and backend build exited 0. Independent
review is pending. Final focused run including compiled CLI lineage and signed
rework execution passed 4 files/10 tests. Full canonical verification predates
this optimization.

Residual: raw rows are retained for the current page, so distinct deep chains can
increase peak memory (at most the scanned roots and their bounded ancestors).
Payload byte budgets and concurrent-load acceptance remain open. The unpaged
library compatibility path is unchanged.
