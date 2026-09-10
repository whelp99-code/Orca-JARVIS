# Bound dashboard SSE subscriptions

Each response already bounds its writable buffer to 128 KiB and disconnects a
blocked writer after five seconds. ReconcileHub's subscriber set was unbounded.
For backlog 17, limit each hub (one per dashboard server) to 128 subscribers.
This permits multiple operator tabs and agents while placing a finite bound on
the number of retained SSE sinks. It is an initial capacity policy, not a measured
concurrency requirement or a bound on total process/kernel memory.

Reject excess HTTP subscriptions before sending SSE headers with status 503,
code SSE_CAPACITY_EXCEEDED and Retry-After: 5. Existing subscribers remain active.
The hub also enforces admission for direct callers. Unsubscribe and failure cleanup
release capacity immediately. Admission and registration are synchronous on the
same event loop, with no await between the HTTP check and hub registration.

The dashboard's terminal EventSource retry introduced in f7dd530 reopens a rejected
connection after five seconds. Other clients must implement their own retry policy.
No authority state, persistence schema, replay policy, or execution rights change.
Validation must cover real HTTP saturation, slot release/reconnection, and continued
delivery to accepted clients. Production activation is separate.

## Verification

- Integration runner: 3 files / 12 tests passed, including 128 real HTTP streams,
  excess JSON503/Retry-After, survivor event delivery, slot release and replacement.
  Direct hub callers also fail admission without receiving a frame.
- Full typecheck, backend build and changed-file ESLint exited0. Existing shipped
  migration count94, migration bytes unchanged by this change.
- Built checkout f7dd530+capacity change: actual dashboard process/private DB and
  Chromium, 128 actual fetch SSE streams occupied capacity. Browser received real
  503 (no mocked response); releasing one stream let its second events request
  connect, native readyState1 and displayed 연결됨. Process exited0.
- Receipt and harness under /home/jm/.cache/jarvis-test-runtime-qa-20260908/:
  dashboard-sse-capacity-browser.json and dashboard-sse-capacity-browser-probe.mjs.
  This is built-checkout acceptance, not a newly packaged/deployed release.
- Parent reviewed synchronous admission, cleanup and HTTP error behavior. No
  separate agent review was performed. Total HTTP sockets, RSS, and persistent
  overload/fairness are not bounded by this subscription limit.
