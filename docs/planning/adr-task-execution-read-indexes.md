# Indexed task execution and routing reads

Backlog16, 2026-09-09. The task execution view's three candidate queries scanned
workflow runs, command requests or workflow-start effects and sorted temporary
results. The routing source query repeats for displayed runs and requests.

Forward migration `079_task_execution_read_indexes.sql` adds four non-unique
indexes: workflow task/page order, execution request task/page order, workflow
start run/request order, and effect request/type. The first three index valid JSON
documents only. The live queries include the same validity predicates so SQLite
can select those partial indexes. Malformed historical rows are preserved and
excluded as candidates; they cannot supply valid task or source identity.
An absent/ambiguous original routed source still makes the routing read fail.
No distinct/grouping optimization removes duplicate source effects.

The migration does not rewrite data or existing SQL. All82 prior migration files
match HEAD byte-for-byte. A populated-prefix upgrade test checks complete command,
effect and workflow rows before/after, repeated migration application, foreign
keys, quick_check, immutable identity triggers, malformed JSON retention and
indexed search plans. Thirty same-task rows check the exact newest21 ordering
including timestamp ties. A duplicate workflow-start effect still rejects the
routed dashboard read without adding writes.

## Measurement

Separate isolated SQLite fixtures contain10,000/100,000 workflow runs plus one
real fixture run, twice as many command requests plus one, and one effect per
workflow. The benchmark extracts the three SQL queries from the actual reader
sources and records21 warm samples per query (nearest-rank p95), query plans and
result bytes. No HTTP/provider latency or production workload is inferred.

| Query | 10k before/after p95 ms | 100k before/after p95 ms |
|---|---:|---:|
| Task runs | 1.8372 / 0.0027 | 20.8164 / 0.0023 |
| Task execution requests | 2.5042 / 0.0021 | 39.1762 / 0.0015 |
| Original routing source | 5.7890 / 0.0027 | 114.7652 / 0.0028 |

Before: three scans and temporary sorts. After: indexed searches, no scans or
temporary sorts. Result rows1/0/1 and bytes18/2/24 match before/after; the request
query measures a missing target among unrelated requests. Populated same-task
results and pagination are covered by the upgrade test. Timings are warm local
microbenchmarks and do not establish end-to-end speedup or cold-cache behavior.
Evidence: `routing-query-before.json`, `routing-query-after.json` and
`routing-query-benchmark.mjs` under
`/home/jm/.cache/jarvis-test-runtime-qa-20260908/`.

## Verification and rollout

- Focused74169:36tests/5files29.73s; migration83625:7tests/1file5.93s; all passed.
- Lint/three typechecks88739 and final backend build83625 exited0, migrations83.
- Post-index Playwright45796 exited0: isolated compiled dashboard, widths1440/390,
  prepare200/stage202, refreshed routing/spec binding matched, console0/overflow0,
  model calls0. Receipt `routing-index-ui-20260909/browser-receipt.json` in the
  same QA cache. This checks the HTTP flow after migration, not real dispatch.
- Production application remains separate: new indexes require migration and
  consume storage/write maintenance. No production DB or service was changed.
- Fixed-clock acceptance and CLI smoke35054 exited0.
- Native independent routing_index_review returned ship/findings0; parent verified
  reviewed hashes5/5. Requested sol/high; actual model/effort and token usage
  unavailable. Prior external-review detour stopped before any project source
  submission; newly installed CLI removed and auth process stopped. This is the task/routing lookup portion of backlog16;
  it does not claim every query or the full01–25 objective is complete.

## Execution binding lookup — 2026-09-09

The common assertTaskExecutionBinding query omitted json_valid(args_json), so
SQLite could not use the existing partial control_workflow_start_run index.
A source-query EXPLAIN regression failed before the change. Add that predicate;
retain completed state, redemption/fence, workflow.started effect joins and exact
approved workflow/spec/budget comparisons. No migration or authority rule changes.
Malformed historical argument rows cannot establish an approved matching workflow
and are excluded by the query, consistent with the indexed dashboard lookup.

Verification:30tests/4files34.79s passed, types/lint/backend build and diff check
exit0. Positive original approval and changed-spec rejection retain zero read writes.
Compiled standalone AuthorityDb benchmark with actual84 migrations and the source
SQL,21 warm measured iterations, p95 nearest-rank20th observation:

| Completed workflow history | Prior p95 ms | Indexed p95 ms |
|---|---:|---:|
| 10,000 | 3.235416 | 0.009860 |
| 100,000 | 32.784062 | 0.003300 |

Both variants return0rows for the benchmark's intentionally absent redemption;
this is a negative lookup microbenchmark, not approved end-to-end latency or a
service SLA. Query plan changes from state-index candidate enumeration to run-ID
expression lookup; effect/redemption joins remain indexed. Positive binding is
covered by the integration fixture, not this timing result. Provider calls0,
production database changes0. Receipt task-binding-index-benchmark.jsonl in QA cache.
