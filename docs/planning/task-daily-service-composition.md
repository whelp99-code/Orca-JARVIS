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
