# Local task timeline snapshots

These commands operate on an existing, migrated JARVIS database. They collect local
task records; they do not attest remote agent liveness or worktree membership.
Registration is explicit and limited to 64 durable task subjects. No background
collector is activated by these commands.

```bash
jarvis timeline register TASK_ID --db /absolute/path/to/authority.sqlite
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
and collect/expire mutate that selected database. Daily/service scheduling and
versioned context-consumer integration remain pending.

Validation: CLI integration2tests passed. Existing timeline7tests passed. A source
reviewability failure from an overlong database-options line was fixed; the final
reviewability2tests and CLI2tests passed together. A compiled seven-process probe
verified register, collect, exact-ID ready read, hold, held read, release and old-ID
snapshot_missing. No production database or service was changed in that probe.

Final typecheck, zero-warning lint and backend build exited0. Independent read-only
review by /root/refresh_receipt_review returned ship. Observed reviewer model/effort
and API-equivalent token cost are unavailable.
