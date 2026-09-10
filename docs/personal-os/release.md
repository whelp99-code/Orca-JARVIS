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
The copied `scripts/cli-smoke.mjs` belongs to that payload vector and is the script
the packager executes. To rerun from the package directory, set `TMPDIR` to an
existing private scratch directory and run `node scripts/cli-smoke.mjs`.
This rerun uses the packaged CLI and production dependencies, without a source checkout.
The packaged runtime identity CLI must also report matching source/input/artifact
identity and toolchain without creating the deliberately missing probe database.

The success receipt is runtime-package-receipt.json. Failures after output creation
retain diagnostic output without that receipt. Argument or parent-path errors may
fail before any output exists. npm cache misses fail instead of switching to an online install.
Subprocess failures include failed_step (log filename), exit_code and signal in
the error JSON; dependency/build log contents are not included in that response.
The package is a developer validation artifact with deployment_ready=false; it must
not be activated as a release. Provider, browser, reproducibility and sealed-manifest
gates are not established by CLI smoke. Runtime dependencies target the current host.

The receipt also records a separate `dependencies` vector for installed node_modules:
file contents, modes, directories and relative symlink targets. It excludes no
manifest filenames and is compared before and after validation. This local digest
is not a signature. To independently check a retained package, run from its root:

```bash
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { runtimeDependencyIdentity } from './dist/src/personal-os-release-manifest.js';
const receipt = JSON.parse(readFileSync('runtime-package-receipt.json', 'utf8'));
const matches = runtimeDependencyIdentity('node_modules').digest === receipt.dependencies?.digest;
console.log(JSON.stringify({ dependency_identity_matches: matches, deployment_ready: false }));
process.exitCode = matches ? 0 : 1;
JS
```

Two complete offline package runs at 43fc8e7 on Node24.19.0/Linux x64 produced
identical source identities,1395payload file entries and2843dependency entries.
Both recorded vectors were rehashed from disk and matched. This is a same-host,
same-cache repeat-build observation; cross-host reproducibility, signed manifests
and production readiness are still unproven. See the development execution log.


### Packaged dashboard HTTP smoke

After packaging, run from the source checkout:

```bash
node scripts/packaged-dashboard-http-probe.mjs /absolute/package/root /absolute/new-receipt.json
```

The probe uses the supplied package's entrypoint, dependencies and static assets
with a private migrated database. It checks byte-identical HTML/JS/CSS, health,
session establishment and a CSRF-bound proposal preview preserving requirements
and a digest. A missing production planner fails even when static assets/health pass.
It performs no staging, approval or provider candidate generation. Runtime capability
version probes may run as part of preview. This remains developer HTTP evidence,
not browser interaction, production activation or deployment readiness.

### Recheck a retained runtime package

From a trusted development checkout with its backend already built, run:

```sh
node scripts/verify-runtime-package.mjs /absolute/package/root --receipt-sha256 <previously-recorded-64-hex-receipt-hash>
```

Keep the expected receipt hash independently when the candidate is accepted; do
not derive a replacement hash from a suspect candidate at verification time. The
command reads the candidate without importing or executing its code. It checks
the pinned receipt, required payload roots, installed dependency inventory, and
recorded backend identity. Nested node_modules/.git trees in payload roots are
rejected because the build file walker otherwise skips those names.

This checks the recorded payload and dependency scopes, not arbitrary files beside
them (such as package build logs). Run against a quiescent candidate; it does not
lock files against concurrent replacement. A matching local digest is not a
signature, source attestation, fresh runtime test, or production activation gate.
The result reports signature_verified=false, runtime_validation=not_performed and
deployment_ready=false even on success. Failures exit1 with a structured code.
