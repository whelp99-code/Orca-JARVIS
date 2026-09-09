# Personal OS Linux authority release

This is the executable-procedure source for Linux JARVIS/Second Brain releases. Historical Mac/LaunchAgent/control-center files are `HISTORICAL_NON_EXECUTABLE` and must not be cited as executable.

## Roots {#roots}

- `jarvis-authority-releases` = `/home/jm/.local/state/orca-jarvis/authority/releases/<40-hex>`
- `provider-app-releases` = `/home/jm/.local/state/second-brain/app/releases/<40-hex>`
- Activation is a `relative-current-symlink` updated by `atomic-rename`

Rehearsal command (isolated `--release-root` only):

This rehearsal validates fixture backup/restore and the release pointer mechanism.
Its payload contains selected files, not a complete executable application. An OK
result is not deployment readiness: output explicitly reports deployment_ready=false,
runtime_payload=incomplete and runtime_validation=not_performed. Do not activate
this fixture payload in production. Complete runtime packaging and execution of the
packaged CLI/health gates are required separately.

`personal-os-rehearsal` = `node scripts/personal-os-release-rehearsal.mjs --fixture test/fixtures/personal-os/full-loop.json --clock 2026-08-27T07:15:00+09:00 --release-root <isolated> --json`

## Health gates {#gates}

Before/after activation or rollback: `migration-vector` `quick-check` `foreign-key-check` `doctor` `status` `dashboard-health` `mcp-handshake` `scheduler-cursor` `uncertain-outbox`

## Rollback {#rollback}

Rollback is allowed only when `exact-migration-vector`, `provider-contract`, and `sealed-manifest` match the target release. Otherwise emit `RELEASE_ROLLBACK_INCOMPATIBLE` and leave `current` unchanged.

Owner gate for real activation: `production-activation-gate`.

## Isolated complete runtime package

From the development checkout, with an existing scratch parent and a populated npm
cache, run `node scripts/package-authority-runtime.mjs --output-parent <scratch-parent>`.
It creates a new jarvis-runtime-* directory, builds backend/dashboard, checks build
identity, copies runtime roots, installs locked production dependencies offline and
runs the real CLI smoke with isolated SQLite state. Required output files and modes
are hashed and rechecked; source HEAD, dirty state and toolchain are recorded.
The packaged runtime identity CLI must also report matching source/input/artifact
identity and toolchain without creating the deliberately missing probe database.

The success receipt is runtime-package-receipt.json. Failures after output creation
retain diagnostic output without that receipt. Argument or parent-path errors may
fail before any output exists. npm cache misses fail instead of switching to an online install.
The package is a developer validation artifact with deployment_ready=false; it must
not be activated as a release. Provider, browser, reproducibility and sealed-manifest
gates are not established by CLI smoke. Runtime dependencies target the current host.
