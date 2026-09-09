# Daily service composition: implementation boundary

## Observed source at f8a1276

- PersonalOsRuntime.forServiceRun constructs GjcRuntimeService and a retention
  runtime with an empty adapter map. It constructs no DailyControlLoop.
- cli-gjc-commands drives service.once/service.run; the staged control-channel
  branch is a separate execution surface and must not silently gain side effects.
- cli-daily-commands composes createStoredMorningDailyLoop only for explicit
  daily morning --once, with an unavailable refresh reader and empty event source.
- cli-evening-command composes createStoredNativeEveningDailyLoop only for explicit
  daily evening --once, after validating source configuration and an existing
  private signing key. Both CLI envelopes report automatic_operation=hold.
- DailyControlLoop exposes startup and cycle with persisted schedule identity,
  recovery windows, leases and phase filtering. Its default executor can complete
  logical placeholder steps; automatic composition must use concrete executors.

## Next implementation slice for backlog 12

Connect explicitly configured morning and native-evening executors to service
lifecycle, reusing their existing validation and signed-source requirements.
Startup recovery must run once per process; subsequent cycles must use cycle(),
with no overlapping invocation. Preserve persisted per-date/per-phase identity
across restarts and competing processes. An unconfigured phase must remain visibly
unavailable. Keep the current service behavior when no daily configuration exists.

The composition must expose each phase outcome independently of coordinator
transport availability, without turning failure into a completed daily artifact.
Do not put asynchronous provider IO inside existing SQLite transactions. External
refresh/event adapters remain a separate explicit capability; do not label stored
local context as refreshed. Retention requires concrete policy/adapter configuration
and must not be enabled by merely constructing RetentionRuntime. Review the staged
control-channel contract before adding daily execution to that surface.

Acceptance requires actual CLI-process evidence for scheduled morning and evening,
restart recovery, duplicate startup, missed recovery window, unavailable signing
key/config, phase failure and coordinator failure. Assert durable artifact identity
and no duplicate completion, not just a callback invocation. Existing morning and
evening manual commands must retain their contracts. Production service activation
is not part of a source-only implementation or a synthetic test acceptance.

## Status

Source inspection complete; service composition implementation and the above
acceptance cases remain pending. This document does not mark backlog 12 complete.

## Implemented configured execution path

`service run` and `service once` accept the existing native-evening configuration
format through `--input` with its matching existing private key through `--key-file`.
Both are required together. The signing/source/daily-budget validation is reused
from the evening command before any daily schedule is prepared. No new key is
created. Staged control-channel execution rejects this combination explicitly.

DailyServiceCycles builds the concrete stored morning and signed native-evening
executors, performs startup recovery separately for each, then calls cycle on
subsequent iterations. Per-instance overlap is rejected; persisted daily leases
and identities govern competing instances. Each phase returns its own processed
cycle result or error code. A processed cycle is not an artifact-success claim;
completed_run_ids contains only the loop's completed runs. Existing artifact and
ledger readers remain authoritative for publication and failure status.

The CLI drives daily cycles before the coordinator cycle, so a disconnected
coordinator does not prevent local daily publication. A fatal coordinator error
still follows the existing fail-closed service behavior. Long-running service
prints structured service.daily phase results only when their value changes,
including before a possible coordinator failure. No daily configuration preserves
the prior command envelope. External refresh remains explicitly unavailable;
retention and staged-channel daily execution are not activated.

Example (prepared isolated DB and existing fixture key/config):

```sh
node dist/src/cli.js service run --once --db /absolute/path/to/test.sqlite --input /absolute/path/to/daily.json --key-file /absolute/path/to/existing-key.pem
```

Remove `--once` for the explicitly configured repeated process. This is an execution
command, not a readiness probe; it can publish local daily artifacts.

## Parent acceptance evidence

- Final lint, typecheck and backend build exited 0. Related 6 files / 46 tests
  passed, including manual daily commands, runtime ownership and observation health.
- New 4 tests cover morning and separate-process evening completion, startup replay,
  missing key option without daily writes, morning-error isolation, rejected cycle
  overlap, and morning-to-evening repeated cycles with one native publication.
- Actual compiled long-running CLI harness: first child 6 cycles with injected
  morning/evening clock, restarted child 3 cycles. Both intentionally stopped with
  SIGTERM. Two daily phases completed; native evening publication count 1; daily
  run rows unchanged across restart. Changed phase outputs: 4 then 2, with no
  consecutive identical phase output. Fixture coordinator was disconnected.
- QA root /home/jm/.cache/jarvis-test-runtime-qa-20260908:
  daily-service-final-tests.log, daily-service-live/run.mjs and receipt.json.
  Initial QA config used an invalid two-character key ID and was rejected before
  any cycle; corrected synthetic key ID passed. No product validation was bypassed.
- Native independent acceptance: ship/no findings. Full canonical gate for this diff remains pending.
  Provider refresh, retention composition and production activation remain pending;
  this is not completion of backlog 12 or the full 01–25 objective.

## Final independent acceptance

`/root/daily_service_acceptance` returned ship/no findings on the executable diff
and first five service regressions. Requested gpt-5.6-luna/max; actual model/effort
metadata and observed token usage unavailable. No external review service used.
After review, a sixth regression verified missed recovery writes state=failed with
MISSED_RECOVERY_WINDOW and no completed run. Its first expected state name was
incorrect; corrected against DailyLoopStore.omit without changing product code.
Final focused file: 6 tests passed; ESLint exit 0. Evidence: daily-service-six-tests.log
in the QA root. The earlier 6-file/46-test result remains valid for executable code.
API-equivalent cost receipt unavailable; no observed cost or savings is claimed.
