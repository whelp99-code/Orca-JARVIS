# Candidate npm configuration recovery and isolated validation

## Outcome

**BLOCKED at step 2: LOCAL_SESSION_REQUIRED.** The authorized npm configuration collision is recovered and both actual runtime packages were produced. The selected candidate dashboard exited 2 before reporting a URL/port or health response. No correction or second boot was attempted. Isolated rollback/restart/data-preservation-after-rollback remain NOT_RUN; Project stays In Progress.

## Exact source and preserved first failure

Candidate package source: 936a24f322974e6efd1893d0da91424f3bf18f3a; code baseline: 7669b34e6309e93e6f7c9b3a70ffed3cbd76dd0f. Prior package source: 7f2bdf081f66aadd19c45b29d27dfe4e399b23f1. Both package receipts report source dirty=false and tracked_dirty=false. The existing candidate branch began at ecc5f0cb1f981d67869c2ed54422376f858c8262, adding only the first failure report to the same code. This new commit adds only this recovery evidence document. Publication HEAD is recorded in PR65 after commit, not self-embedded in this document.

No original failure artifact was deleted or overwritten; ecc5f0c remains an ancestor. Reverified original hashes:

| Preserved file | SHA-256 |
| --- | --- |
| /home/jm/.omo/isolated/jarvis-candidate-936a24f/logs/install-candidate.log | 250e369d730a46c4d41df37449a5c58c169b4b1d2ab546951a8bed0285805a95 |
| /home/jm/.omo/isolated/jarvis-candidate-936a24f/logs/install-candidate.json | b1de5c82a68c6be1957a27c2096c80cd7312f698a26056cb71df50064ac09380 |
| /home/jm/.omo/isolated/jarvis-candidate-936a24f/control/terminal-failure.json | 9e8214a14878c52d7808d0a844a9cf6c1a4821319369cafee107e5304751c6d6 |
| /home/jm/.omo/isolated/jarvis-candidate-936a24f/control/plan.json | afaac6454d2606e563ea9b9f3d7e34093263a54bcaf8772672c31439861c976a |

## Only authorized configuration correction

Two distinct empty files, both exactly 0 bytes:

- /home/jm/.omo/isolated/jarvis-candidate-936a24f/config/npmrc-user-empty
- /home/jm/.omo/isolated/jarvis-candidate-936a24f/config/npmrc-global-empty

New control profile: /home/jm/.omo/isolated/jarvis-candidate-936a24f/control/plan-attempt2.json. Compared with preserved control/plan.json, the only changed environment keys are npm_config_userconfig and npm_config_globalconfig, now naming those respective files. Isolated HOME and npm-cache paths are unchanged. User ~/.npmrc, global npm settings and token values were not read or copied.

The original runner/profile are preserved. The attempt2 runner reads the new profile and creates new labels/log filenames. Actual npm config resolution exited 0 and reported the two distinct configuration files and the existing isolated cache. Candidate dependency installation then exited 0 with 430 packages. This is the explicitly authorized execution-setting correction, not a failed-test rerun. No source/test/config/lockfile in the candidate or source snapshots was changed.

## Actual packages

Hash algorithm: recursively list all regular files and symlinks in the immutable built package, sort by relative path, serialize TSV columns path/type/bytes/SHA-256/link_target with header and final newline, then SHA-256 that exact manifest. Symlink digest covers its target string. Manifest files are outside package roots so no self-reference is introduced. These are artifact hashes, not production-publish approvals.

| Package | Source SHA | Output | Files | Symlinks | Bytes | Whole sorted-manifest SHA-256 |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Candidate | 936a24f322974e6efd1893d0da91424f3bf18f3a | /home/jm/.omo/isolated/jarvis-candidate-936a24f/packages/jarvis-runtime-RHpbXt | 7628 | 4 | 62128440 | 8340403ced708586bfae9e5bfa83f4ac5351643d289928234da3f5ffd1da797b |
| Prior | 7f2bdf081f66aadd19c45b29d27dfe4e399b23f1 | /home/jm/.omo/isolated/jarvis-candidate-936a24f/prior-packages/jarvis-runtime-vlBWJw | 7628 | 4 | 62128312 | 63e31f6d372a888e372efa3f9ab76f54714cf0bccecf30373fbf5496816e7b74 |

Full manifests:

- /home/jm/.omo/isolated/jarvis-candidate-936a24f/logs/candidate-package-attempt2-manifest.tsv
- /home/jm/.omo/isolated/jarvis-candidate-936a24f/logs/prior-package-attempt2-manifest.tsv

Entry/native hashes (the three are identical in the two built packages):

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| dist/src/cli.js | 1542 | a7a5bcd447d31cd1ae8c2f1c07c1b13c21797a2e5c9174d733b49e22e52d336a |
| dist/src/dashboard/main.js | 7471 | c724c52625bc89130ecd4364993e6e9fb47ddefd33e035154f21be24afd392a3 |
| node_modules/better-sqlite3/build/Release/better_sqlite3.node | 2122448 | 45cb92a176fb758533db6d9a343acdfc73e4de27ac4c20a0cb2a6fb5be3e84f2 |

The existing scripts/package-authority-runtime.mjs ran inside independent detached isolated source snapshots, not the original worktree. Packaging built backend/dashboard, installed production dependencies offline from the isolated cache, and passed its CLI smoke, dependency and runtime-identity checks. Builder receipts remain unchanged with deployment_ready=false: dashboard/provider/reproducibility are not automatically licensed by package creation. No receipt was altered to manufacture readiness.

## Command ledger and raw transcripts

All commands use the same explicit isolated profile, except the two authorized npm configuration paths. Every record below has a complete raw log and sibling command/argv/time JSON under /home/jm/.omo/isolated/jarvis-candidate-936a24f/logs. The existing first attempt's failure remains unchanged.

| Label | Exit | Elapsed ms | Log SHA-256 |
| --- | ---: | ---: | --- |
| config-resolution-attempt2 | 0 | 266.393 | 348a8a020b55d9f8b427701ac3ca5ff2731beb9e6c5ae1c8a6b5a9fb829d5bcb |
| install-candidate-attempt2 | 0 | 4419.948 | 069818cf03e54eae72d10cce228b0762dac0340e76c86a445a9c72ba9a399be2 |
| package-candidate-attempt2 | 0 | 20208.836 | 0d68c8c029f0add4b9c791265aea43181637afa27ce95512493daac86a926425 |
| install-prior-attempt2 | 0 | 2946.513 | 07c8dd63da60a4c65c67d76568d72120fb5ce8be7d629c735bfa441ce5492aeb |
| package-prior-attempt2 | 0 | 20295.130 | e78b6368a900b55a4780d21def1be2020aa08da10faaaacb2a12c3037d08fbcd |
| inventory-candidate-attempt2 | 0 | 205.660 | b50701e10667511f66b5f914720a20c5a703f7ee72aa7f002121788109d275b2 |
| inventory-prior-attempt2 | 0 | 210.801 | c7954122c363fbc0b66fe92ce412b02709ae7030a152987f60b7bb971552ba61 |
| initialize-private-attempt2 | 0 | 945.021 | 5d157d8b5ccf9e47212d29e1a30af445be793bf50478dab4cc6d41bb2abff73b |
| setup-runtime-attempt2 | 0 | 454.394 | cb1a8d2c6e281862a164031bfe06c54c88ddabe041e55ed2191b775f502586f4 |
| boot-candidate-attempt2 | 1 | 435.261 | 478d25aa96b1b94ad300d82a6f578f3d1debcd35b4a9998071616bfc40c09dc1 |
| inventory-selected-candidate-attempt2 | 1 | 82.760 | 8d30a0c029279e4e9b7d0bf549fc7728c01072e943653b97eabc2ee1f014ed05 |

Exact argv for each actual command:

```text
cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f/source-candidate
npm config get userconfig globalconfig cache

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f/source-candidate
npm ci --no-audit --no-fund

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f/source-candidate
node scripts/package-authority-runtime.mjs --output-parent /home/jm/.omo/isolated/jarvis-candidate-936a24f/packages

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f/source-prior
npm ci --no-audit --no-fund

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f/source-prior
node scripts/package-authority-runtime.mjs --output-parent /home/jm/.omo/isolated/jarvis-candidate-936a24f/prior-packages

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/package-inventory.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/packages/jarvis-runtime-RHpbXt candidate-package-attempt2

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/package-inventory.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/prior-packages/jarvis-runtime-vlBWJw prior-package-attempt2

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/initialize-private.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/packages/jarvis-runtime-RHpbXt

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/setup-private-runtime.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/packages/jarvis-runtime-RHpbXt /home/jm/.omo/isolated/jarvis-candidate-936a24f/prior-packages/jarvis-runtime-vlBWJw

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/boot-private-package.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt2/releases/936a24f322974e6efd1893d0da91424f3bf18f3a boot-candidate-attempt2

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/package-inventory.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt2/releases/936a24f322974e6efd1893d0da91424f3bf18f3a selected-candidate-package-attempt2
```

## Private database and actual boot failure

Packaged AuthorityDb migrated and initialized a new private fixture DB at /home/jm/.omo/isolated/jarvis-candidate-936a24f/data/authority-attempt2.sqlite with newly generated fixture public keys; no production keys or data were used. Integrity is ok, schema_migrations has 116 rows, trusted_authority_keys has 3 rows, and authority_configuration/audit_facts and verifier bindings contain actual fixture records. Snapshots hash all table rows rather than exposing their contents.

Initialized schema SHA-256: d10d7be84b1720fb9b6acea905d7724b30244625dadbd0c6556a91db8b70b5a6.
Initialized full logical-data SHA-256: 6a52da3825d0512effeaf4767181f63a756ebc64793a326e44ac6cb89cdb2607.
The two hashes and integrity remain identical after the failed startup. That is failed-startup preservation evidence only, NOT rollback/data-preservation-after-rollback evidence.

Runtime setup copied both actual packages into /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt2/releases/<exactSHA> and used the existing packaged activateRelease helper to select the candidate; observed current is releases/936a24f322974e6efd1893d0da91424f3bf18f3a. The boot invoked the actual selected packaged dashboard with the same private DB and --port 0 under isolated HOME/root variables. No production port was requested.

Actual child PID: 2537875. Requested port: 0; actual bound port/URL: not observed. Health response: not observed. Child exit: 2, signal=null. Controller exit: 1; total command elapsed 435.261 ms. No healthy-server/graceful-exit-0 claim is made; the process exited on its own and no second startup was performed.

Exact server stderr:

```text
LOCAL_SESSION_REQUIRED
```

Server log: /home/jm/.omo/isolated/jarvis-candidate-936a24f/logs/boot-candidate-attempt2-server.log. Controller raw log/receipt/result: boot-candidate-attempt2.log, .json and -result.json. The startup failure is not repaired or replaced by the earlier successful CLI smoke.

## Additional copied-package measurement failure

The independent read-only inventory of the runtime copy exited 1 with PACKAGE_LINK_ESCAPES. fs.cpSync converted four relative npm .bin links into absolute links to the original built candidate package. They still point inside the same isolation root, not production or an external data directory, but leave the narrower copied-package root and therefore fail that strict whole-package inventory. No links were rewritten and no inventory retry was performed.

The three actual dashboard/CLI/native binary hashes in the executed copy match their built-package counterparts. That does NOT replace a full copied-package identity proof: full copied-package SHA-256 is NOT_VERIFIED. Original immutable candidate/prior package manifests above are valid and kept distinct from that unverified copy. Exact observations and exit-1 transcript: control/staged-copy-observation.json and logs/inventory-selected-candidate-attempt2.log/.json.

## Remaining criteria and boundaries

- Packaging of the pinned candidate: passed with actual receipt, counts, paths, hashes and raw command results.
- Isolated healthy boot and normal shutdown: failed/unverified, LOCAL_SESSION_REQUIRED.
- Actual rollback, prior restart/health and schema/data preservation across rollback: NOT_RUN.

The proposed rollback target remains 7f2bdf081f66aadd19c45b29d27dfe4e399b23f1, whose real package was built and hashed, but no restore/rollback command or prior-server boot was executed. The prepared backup script was not run. No backup or rollback success receipt is claimed. No old Task36/different-SHA evidence is substituted.

All generated package/source-copy/control/cache/TMP/HOME/data/log paths stay inside /home/jm/.omo/isolated/jarvis-candidate-936a24f. Only the authorized evidence document and PR65/Issue64 records are published outside. No production service/HOME/DB/port/systemd/launchd operation, merge/ready/force push, other branch/PR write or shared-main dirty-file edit occurred. No npm credentials, private keys, tokens or .env values are printed or committed.

The prior no-write-hooks directory is used only for the evidence commit to prevent the sole shared post-commit inventory writer from writing to canonical-vault outside isolation. No repository Git config file or validation hook is changed; canonical inventory synchronization is NOT_RUN for this commit.

Issue64 records attempt1's unchanged failure and the authorized two-path attempt2 correction. Its packaging criterion can be closed with this evidence, while boot and rollback remain open. Project remains In Progress and PR65 remains draft; deployment preparation is incomplete.

JARVIS_CANDIDATE_PKG_RECOVER_BLOCKED reason=LOCAL_SESSION_REQUIRED step=2
