# Native evening CLI

2026-09-08, backlog 12: expose the explicit native evening composition through
`daily evening --once --db PATH --input CONFIG --key-file PRIVATE_KEY`.

CONFIG is a closed version-1 object containing `daily` (the existing daily-loop
config without owner_id), `source` (repository identities and source limits), and
`trusted_key` (key_id/public_key_spki). The key is operator-provided Ed25519 and
must match the pinned public key. Read bounded regular files without following
symlinks; private-key files must belong to the effective user and have no group
or other permission bits. Do not create keys or substitute approval/verifier keys.

Use the existing startup/recovery/claim/atomic publication path. The response
revalidates the persisted report with current source visibility; failed, active,
uncertain, expired or hidden reports cannot return usable completion. Report
stored-source scope, degraded sections and automatic-operation hold explicitly.
This is a local one-shot command, not a deployed recurring service.

Preserve morning flags/behavior. Test actual CLI dispatch, separate compiled
processes, restart idempotency, wrong keys, file permissions/symlinks/size,
invalid config, failed budget and hidden completed outputs. Real agent provenance
capture and operator service configuration remain separate required work.

## Configuration shape

```json
{
  "schema_version": 1,
  "daily": {
    "time_zone": "Asia/Seoul",
    "lease_ms": 30000,
    "deadline_ms": 60000,
    "recovery_window_ms": 600000,
    "recovery_lookback_days": 2,
    "refresh_freshness_ms": 60000,
    "budgets": { "max_items": 100, "max_work": 10, "max_bytes": 1048576 }
  },
  "source": { "repository_identities": [], "max_records": 10, "max_bytes": 1048576 },
  "trusted_key": { "key_id": "evening-report", "public_key_spki": "REPLACE_WITH_ED25519_SPKI_BASE64URL" }
}
```

The public key placeholder must be replaced. Empty repository identities select
no repositories; populate operator-authorized identity digests to include native
completions. Native sources without recorded provenance remain rejected. The
schedule is 21:30 KST and this example allows ten minutes of startup recovery.
The command assumes an already migrated database; it does not deploy or migrate.

## Validation

- Backend build, lint and all three TypeScript configurations exited 0.
- Evening CLI 10, existing morning CLI 17 and reviewability 2 tests: 29 passed.
- Actual compiled CLI processes 650493 and 650504 ran against an isolated database
  with the real wall clock: both exit 0, first publication 1, replay publication 0,
  identical report/usage (items 0, work 1, bytes 1397). This experiment used a
  one-day recovery window to include the current day's scheduled evening.
- Separate-process regression also verifies the ledger is byte-for-byte unchanged
  for the same scheduled replay. Invalid keys/files/config, budget failure and
  quarantined completion have explicit negative cases.
- These are empty-source CLI checks, not an actual agent-to-memory workflow or
  deployed recurring service. Populated source execution/browser checks remain
  documented in the preceding native evening ADRs.
- Additional real-clock CLI processes 666936/666956 used one native completion:
  both exit 0, first publication 1, replay 0, identical usage 1/1/4893. Git, DB and
  CLI were real; certification measurements and source provenance were fixture data.

## Mixed morning/evening usage

The first review found that a same-day evening report makes morning's whole-day
usage unverifiable without a configured closeout key. The morning version-1 JSON
config now accepts optional `trusted_closeout_key`, with the same key_id and
public_key_spki as evening's `trusted_key`. Configure it before using both phases
on the same database. The morning execution factory accepts that key too, so both
budget checks and result reads verify every completed evening report.

Unconfigured or mismatched keys remain rejected when signed evening usage exists;
the artifact cannot nominate its own trusted key. No phase's costs are omitted
to make replay pass. Existing morning-only configs remain valid. The combined
regression runs morning, then evening, then morning replay; it checks identical
whole-day usage, unchanged ledger, and missing/wrong-key rejection.
After this correction, 43 tests across evening CLI, morning CLI, morning execution
and reviewability passed (22.64s); final backend build, lint and all three
TypeScript configurations exited 0.
Real-clock direct CLI processes 694432 (morning), 694463/694540 (evening/replay)
and 694589 (morning replay) all exited 0. Both phases returned the same final
whole-day usage: items 1, work 3, bytes 2151; replay completed no new runs.
