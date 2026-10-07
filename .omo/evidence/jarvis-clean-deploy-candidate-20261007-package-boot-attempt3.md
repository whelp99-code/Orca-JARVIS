# Candidate isolated boot attempt3

## Outcome

**BLOCKED in prerequisite step1: COPY_MODE_SIZE_HASH_OR_LINK_CHANGED.** The two requested corrections are implemented in new isolated controllers: explicit host/static-root argv and verbatim relative-link copying. Actual candidate copy preserves all four links, file sizes and file hashes, but two directory permissions differ (0700 source, 0775 copy). The mode comparison exited1; it was not weakened, repaired or rerun. No candidate dashboard/health/shutdown, prior copy, backup, rollback or prior restart was executed in attempt3. Acceptance remains1/3; PR65 draft and Project In Progress.

## Frozen source and prior failures

Repository branch release/jarvis-clean-candidate-20261007 began clean at a716f6f64dec4845af03a5d901ba4dba60b35333. Code baseline remains7669b34e6309e93e6f7c9b3a70ffed3cbd76dd0f; built candidate source936a24f322974e6efd1893d0da91424f3bf18f3a, prior7f2bdf081f66aadd19c45b29d27dfe4e399b23f1. Source receipts report dirty=false/tracked_dirty=false. Diff from the code baseline contains only evidence. Existing ecc5f0c and a716f6f commits remain ancestors. This publication adds only this evidence document.

54 existing attempt1/2 log/JSON/control files were hashed before work and all hashes remained unchanged after the failed setup. This includes terminal-failure.json, recovery-blocked-step2.json, original plan/attempt2 profile, original controllers, original install failure records and boot failure records. Exact preservation map: /home/jm/.omo/isolated/jarvis-candidate-936a24f/control/preflight-attempt3.json and control/preserved-evidence-attempt3.json. No source, test, repository config or lockfile was changed.

## Direct original diagnosis quotes

Actual failed attempt2 argv (PID2537875):

```text
/home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt2/releases/936a24f322974e6efd1893d0da91424f3bf18f3a/dist/src/dashboard/main.js --db /home/jm/.omo/isolated/jarvis-candidate-936a24f/data/authority-attempt2.sqlite --port 0
```

Source src/dashboard/main.ts:79:

```typescript
if (values.host !== LOOPBACK) throw new JarvisError("LOCAL_SESSION_REQUIRED");
```

Packaged dist/src/dashboard/main.js:55-56:

```javascript
if (values.host !== LOOPBACK)
    throw new JarvisError("LOCAL_SESSION_REQUIRED");
```

Source src/dashboard/main.ts:83-85 (packaged main.js:62-64):

```typescript
if (typeof values["static-root"] !== "string" || values["static-root"].length === 0) {
  throw new JarvisError("VALIDATION_ERROR");
}
```

The quoted argv lacks --host and --static-root, confirming the requested diagnosis. LOCAL_SESSION_REQUIRED here is the loopback argv guard, not a missing issued session. No session credential workaround is introduced. Exact source/package/probe excerpts are preserved in control/preflight-attempt3.json.

## Bounded controller correction

New controller: control/boot-private-package-attempt3.mjs. Its argv is packaged main.js --host127.0.0.1 --port0 --db<isolated authority-attempt3.sqlite> --static-root<selected package>/dist/dashboard, with separate argv tokens. That is the existing scripts/packaged-dashboard-http-probe.mjs contract. The first health assertion uses that probe's /api/v1/health and status=ok/authority=ready; the original controller's stale /api/health and authority.ready were not used as a false oracle. No application route/assertion or source guard was changed. The original probe is not executed because its PATH-only environment would drop the required isolation.

The new command runner retains the exact attempt2 environment: HOME/TMP/TEMP/XDG_CACHE_HOME/XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_STATE_HOME and every JARVIS provider/data/config root stay inside /home/jm/.omo/isolated/jarvis-candidate-936a24f; no ambient credentials or production HOME are inherited. Existing two distinct empty npm configuration files and cache are unchanged. Only the existing server's process-memory session creation would be used; server.ts defaults to createDashboardSession(). No session request, permanent token/key issuance, credential copy or bypass was performed.

Node syntax checks exited0 for the new boot, command-runner and setup controllers. Exact check command:

```text
/home/jm/.nvm/versions/node/v24.19.0/bin/node --check /home/jm/.omo/isolated/jarvis-candidate-936a24f/control/boot-private-package-attempt3.mjs && /home/jm/.nvm/versions/node/v24.19.0/bin/node --check /home/jm/.omo/isolated/jarvis-candidate-936a24f/control/run-command-attempt3.mjs && /home/jm/.nvm/versions/node/v24.19.0/bin/node --check /home/jm/.omo/isolated/jarvis-candidate-936a24f/control/setup-private-runtime-attempt3.mjs
```

Those quick checks did not record an elapsed duration. Private controller LSP is unavailable because that directory has no TypeScript installation; no package installation or diagnostic suppression was used. Repository source is unchanged, so repository source tests/build were NOT_RUN for this evidence-only commit.

## New copy and strict failed qualification

Source /home/jm/.omo/isolated/jarvis-candidate-936a24f/packages/jarvis-runtime-RHpbXt; new empty destination /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt3/releases/936a24f322974e6efd1893d0da91424f3bf18f3a. Original package and releases-attempt2 were preserved. fs.cpSync options: recursive=true, dereference=false, force=false, errorOnExist=true, verbatimSymlinks=true. All original links must be relative, and every target is checked both lexically and by realpath inside the copied root. PACKAGE_LINK_ESCAPES stays unchanged in the existing package-inventory.mjs.

Complete read-only source/copy comparison covered8539 entries. No file size/hash or link-target difference was found. Exact permission failures:

| Path relative to package | Original mode | Copy mode |
| --- | --- | --- |
| package root | 0700 | 0775 |
| smoke-state/jarvis-cli-smoke-WP7tmn | 0700 | 0775 |

All copied .bin links are unchanged relative strings and resolve inside the copy:

- node_modules/.bin/node-which -> ../which/bin/node-which
- node_modules/.bin/prebuild-install -> ../prebuild-install/bin.js
- node_modules/.bin/rc -> ../rc/cli.js
- node_modules/.bin/semver -> ../semver/bin/semver.js

No chmod, copy retry, inspection exclusion or relaxation was performed. The failure is preserved in control/terminal-failure-attempt3.json with the exact differences, link observations, command exit and raw log hash. The failed setup stopped before prior copy, private attempt3 DB initialization, current activation or dashboard spawn. Those missing steps are NOT_RUN rather than claimed as passed. Existing fixture DB is untouched.

## Whole-package identities

Hash algorithm is the existing sorted TSV manifest of all regular files and symlink target strings. It excludes directory modes by its original definition; a matching digest therefore cannot overrule the separate failed mode comparison.

| Artifact | Files | Links | Bytes | Original sorted-manifest SHA-256 |
| --- | ---: | ---: | ---: | --- |
| Original candidate | 7628 | 4 | 62128440 | 8340403ced708586bfae9e5bfa83f4ac5351643d289928234da3f5ffd1da797b |
| Candidate attempt3 copy | 7628 | 4 | 62128440 | 8340403ced708586bfae9e5bfa83f4ac5351643d289928234da3f5ffd1da797b |
| Original prior (not copied in attempt3) | 7628 | 4 | 62128312 | 63e31f6d372a888e372efa3f9ab76f54714cf0bccecf30373fbf5496816e7b74 |

Copy full manifest: /home/jm/.omo/isolated/jarvis-candidate-936a24f/logs/candidate-copy-attempt3-manifest.tsv. Original manifests/receipts are retained at the original attempt2 paths. No packaging reexecution occurred. Entry/native SHA-256 values match the original:

- dist/src/cli.js: a7a5bcd447d31cd1ae8c2f1c07c1b13c21797a2e5c9174d733b49e22e52d336a
- dist/src/dashboard/main.js: c724c52625bc89130ecd4364993e6e9fb47ddefd33e035154f21be24afd392a3
- node_modules/better-sqlite3/build/Release/better_sqlite3.node: 45cb92a176fb758533db6d9a343acdfc73e4de27ac4c20a0cb2a6fb5be3e84f2

## Actual command ledger

| Command label | Exit | Elapsed ms | Raw log SHA-256 |
| --- | ---: | ---: | --- |
| setup-runtime-attempt3 | 1 | 708.893 | 7c13afd7850b6b7a7efcd3d1736e24e22df06ab75ec5f4b201344fc721bc9341 |
| inventory-copy-candidate-attempt3 (independent read-only identity record) | 0 | 244.084 | 945c0946b327e5a79e705590a9dda465b8617fbb6d7cf256157bbcc76525eeb2 |

Exact commands, cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f:

```text
node control/setup-private-runtime-attempt3.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/packages/jarvis-runtime-RHpbXt /home/jm/.omo/isolated/jarvis-candidate-936a24f/prior-packages/jarvis-runtime-vlBWJw
node control/package-inventory.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt3/releases/936a24f322974e6efd1893d0da91424f3bf18f3a candidate-copy-attempt3
```

Both commands are started through /home/jm/.omo/isolated/jarvis-candidate-936a24f/control/run-command-attempt3.mjs, which retains the isolated profile and records start/end timestamps, argv, exit/signal and raw-log SHA. Full raw transcripts and sibling JSON: /home/jm/.omo/isolated/jarvis-candidate-936a24f/logs/setup-runtime-attempt3.log/.json and logs/inventory-copy-candidate-attempt3.log/.json. The independent successful inventory is not a retry of the failed copy/mode qualification, and does not license boot.

## Acceptance and publication boundaries

1. Original pinned package creation: evidenced by attempt2 and preserved here.
2. Isolated healthy boot/normal shutdown: NOT_RUN in attempt3. New prerequisite permission failure blocks execution.
3. Actual prior rollback/restart/schema/data preservation: NOT_RUN in attempt3. Existing previous-runtime restore contract was read and a private backup-controller copy prepared, but never executed. No systemd/launchd command was run.

Project remains In Progress, PR65 stays draft, and Issue64's boot/rollback criteria remain open. No production service/DB/port/HOME, shared-main dirty file, other branch/PR, merge/ready/force-push or private credential output. All generated controller/log/copy paths are inside the existing isolation; only this authorized evidence document and PR65/Issue64 metadata are published outside. Evidence commit uses the existing private no-write-hooks path to avoid the shared post-commit canonical inventory writer; inventory synchronization is NOT_RUN.

JARVIS_CANDIDATE_PKG_BOOT_ATTEMPT3_BLOCKED reason=COPY_MODE_SIZE_HASH_OR_LINK_CHANGED step=1
