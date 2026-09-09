# Timeline ID sets and SQLite parameter limits

The graph reader repeats a discovered ID set across nineteen control-request
predicates. A connected timeline of2000intents exceeds SQLite's bind parameter
limit on the next graph pass. Generic event/summary IN queries have the same
problem with a sufficiently large ID set.

Bind each deduplicated string set as one JSON array and use SQLite json_each to
expand it inside IN. Keep existing predicates, ordering, graph pass limits,
suppression checks and empty-set behavior. This changes parameter cardinality,
not the set of selected records. No migration or write path changes are needed.

Validate a real SQLite graph with2000related intents plus an unrelated record,
a40000ID lookup, result ordering and zero read-side writes. Existing timeline
integration coverage remains required. This does not bound the total graph size
or make a large connected component cheap; those are separate capacity concerns.

## Observed verification

- Red regression:2000connected intents failed with `too many SQL variables`.
- Final focused timeline/scale/reviewability:3files9tests passed. Lint, typecheck
  and backend build exit0.
- Actual compiled SQLite graph:2000intents,5samples11.93–20.73ms;10000intents,
  5samples75.15–86.87ms;100000intents,5samples1002.98–1086.66ms.
  Each100kread issued14queries and produced a2977990byte JSON representation
  of the internal graph (not HTTP response size). Read-side writes0, quick_check
  ok and FKerrors0. This fixes query failure, not large-graph latency or memory.
- Receipts: /home/jm/.cache/jarvis-test-runtime-qa-20260908/timeline-scale-actual-7UZKgJ/receipt.json
  and100k-receipt.json. Tests:timeline-scale-{red,green,final-tests}.log in the same QA parent.
- Independent reviewer timeline_id_set_review returned a usage-limit error rather
  than a verdict; tool retry time15:25. Implementation remains pending review and
  is not included in the passing43fc8e7canonical gate.

## Event-path completion

- Auditing the remaining timeline collectors found one more per-ID IN predicate
  in negative-evidence lookup. A40000control-ID graph failed there with the same
  SQLite variable-limit error. Changed it to JSON-array binding as well.
- Final focused timeline/scale/reviewability3files9tests passed; negative evidence
  regression1file10tests passed. Final lint/typecheck/backendbuild exit0.
- Actual built CLI `timeline show task:2000 --db <isolated fixture>` returned
  command=timeline.show,200events,71515stdout bytes,0stderr bytes,exit0 in883.03ms.
  An independently open SQLite connection observed no data_version change.
  Receipts and stdout are under timeline-scale-actual-7UZKgJ/cli-show-*.
  This measures a capped200event CLI response over the112000intent fixture;
  the prior100kmeasurements were internal graph reads, not full CLI throughput.
- No remaining per-ID placeholder generation was found in src/task-timeline*.ts.
  Per-record event queries still exist; removing those is a separate optimization
  requiring event-precedence and duplicate handling regression coverage.

## Acceptance

Fresh timeline_id_set_luna_review returned ship/no findings after reviewing all
4source files and the regression. Requested luna/max; actual runtime model and
effort unobservable. Terra reviewer previously returned only a usage-limit error.
Luna reviewed query binding, ordering, empty sets, affinity and privacy; its optional
CodeRabbit installation failed on filesystem quota, so no CodeRabbit result exists.

Canonical verify71580 passed:backend1748+1787tests, dashboard255tests, total3790.
Lint/typecheck/build/fixed-clock acceptance/CLI smoke passed in the same command.
Source snapshot1737files unchanged before/after at36805a3plus this working diff.
QA:verify-timeline-id-sets-{before,after,result}.json and full.log.

Additional SQLite semantic probe:26comparisons,0differences for TEXT/JSON-extracted
identifiers including numeric-looking strings, Unicode, escaping and embedded NUL.
Full100k-intent timeline (200returned events) still issued500024queries in6786.16ms,
74633response bytes,0writes. This is the measured next optimization, not fixed by
removing bind-variable exhaustion. Receipt:100k-full-timeline-receipt.json.
