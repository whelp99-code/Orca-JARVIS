# Stored-source morning systemd candidate

Date: 2026-09-09. Backlog 12.

The existing morning CLI has no systemd deployment candidate. Add a user oneshot
service and a daily timer at 07:15 Asia/Seoul, matching `dailyLoopSchedules`.
These are uninstalled candidates outside the frozen production unit inventory.

## Execution

The service invokes the pinned Node 24.19.0 executable and the authority current
release's `daily morning --once` command. The explicit database is the authority
database; the operator provides `/home/jm/.config/orca-jarvis/morning.json` using
`config/daily-morning.example.json` as the closed version-1 configuration reference.
If the same database contains signed evening results, morning configuration must
also provide the matching `trusted_closeout_key`; it must not skip evening costs.

The service uses the same filesystem hardening as the evening candidate. The
JARVIS state directory is the persistent writable exception; private temporary
storage remains available and configuration is read-only. It does not create
configuration, signing keys, migrations, or source data. A 660-second process
timeout accommodates the example's 600-second deadline and cleanup; it does not
extend the CLI's configured deadline or lease. Larger custom deadlines still face
this process limit. There is no automatic failure restart.

`Persistent=true` requests a catch-up activation, not replay of every missed day.
The CLI's startup recovery handles current-day eligibility and configured recovery
limits, leaving prior missed schedules in the ledger. Before today's 07:15 it may
return success with no current-day run. Outside the recovery window it can return
a structured failure. Service exit 0 alone is not proof of a completed brief.

This command uses stored local recommendations. Provider refresh is explicitly
unavailable and automatic operation remains HOLD in its result. The timer cannot
turn stale data into fresh evidence or create an external refresh producer.

## Validation and activation boundary

Validate without installation:

```sh
systemd-analyze --user verify deploy/jm-jarvis-morning.service deploy/jm-jarvis-morning.timer
systemd-analyze calendar --base-time='2026-09-08 00:00:00 UTC' --iterations=2 '*-*-* 07:15:00 Asia/Seoul'
```

Expected calendar events are September 8 and 9 at 22:15 UTC, corresponding to
September 9 and 10 at 07:15 KST. Parser checks do not prove runtime execution.

Before production activation, select a tested immutable release and ready schema,
provision policy/configuration and shared evening trust, verify actual sources,
exercise duplicate invocation, missed schedules and timeout recovery with the
exact installed unit, and update the unit inventory and rollback procedure.
Follow the existing operator activation gate. Do not bulk-install `deploy/*`.
The morning and evening candidates are separate from the GJC coordinator service.

## Local execution evidence

Unit verification and calendar analysis exited 0. The calendar resolved both dates
above. The host's unrelated spice-vdagent unit emitted its existing unknown
StandardError-in-Install warning. No directive was removed to pass verification.

Three actual transient user services, `jarvis-qa-morning-1105296-{valid,replay,invalid-config}`,
used the candidate's service properties, remapping the working directory and
executable to the development build and writable DB/config to a private cache.
The CLI clock was injected as 2026-09-09 07:15:01 KST; systemd kept its real clock.
First/replay/invalid config exited 0/0/2. The first completed one morning run and
two steps; replay added zero completions; invalid input returned
`DAILY_LOOP_CONFIG_INVALID`. The empty source fixture yielded `no_data`, zero brief
items, usage 1/2/754, provider refresh unavailable and automatic operation hold.
All three transient units were collected (`LoadState=not-found`). Evidence:
`/home/jm/.cache/jarvis-test-runtime-qa-20260908/morning-systemd-udl4bQ/receipt.json`.

A separate real timer `jarvis-qa-morning-timer-1116818` triggered the same CLI after
two seconds. Test-only overrides were `OnActiveSec=2s`, remapped paths, the injected
CLI clock, output files, and `RemainAfterExit=yes` to retain exit metadata. It
produced one completed no-data run; systemd reported SubState=exited, Result=success,
ExecMainCode=1 and ExecMainStatus=0. After explicit cleanup both test units were
not-found. Evidence:
`/home/jm/.cache/jarvis-test-runtime-qa-20260908/morning-timer-WRk460/receipt.json`.

The initial timer harness failed while stopping already-unloaded test units,
masking its original error. A second harness run returned a structured completion,
but read ExecMainCode=0 before terminal exit, so it is not used as exit evidence.
Retaining the unit and waiting for SubState=exited fixed that observation gap; no
product change was needed. Reproduction scripts are `morning-systemd-live.mjs` and
`morning-timer-live.mjs` in the same evidence cache.

These checks establish transient sandbox execution and timer-to-CLI activation.
The exact production-path unit remains uninstalled. Daily wall-clock firing,
persistent catch-up after manager downtime, timeout recovery, actual source
freshness and operator activation remain HOLD. Empty fixture data is not evidence
that an operational morning brief contains useful work.
