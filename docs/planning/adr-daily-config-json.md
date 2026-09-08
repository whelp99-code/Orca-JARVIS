# Daily configuration JSON boundary

2026-09-09; backlog12.

Both morning and evening configuration readers used JSON.parse after lossy UTF-8
decoding. Two regression cases confirm duplicate max_work=0 followed by a positive
max_work is silently accepted and work is prepared/completed. Use the existing
strict-json parser with fatal UTF-8, depth32/nodes8192/workItems32768 and the existing
8KiB/16KiB caps. All decoder failures retain DAILY_LOOP_CONFIG_INVALID.
No schema, signing key permissions, file path policy, budget calculations, source
freshness or automatic-operation hold changes. Private PEM handling is unchanged.
Malformed input must fail before preparing runs; existing DB initialization checks
remain in the enclosing CLI and are not represented as zero DB access.

Validation: initial2regressions failed by returning success; final build,49tests
in5files30.20s, lint and3TypeScript checks exit0(handle42605). Separate compiled
Node processes: morning/evening duplicate configurations exit2 before any daily run
exists; normal configurations complete with exit0 and automatic_operation=hold.
Those4processes used isolated SQLite, a generated test signing key, empty sources
and injected CLI clocks. No production schedule or meaningful source refresh was
claimed. Test DB/key files were removed.

## Separate event-identity follow-up (HOLD for event activation)

Compiled canonicalDailyLoopKey maps event:a and event_a to the same
`daily:2026-09-09:in_day:event:event_a`. DailyLoopStore.prepare retains raw event_id
and compares immutable input_json. A separate compiled Node/SQLite check reproduced
DAILY_LOOP_IDENTITY_CONFLICT in both preparation orders with exactly1run retained
in each DB. Current-day event automation remains HOLD. Do not simply change the
key algorithm: existing run IDs, idempotency keys and immutable input digests must
remain replayable. Next work: reproduce both event preparation orders, establish a
versioned collision-free identity and historical replay policy, then test concurrent
delivery/quiet-hour deferral/restart. This configuration fix leaves event keys intact.
