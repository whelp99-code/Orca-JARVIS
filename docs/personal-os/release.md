# Personal OS Linux authority release

This is the executable-procedure source for Linux JARVIS/Second Brain releases. Historical Mac/LaunchAgent/control-center files are `HISTORICAL_NON_EXECUTABLE` and must not be cited as executable.

## Roots {#roots}

- `jarvis-authority-releases` = `/home/jm/.local/state/orca-jarvis/authority/releases/<40-hex>`
- `provider-app-releases` = `/home/jm/.local/state/second-brain/app/releases/<40-hex>`
- Activation is a `relative-current-symlink` updated by `atomic-rename`

Rehearsal command (isolated `--release-root` only):

`personal-os-rehearsal` = `node scripts/personal-os-release-rehearsal.mjs --fixture test/fixtures/personal-os/full-loop.json --clock 2026-08-27T07:15:00+09:00 --release-root <isolated> --json`

## Health gates {#gates}

Before/after activation or rollback: `migration-vector` `quick-check` `foreign-key-check` `doctor` `status` `dashboard-health` `mcp-handshake` `scheduler-cursor` `uncertain-outbox`

## Rollback {#rollback}

Rollback is allowed only when `exact-migration-vector`, `provider-contract`, and `sealed-manifest` match the target release. Otherwise emit `RELEASE_ROLLBACK_INCOMPATIBLE` and leave `current` unchanged.

Owner gate for real activation: `production-activation-gate`.
