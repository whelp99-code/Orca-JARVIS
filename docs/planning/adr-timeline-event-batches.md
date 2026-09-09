# Batch timeline event reads while preserving emission order

A measured100000intent timeline required500024SQL statements to return200events.
Four child-table queries run for each GJC intent; a control-event query runs for
each discovered graph ID. Replace those lookups with bounded-number set queries.

Keep the existing parent traversal and sink emission order. Preload rows grouped
by their lookup keys, preserving SQL ordering within each group. A control event
matching both correlation and subject is emitted once for that key, but still
appears for each distinct matching graph key as before. Parent intent existence
is checked by deriving child-query IDs from the actual selected intent rows.

Do not regroup emission by event category: synthetic state IDs can collide with
question IDs, and first emission determines the final deduplicated event. The
same constraint applies to approval/control precedence. No schema changes or
altered projection/permission checks are part of this optimization.

Verify bounded query count, unchanged full event output on populated fixtures,
existing timeline/negative-evidence tests and actual100kfixture measurements.
Per-workflow/work/control-request queries and total event memory remain separate
capacity concerns rather than being claimed fixed by this GJC-heavy improvement.

## Parent verification

- Query-count regression initially failed above100queries on2000intents; final
 timeline/scale/negative-evidence/reviewability4files20tests passed. Final lint,
 typecheck and backend build exit0. Tests include all4GJCchild kinds, ID collision
 between a question and a later intent state, and controlsubject/correlation overlap.
- Compiled prior a1a28f8collectors versus new collectors on the same DB:
 2000intents10024->28queries,668.04->557.82ms;10000intents50024->28queries,
 1081.90->695.13ms;100000intents500024->28queries,6874.33->2131.21ms.
 Each returned200events with identical complete JSON SHA and0writes. Single paired
 samples in this host/load, not p95 claims. Populated collision fixture also has
 byte-identical7events with agent.question winning the synthetic-state collision.
- Actual new CLI100klookup:exit0,200events,74717stdout bytes,0stderr,2546.64ms;
 independently open connection observed no data_version change.
- QA: /home/jm/.cache/jarvis-test-runtime-qa-20260908/timeline-batch-compare-8FpTMB/
 receipt.json, populated-receipt.json, cli-receipt.json. Independent review pending.

Repeated same-fixture measurements (5samples each):10000intents p50=629.51ms,
nearest-rank sample p95=694.54ms;100000intents p50=2149.77ms, sample p95=2157.12ms.
Every read issued28queries, returned200events (73033/74633JSON bytes respectively),
and wrote0rows. Small local samples are not a production SLO estimate. Evidence:
repeated-receipt.json alongside the paired old/new receipts.

## Independent acceptance

Fresh timeline_batch_review returned ship/no findings on the final executable diff.
Requested sol/high; actual runtime model/effort metadata unavailable. It checked
parent/category ordering, per-key order, duplicate handling and child-parent scope.
Its extra Vitest invocation did not run because npm rejected argument forwarding;
acceptance uses the parent's20passing tests and actual compiled comparison receipts.

Residual risk: raw child/control rows and grouping arrays remain live through
collection. The100kfixture has sparse child data and does not bound dense-child
peak RSS. Control rows may have two grouped references. Non-GJC per-record queries
remain outside this change. No production activation is implied.
