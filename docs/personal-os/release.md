# Personal OS Linux authority release

This is the executable-procedure source for Linux JARVIS/Second Brain releases. Historical Mac/LaunchAgent/control-center files are `HISTORICAL_NON_EXECUTABLE` and must not be cited as executable.

## Roots {#roots}

Every root below is *derived*, not fixed. `src/personal-os-deployment-roots.ts` resolves all of
them from the environment, and the values shown are what an unset environment produces — the
per-user installation that runs today. Report what a given build actually resolved with
`node dist/src/cli.js deployment roots` (it opens no database), and render the systemd units that
follow from it with `deployment render-units --out DIR`.

| Variable | Default | Reaches |
| --- | --- | --- |
| `JARVIS_STATE_ROOT` | `/home/jm/.local/state/orca-jarvis` | authority DB, backups, `authority/current`, `control-center/current`, protected roots, the publish scripts' production-DB test |
| `JARVIS_PROVIDER_STATE_ROOT` | `/home/jm/.local/state/second-brain` | provider `app/current`, the MCP launcher, the `sb` CLI, request queue |
| `JARVIS_PROVIDER_CONFIG` | `/home/jm/.config/second-brain/config.toml` | `SB_CONFIG`, and the `request-executor.enabled` marker beside it |
| `JARVIS_PROVIDER_SHARE_ROOT` | `/home/jm/.local/share/second-brain` | provider maintenance `ReadWritePaths` |
| `JARVIS_SHARE_ROOT` | `/home/jm/.local/share/jarvis` | protected roots |
| `JARVIS_CONFIG_ROOT` | `/home/jm/.config` | protected roots (`systemd`, `orca-jarvis`) |
| `JARVIS_BIN_ROOT` | `/home/jm/.local/bin` | generated units' `PATH` (per-user renders only) |
| `JARVIS_NODE_BIN` | `/home/jm/.nvm/versions/node/v24.19.0/bin/node` | every generated unit's interpreter, and the publish scripts |
| `JARVIS_SERVICE_USER` | unset | when set, units render as **system** units with `User=`/`Group=`, `ProtectHome=yes` and `WantedBy=multi-user.target` |
| `JARVIS_DAILY_SERVICE_CONFIG` | unset | when set with the key below, `jm-jarvis.service` renders `service run … --input <path>` and the unit schedules the daily morning and evening phases |
| `JARVIS_DAILY_CLOSEOUT_KEY` | unset | the Ed25519 closeout signing key (mode 0600, owned by the unit's account) that `--key-file` names |

An override must be an absolute, already-canonical path, or resolution refuses with
`E_DEPLOYMENT_ROOT` — these paths are *compared* (protected-root and production-backup checks), not
just opened, so a path that normalises to something the operator did not write is refused rather
than accepted.

The two daily-loop variables are set together or not at all: `service run` refuses one flag without
the other (`DAILY_LOOP_CONFIG_INVALID`), and resolution refuses half a configuration with
`E_DEPLOYMENT_ROOT` rather than letting `Restart=always` become a crash loop. Unset is *off*: the
rendered `ExecStart` carries no daily flags and the unit schedules no phase. Set is *load-bearing*:
the service fails closed on those two inputs instead of silently running a day with no morning and
no evening. Both paths must be readable by the unit's account, so keep them under
`${JARVIS_STATE_ROOT}` (the authority's `ReadWritePaths`).

`JARVIS_SERVICE_USER` exists for the retention/compaction lane. That lane can only prove exclusion
when every same-UID process is the authority's own (`docs/local-retention-operations-proposal.md`),
which means running under a dedicated account whose state is not in anyone's home.

Proving exclusion is necessary and not sufficient: the lane also needs an entry point.
`service once|run --local-retention-config PATH` is the only one. Unset is *off* - no swap runtime
is built, the process registers nothing, and no window opens; the rendered `ExecStart` carries no
such flag, so a deployment that does nothing gets nothing. Set is *load-bearing* and fails closed on
a relative path, on any command but `service once|run`, and inside a control-channel cycle
(`LOCAL_RETENTION_CONFIG_INVALID`). The document it names is the closed two-field record
`{"schema_version":1,"retain_ms":N}` with `retain_ms` between 5 minutes and 365 days; keep it under
`${JARVIS_STATE_ROOT}` so the unit's `ReadWritePaths` already covers it. The window is fixed at six
hours and is not a flag - the span the operator chooses is the retained one, and a destructive
rebuild earns no second knob. Each cycle claims that window before it attempts anything, so asking
on every tick still yields one attempt per window, and every outcome but `failed` - including the
refusal to replace a database the process could not prove it alone holds - is reported as the lane's
own answer on `service.local-retention`.

- `jarvis-authority-releases` = `${JARVIS_STATE_ROOT}/authority/releases/<40-hex>` (default `/home/jm/.local/state/orca-jarvis/authority/releases/<40-hex>`)
- `provider-app-releases` = `${JARVIS_PROVIDER_STATE_ROOT}/app/releases/<40-hex>` (default `/home/jm/.local/state/second-brain/app/releases/<40-hex>`)
- Activation is a `relative-current-symlink` updated by `atomic-rename`

Rehearsal command (isolated `--release-root` only):

`PERSONAL_OS_REHEARSAL_OK` is emitted only after the isolated root has built a
checksummed JARVIS release, rendered hardened units that point at `authority/current`
without installing them, migrated a cloned fixture database, activated the isolated
`current` symlink, and passed `quick_check`, `jarvis doctor --json`, dashboard health,
scheduler/lease, a real Second Brain MCP handshake, and the uncertain-outbox gate.
The same run proves no-data boot, Mac-disconnected brief → virtual approval → worker
→ verification → fixture artifact → closeout → restart, backup → destroy → new-generation
restore with tombstone replay, and both rollback branches. `deployment_ready` stays
false because production activation is skipped. `--scenario <name>` runs one of
`second-brain-no-data`, `second-brain-offline`, `mac-disconnected`,
`schema-incompatible-rollback`, `jm-server-offline`, `crash-after-dispatch`,
`lost-memory-response`, `expired-passkey`, `delete-sentinel`, `restore-tombstone`,
or `rollback`. Each scenario reports unauthorized, duplicate, stale-authoritative,
and deletion-leak counts. Mac Electron QA and phone QA are not part of this command;
the JSON names the Linux dashboard `127.0.0.1:4173` and phone gateway `127.0.0.1:4176`
/ tailnet `8444` endpoints those steps target. Do not point `--release-root` at a
protected production root.

`personal-os-rehearsal` = `node scripts/personal-os-release-rehearsal.mjs --fixture test/fixtures/personal-os/full-loop.json --clock 2026-08-27T07:15:00+09:00 --release-root <isolated> --json`

## Health gates {#gates}

Before/after activation or rollback: `migration-vector` `quick-check` `foreign-key-check` `doctor` `status` `dashboard-health` `mcp-handshake` `scheduler-cursor` `uncertain-outbox`

All nine run together from the packaged CLI. The aggregate prints one JSON report and exits `1`
when any gate fails, so a caller branches on process status without parsing the report:

```sh
node dist/src/cli.js release gates --db <db-path> [--dashboard-url URL] \
  [--phase pre-activation --rehearsal-receipt <path> | --phase post-activation]
```

Each gate answers from its own read-only connection and none of them migrate, so `release gates`
runs before migrations are applied and reports pending migrations instead of requiring them.

### Phases {#gate-phases}

`jm-jarvis.service` applies the pending migrations in its own `ExecStartPre`, so the two sides of
the restart are not the same question and `release gates` takes an explicit `--phase`. The phase is
recorded in the report as `phase`.

- `--phase post-activation` (the default, so an unphased call is the strict one): `migration-vector`
  requires zero pending migrations and an applied vector equal to the release's own shipped vector.
- `--phase pre-activation --rehearsal-receipt <path>`: the pending migrations are exactly the ones
  the service is about to apply, so they are the expected state. The gate passes when the receipt
  written by `db migrate --rehearse` shows that *this* database rehearsed onto *this* release's
  vector: the receipt's `source_vector_digest` equals the database's current applied-vector digest,
  its `target_vector_digest` equals the release's expected vector digest, and its checks report
  `quick_check: "ok"` with `foreign_key_violations: 0`. The passing gate records
  `accepted_via: "rehearsal-receipt"` and the receipt it accepted.
- Pre-activation without a receipt is `RELEASE_GATE_REHEARSAL_RECEIPT_REQUIRED`; an unreadable,
  malformed or failed receipt is `RELEASE_GATE_REHEARSAL_RECEIPT_INVALID`; a receipt for another
  database or another release is `RELEASE_GATE_REHEARSAL_VECTOR_MISMATCH`; failed rehearsal checks
  are `RELEASE_GATE_REHEARSAL_CHECKS_FAILED`. A `--rehearsal-receipt` offered post-activation and an
  unknown `--phase` value are both `RELEASE_GATE_INPUT_INVALID`.
- A checksum mismatch or an applied migration the release does not ship fails in **both** phases:
  neither is a pending migration, and no receipt licenses them.
- The `doctor` gate reads the same database through doctor's own checks, so pre-activation it would
  otherwise repeat the accepted pending vector as two failures of its own. Against a migration-vector
  gate the receipt accepted, those two findings are listed under `deferred_to_rehearsal` in the
  doctor gate's `actual` and no longer fail it; every other doctor failure still fails, and
  post-activation nothing is ever deferred. `doctor` itself is unchanged and stays strict for its
  own callers — the phase lives in the gate.

| Gate | Command | What fails it |
| --- | --- | --- |
| `migration-vector` | `release gates` | checksum-mismatched or unsupported applied migrations in either phase; pending migrations post-activation, or pre-activation without a matching rehearsal receipt |
| `quick-check` | `release gates` | `PRAGMA quick_check` other than `ok` |
| `foreign-key-check` | `db foreign-key-check --db PATH` | any `PRAGMA foreign_key_check` row |
| `doctor` | `doctor --db PATH` | any failing doctor check, except that pre-activation, against an accepted rehearsal receipt, `database.migration_count` and `database.migration_checksums` findings explained by the pending-but-rehearsed migrations are reported as `deferred_to_rehearsal` instead |
| `status` | `status --json --db PATH` | unacknowledged outbox entries |
| `dashboard-health` | `release dashboard-health [--dashboard-url URL]` | non-200, malformed, oversize, timeout, or a body that is not `status=ok`/`authority=ready` |
| `mcp-handshake` | `release mcp-handshake` | any refusal of the real stdio handshake, or a negotiated protocol other than the pinned one |
| `scheduler-cursor` | `release scheduler-cursor --db PATH` | `applied_count` other than `last_completed`, a cursor behind the completed `daily_loop_runs`, or an absent cursor while `PERSONAL_OS_CONTROL_CHANNEL` is configured |
| `uncertain-outbox` | `release gates` | any `uncertain` memory outbox or daily loop row |

`dashboard-health` GETs `/api/v1/health` on the configured loopback endpoint (`127.0.0.1:4173`,
pinned by `config/dashboard-runtime.schema.json`) with a bounded timeout and a bounded body.
`mcp-handshake` performs a real handshake through the Second Brain stdio transport contract and
reports the negotiated protocol version and the contract profile; it honours
`JARVIS_SECOND_BRAIN_LAUNCHER` and `JARVIS_SECOND_BRAIN_CONFIG`, so an isolated provider can be
gated without touching a deployed installation. Every gate fails closed: an unreachable,
unreadable or unparseable answer is a failure, never a skip.

`personal_os_cycle_cursor` is created by no migration — only `service run` creates it, lazily, and
only when `PERSONAL_OS_CONTROL_CHANNEL` is set. On a deployment that configures no control channel
the table therefore never exists and there is no cursor that can be wrong: `scheduler-cursor`
reports `not_applicable: true` with `control_channel_configured: false` and the reason in its own
`actual`, and passes. With a control channel configured the table is promised, so an absent cursor
is still `RELEASE_GATE_SCHEDULER_CURSOR_ABSENT`, and a cursor that exists is always judged. That is
the only applicability exemption among the nine gates.

## Migration rehearsal {#migration-rehearsal}

`jm-jarvis.service` runs `db migrate` in `ExecStartPre`, so every restart of the authority applies
whatever migrations are pending against the real database, before `service run` starts. That is the
unit's behaviour and this procedure does not change it. What it means is that the migration is not
a separate, cancellable step at activation time: by the time a restart has been requested, the
migration has already been attempted.

A rehearsal must therefore pass before activation:

```sh
node dist/src/cli.js db migrate --rehearse <db-path> [--rehearsal-receipt <out-path>]
```

It copies the database and its `-wal`/`-shm` sidecars into a private scratch directory (`TMPDIR`),
applies the pending migrations to the copy, and gates the copy with `quick-check`,
`foreign-key-check` and the `migration-vector` check. It reports the migrations it applied, the
level before and after, and the source's digest. The source database is only ever read: it is
hashed before and after, a rehearsal that observed any change to it fails with
`MIGRATION_REHEARSAL_SOURCE_MUTATED` instead of reporting a result, and the scratch copy is removed
when the rehearsal ends. The rehearsal exits `1` if any of the three gates on the copy fails.

With `--rehearsal-receipt <out-path>` it also writes the receipt a pre-activation gate run reads,
created exclusively and 0600 so an existing receipt is never replaced
(`MIGRATION_REHEARSAL_RECEIPT_UNWRITABLE`). The receipt records `kind: "migration-rehearsal"`, the
source observation, `source_vector_digest` (the vector the source database is on) and
`target_vector_digest` (the vector the rehearsed migration landed on), the applied migration list,
the before/after levels, and `checks` holding `quick_check`, `foreign_key_violations` and
`migration_vector_ok`. Those are the fields `release gates --phase pre-activation` matches; see
[phases](#gate-phases).

A real deployment can be many migrations behind its packaged release, so the rehearsal is what
tells you whether the `ExecStartPre` migrate a restart is about to run would succeed — never
activate a release whose rehearsal has not passed against the database that release will migrate.

## Rollback {#rollback}

Rollback is allowed only when `exact-migration-vector`, `provider-contract`, and `sealed-manifest` match the target release. Otherwise emit `RELEASE_ROLLBACK_INCOMPATIBLE` and leave `current` unchanged.

```sh
node dist/src/cli.js release rollback --to <40-hex> --release-root <root> --db <db-path> [--dry-run]
```

The three inputs are read from the release root, never supplied by the caller:

- `exact-migration-vector`: the vector the target expects — the target's own sealed
  source commit/tree from its `release.manifest.json`, bound to the `schema_migrations`
  applied to `--db` right now — must appear in the target's `release-compatibility.json`
  `accepted_vector_digests`. The target's identity is what the vector is bound to, not the
  running release's: the target accepted exactly this vector when it was published, so it
  matches only while the database is still at that schema. Binding the running release
  instead could never match a target published before that release existed.
- `provider-contract`: the `provider_contract_digest` in the target's
  `receipts/<40-hex>.json` must equal the payload digest of the published
  `provider-releases/current` manifest.
- `sealed-manifest`: the target's `release.manifest.json` must still hash to the
  `manifest_sha256` its receipt pinned, and carry the receipt's `payload_digest`.

Any disagreement, unreadable input or missing receipt raises the single documented
`RELEASE_ROLLBACK_INCOMPATIBLE`; the refusal path performs no filesystem mutation, so `current`
is left exactly where it was. `--dry-run` reports the same decision and never moves `current`.
On allow, `current` is replaced by a relative symlink through an atomic rename.

### The production root {#rollback-production-root}

Rollback is a production command, so the deployed authority root is reachable — but only when it is
asked for by name and the owner is present:

```sh
node dist/src/cli.js release rollback --to <40-hex> \
  --release-root /home/jm/.local/state/orca-jarvis/authority \
  --db <db-path> --production-root [--dry-run]
```

`--production-root` requires the same owner production-activation-gate evidence the publish
`--activate` requires: `JARVIS_PRODUCTION_ACTIVATION_APPROVAL=approved` in the owner's own
interactive shell, else `JARVIS_PRODUCTION_ACTIVATION_APPROVAL_REQUIRED`. Without the flag a
`--release-root` inside a protected deployed root is still refused with `E_PROTECTED_ROOT`, and the
evidence alone does not reach it: the flag is what names the root. Both refusals are decided before
anything is read, so neither touches deployed state. With both, the root is read like any other and
the same three checks decide the rollback.

### An unqualified target: restore the backup {#rollback-restore}

A release published before sealed manifests has no `release-compatibility.json` and its receipt no
`provider_contract_digest`, so none of the three checks above can be satisfied and a pointer-only
rollback is refused — correctly, because after the service's `ExecStartPre` migrate the database is
no longer on that release's schema. The recovery is to restore the backup and move the pointer
together, which is the second rollback form:

```sh
node dist/src/cli.js release rollback --to <40-hex> \
  --release-root <root> --db <db-path> --restore-backup <backup-file> [--dry-run] [--production-root]
```

It answers on the backup instead of on the three checks:

- the backup must pass `PRAGMA quick_check` (`RELEASE_RESTORE_BACKUP_UNUSABLE`), and be a regular
  file (`RELEASE_RESTORE_BACKUP_UNAVAILABLE`);
- the backup's own applied migration vector must equal the vector the **target release's shipped
  migrations** describe — read from the target's `dist/migrations`, else its `migrations/`, which a
  pre-manifest release still carries (`RELEASE_RESTORE_TARGET_VECTOR_UNAVAILABLE` when it ships
  none). A backup at any other level is refused with `RELEASE_RESTORE_VECTOR_MISMATCH`, because the
  target's own `ExecStartPre` would migrate it into a database that release was never run against.

On allow it restores the database atomically: the backup is copied beside the destination,
`quick_check`ed there, the database in place is renamed aside to `<db>.replaced-<utc>` together with
its `-wal`/`-shm` sidecars, and only then does the checked copy take the database's name — so the
replaced bytes are always kept and the restored database carries no stale sidecars. Then `current`
is switched to the target by the same relative-symlink atomic rename as an activation.

It stops and starts nothing itself. The result carries the order the operator performs around it as
`systemd_order` — stop the dashboard, stop the authority, confirm both inactive, run this command,
start the authority, start the dashboard — because a running authority would write to the database
being replaced, and the pointer must be moved before the restart that re-runs `ExecStartPre`.
`--dry-run` reports the same facts (both vector digests, the backup's `quick_check`, size and
sha256) and touches nothing.

Owner gate for real activation: `production-activation-gate`.

## Publishing a verified package {#publish}

`ops/authority/publish-package-release.sh` publishes the package it was given. It does not rebuild
from a worktree, so the bytes that were verified are the bytes that get published:

```sh
ops/authority/publish-package-release.sh \
  --package <verified-package-root> \
  --receipt-sha256 <independently-pinned-64-hex> \
  --release-root <root> \
  --db <db-path> [--backup-root <root>] [--dashboard-url URL] \
  [--rehearsal-receipt <path>] [--stage-parent <dir>] [--activate]
```

In order it: checks the owner gate when `--activate` was asked for (before publishing anything, so
a refused activation leaves nothing half-published); runs `scripts/verify-runtime-package.mjs`
against the candidate and the independently kept receipt hash; assembles and seals the payload on a
stage with files 0644 and directories 0755 under `umask 0022`, because the task verifier rejects any
published file with `mode & 0o022`; runs `release gates` against `--db` using the *staged* CLI —
that is, the candidate's own gates; runs the existing DB backup path (the production backup path
when `--db` is the production authority database, the isolated one otherwise); moves the sealed
stage into `<release-root>/releases/<40-hex source head>/` with one rename; activates when asked;
and only then writes `<release-root>/receipts/<40-hex>.json` recording the verification, gate
report, backup result and published payload modes.

The gates and the backup run **before** the rename, so a failing gate or a failing backup publishes
nothing at all and the retry is the same command. With `--rehearsal-receipt <path>` the gates run as
`--phase pre-activation` against that receipt (see [phases](#gate-phases)), which is the phase that
applies while the service has not yet run its `ExecStartPre` migrate; without it they run
`--phase post-activation`.

### An interrupted publish {#unpublish}

A release directory is complete only once its receipt exists. A directory without its receipt is an
interrupted publish (a crash or a kill between the rename and the receipt), and publishing that
release id again refuses with `PACKAGE_RELEASE_INCOMPLETE_PUBLISH`, naming the removal command in
its message — as opposed to `PACKAGE_RELEASE_ALREADY_PUBLISHED`, which is what a *receipted* release
raises.

```sh
ops/authority/publish-package-release.sh --unpublish <40-hex> --release-root <root>
```

That mode takes nothing else. It removes only a never-activated, receipt-less release directory:
`PACKAGE_RELEASE_UNPUBLISH_ACTIVE` if `current` points at it, `PACKAGE_RELEASE_UNPUBLISH_RECEIPT_PRESENT`
if a receipt exists, `PACKAGE_RELEASE_UNPUBLISH_ABSENT` if there is no such directory. It never
touches `current`, any receipt, any backup or any other release.

The release is assembled and sealed on a stage and moved in with one rename, because the manifest
library refuses to write inside a deployed root. `--stage-parent` (default
`<worktree>/.runtime-tmp`) must be on the same filesystem as the release root. Sealing writes, into
the release:

- `release-compatibility.json` — `accepted_vector_digests` holding the migration vector of `--db`
  bound to the release's own committed source identity, which is what a later
  `release rollback --to <this release>` compares against.
- `release.manifest.json` — written by the product's own manifest library from the committed
  provenance the package receipt carried, with a sidecar pinning its hash.

That provenance comes from the checkout that built the package: `scripts/package-authority-runtime.mjs`
records `source.tree` and `source.tracked_dirty` beside `source.head` in `dist/build-metadata.json`
and in `runtime-package-receipt.json`, and records the manifest's committed fields (commit, tree,
first parent, subject, commit timestamp, `git archive HEAD` digest) as `release_source` in the
receipt. A package built where no checkout can answer for HEAD carries none of this, and publishing
refuses it with `PACKAGE_RELEASE_SOURCE_TREE_ABSENT` rather than sealing a manifest against
invented provenance. Publishing never reads the checkout for provenance itself.

`current` is moved only when `--activate` is given *and*
`JARVIS_PRODUCTION_ACTIVATION_APPROVAL=approved` is present — a relative symlink replaced by an
atomic rename. Without `--activate` the release is published, gated and backed up, and `current` is
left exactly where it was. A failing gate, a mismatched pin, or an already-published release id all
refuse without publishing or activating. The release root, its `releases/` and its `receipts/` are 0700.

`ops/authority/publish-verified-release.sh` is the older worktree-rebuild script and is left
untouched.

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

Before hashing, a streaming directory scan limits payload paths to 32,768 entries
and dependency paths to 65,536 entries, with depth at most 64 and at most 256 MiB
of file/symlink sizes in each scope. Exceeding a limit returns PACKAGE_TREE_LIMIT.
Directory handles close on rejection. These limits assume the candidate remains
quiescent through the subsequent hash scan; they are not a total RSS guarantee.

This checks the recorded payload and dependency scopes, not arbitrary files beside
them (such as package build logs). Run against a quiescent candidate; it does not
lock files against concurrent replacement. A matching local digest is not a
signature, source attestation, fresh runtime test, or production activation gate.
The result reports signature_verified=false, runtime_validation=not_performed and
deployment_ready=false even on success. Failures exit1 with a structured code.
