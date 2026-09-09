# Local task timeline snapshots

These commands operate on an existing, migrated JARVIS database. They collect local
task records; they do not attest remote agent liveness or worktree membership.
Registration is explicit and limited to 64 durable task subjects. No background
collector is activated by these commands.

```bash
jarvis timeline register TASK_ID --db /absolute/path/to/authority.sqlite
jarvis timeline subjects --db /absolute/path/to/authority.sqlite
jarvis timeline collect TASK_ID --db /absolute/path/to/authority.sqlite
jarvis timeline snapshot TASK_ID COLLECTION_ID --db /absolute/path/to/authority.sqlite
jarvis timeline hold TASK_ID --db /absolute/path/to/authority.sqlite
jarvis timeline release TASK_ID --db /absolute/path/to/authority.sqlite
jarvis timeline expire --db /absolute/path/to/authority.sqlite
```

Use the collection_id returned by collect for snapshot. Snapshot opens SQLite read
only and returns ready only while that exact cached collection and current source
remain valid. A successful command envelope (`ok: true`) does not mean the snapshot
is ready: inspect result.state and result.reason. Collection state capped means the
context was truncated and must not be treated as complete evidence.

After automatic service collection, use subjects to discover cached_collection_id
for each registered task, then pass that exact ID to snapshot. Subjects opens the
database read only and returns at most 64 entries sorted by task ID, with held and
cached_expires_at metadata. This inventory does not validate source freshness or
delete expired entries. A cached ID can expire or be replaced between the two
commands; use the snapshot result to decide whether it remains usable.

Collect replaces the subject's previous cache entry. An old ID becomes
snapshot_missing; it never resolves to new bytes. Expiry is five minutes from the
start of collection. Hold clears the cache and prevents collection. Release clears
it again, so a new collection is required. Registering an existing subject preserves
its hold. There is currently no subject deregistration command.

Expire clears expired payloads while retaining subject metadata. This is logical
cache expiry, not a physical byte-erasure receipt. Reconstruction discards cached
payloads, and restore uses current subject holds. Historical personal observations
and their immutable checkpoint/receipt data are separate.

Commands require explicit --db and reject missing files, extra positionals and
irrelevant options before database creation. Administrative register/hold/release
and collect/expire mutate that selected database. Opt-in service collection is
described below; daily and versioned context-consumer integration remain pending.

Validation: CLI integration2tests passed. Existing timeline7tests passed. A source
reviewability failure from an overlong database-options line was fixed; the final
reviewability2tests and CLI2tests passed together. A compiled seven-process probe
verified register, collect, exact-ID ready read, hold, held read, release and old-ID
snapshot_missing. No production database or service was changed in that probe.

Final typecheck, zero-warning lint and backend build exited0. Independent read-only
review by /root/refresh_receipt_review returned ship. Observed reviewer model/effort
and API-equivalent token cost are unavailable.

## Opt-in service collection candidate

```bash
jarvis service once --db /absolute/path/to/authority.sqlite --local-timeline-refresh
jarvis service run --db /absolute/path/to/authority.sqlite --local-timeline-refresh
```

The flag is disabled by default and requires an explicit database. Register subjects
before enabling it. A running service attempts a cycle at most once per 60 seconds;
this throttle and the round-robin cursor are process-local. Restart permits a new
collection immediately and resets the cursor. Multiple service processes can each
collect: no durable exactly-once or cross-process scheduling claim is made.

The cycle expires old payloads, reads at most 64 registered subjects, skips held
subjects, and counts collected/capped/failed/remaining results. A 30-second budget
is checked between tasks; synchronous source reads cannot be interrupted, so this
is not a hard wall-time ceiling. A partial result does not attest complete scope.
The cursor rotates unfinished work within a running process. Frequent restarts can
reset that progress; full-scope freshness is not guaranteed by the cycle counts.

Individual source failures are isolated; a cycle-level error is reported separately
and coordinator processing continues. Repeated identical cycle summaries are not
re-emitted by service run. These counts describe attempted collection, not a durable
refresh receipt or task completion. The existing daily reader continues to report
provider refresh unavailable; no morning-brief readiness is promoted by this flag.
The staged personal-OS control channel rejects activation of this collector.

Validation: service integration3tests and reviewability2tests passed, final typecheck,
zero-warning lint and backend build exited0. A separate compiled service-once process
collected one registered fixture task; reopening the DB and reading its exact
collection ID returned ready. Coordinator state remained disconnected. This was an
isolated fixture database, not production service activation. Independent read-only
review by /root/refresh_receipt_review returned ship. Existing remote-audit service
and local CLI regressions6 tests passed. Reviewer runtime model/effort and
API-equivalent cost are unobservable.
