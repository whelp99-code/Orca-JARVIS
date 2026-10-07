# Packaging smoke-state fix1

## Outcome and acceptance limit

The packaging source defect is corrected in separate branch fix/packaging-smoke-state-20261008, implementation commit3750cfb8dbf4e94c213a0e2e1462f4bb72f15502, based on7669b34e6309e93e6f7c9b3a70ffed3cbd76dd0f.13 filesystem regressions passed; real clean-source packaging, secret-state absence, candidate boot/shutdown, exact prior rollback/restart and complete SQLite file-byte preservation passed.

**Overall request BLOCKED: PREVIOUS_NPM_DEBUG_LOGS_PRUNED step4.** Reusing the existing isolated npm logs directory let npm's built-in debug-log retention remove11 previous auxiliary logs/npm debug files. The original named attempt1-4 command logs/JSON, terminal-failure records, package manifests/controllers and DO_NOT_DISTRIBUTE marker remain unchanged, as do all old packages and PR65 commits. Nevertheless, complete previous-log preservation is not met and must not be called done. Deleted originals were not fabricated or reconstructed. The old hashes and exact missing path list are preserved in control/preserved-evidence-fix1.json and control/preservation-failure-fix1.json.

The full canonical gate also remains incomplete: its monitor hit the default300000ms limit and terminated it before a final exit receipt. New regression passed; runtime/lint/architecture/typecheck/backend+dashboard build passed before timeout. Provider-Python-missing and protected-root expectations under explicit isolated root overrides failed before timeout; those tests were untouched. Dashboard test suite/acceptance/final canonical CLI smoke were not reached. No overall canonical PASS claim.

## Separate source and exact changes

- scripts/package-authority-runtime.mjs delegates only the smoke scratch lifecycle, calls strict no-test-state inspection before receipt issuance, and records validation.test_state_absent=passed.
- scripts/lib/runtime-package-smoke.mjs creates a unique sibling temporary directory OUTSIDE final package root, forwards TMPDIR/TMP/TEMP, and removes only that directory in finally, on success or smoke failure. The scanner reads filenames only and refuses smoke-state, SQLite files/sidecars, any PEM and gjc.json anywhere in output.
- tests/integration/runtime-package-smoke.test.mjs exercises real scratch creation/cleanup and forbidden filename placement, including error-path cleanup, SQLite WAL/SHM/journal, private/public PEM, symlink state filename and misplaced build-lock SQLite.13 tests, no skips or weakened checks.

Build-lock decision: scripts/build-backend.mjs owns dist/.backend-build-lock.sqlite, but RUNTIME_PACKAGE_ROOTS copies dist/src/tests/migrations/contracts/dashboard/metadata, not the source dist root. A packaged build-lock would therefore be a leaked file and is rejected; no exception is needed.

No old package was purged or rewritten to appear clean. Original package smoke-state DB/key/session contents were not decoded. Only file paths/types/bytes/modes/SHA were used. Synthetic negative-regression fixtures contain empty files, not real keys. New smoke scratch is the only deleted test directory.

The source clone lives at/home/jm/.omo/isolated/jarvis-candidate-936a24f/source-fix1 inside the authorized isolation because the current wK contains unrelated untracked memory-timeout evidence. That checkout and PR65's release/jarvis-clean-candidate-20261007 headc509408831dace5519f0b3af57e3a24994e74bcc were not switched or edited. Separate draft PR base main; its merge-base is7669b34e. Main advanced by2 unrelated commits during the session, touching none of the packaging fix files; no rebase/merge/history rewrite was performed.

## Regression and actual package surface

All three changed JS files had clean LSP diagnostics before build.13 new tests passed in499.436ms. Existing repository lint/typecheck/architecture/build were observed clean in the preserved canonical transcript. No source .ts API/DB schema/lockfile change.

New package/home/jm/.omo/isolated/jarvis-candidate-936a24f/packages-fix1/jarvis-runtime-fYkmTU: source_head3750cfb8dbf4e94c213a0e2e1462f4bb72f15502, source_dirty=false/tracked_dirty=false, production dependency/CLI smoke/runtime identity/test-state absence all passed; deployment_ready staysfalse. No provider/reproducibility/production release claim. Actual output scanner accepted this package, rejected the old package with RUNTIME_PACKAGE_TEST_STATE_PRESENT smoke-state and verified zero leftover jarvis-runtime-smoke- sibling directories. Result logs/output-regression-fix1.json.

| Artifact | Files | Links | Bytes | Whole sorted-manifest SHA-256 |
| --- | ---: | ---: | ---: | --- |
| New original package | 7623 | 4 | 57552748 | 294a4815971372badd620a3fd510d003c5354bbd0821983408c0f949dcf6da87 |
| New copied package | 7623 | 4 | 57552748 | 294a4815971372badd620a3fd510d003c5354bbd0821983408c0f949dcf6da87 |
| Prior copied package | 7628 | 4 | 62128312 | 63e31f6d372a888e372efa3f9ab76f54714cf0bccecf30373fbf5496816e7b74 |

Manifest algorithm unchanged: recursively inventory regular files and exact symlink target strings, sorted path/type/bytes/hash/target TSV, SHA-256 of exact TSV with header/final newline. Separate mode-inclusive metadata comparisons additionally prove all file/directory modes, types, byte sizes, hashes and links equal source. Candidate8532 entries including905 directories, prior8539 including907 directories. Four relative links each resolve inside their copied package roots; no dereference or overwrite.

- Candidate mode-inclusive metadata SHA9eb514fdc875f3804b7b168e6f28f2975543070a7a65c6b0f205b7dc85bef708
- Prior mode-inclusive metadata SHA7c7ef30c8c4953c76e0c0d96345499153a91806765665c487d2f96fb595ee1da

Full directory modes and link tables: logs/runtime-completed-fix1.json. Copy/current roots/home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-fix1/releases/<exactSHA>. Strict COPY_MODE_SIZE_HASH_OR_LINK_CHANGED and PACKAGE_LINK_ESCAPES checks stay intact. Full manifest paths are in candidate-original-fix1-inventory.json, candidate-copy-fix1-inventory.json and prior-copy-fix1-inventory.json.

## Preserved setup failure and fixture recovery

The first setup command copied and fully compared both packages, then exited1 FIX1_FIXTURE_NOT_CHECKPOINTED because it expected no SQLite sidecars. Original attempt4 fixture had WAL0 bytes and SHM32768 bytes left by the read-only previous snapshot. That failure/log/JSON is preserved. It occurred before new DB/current/dashboard creation. No package copy was rerun or overwritten.

A distinct complete-runtime-fix1 command independently requalified existing copies, verified source WAL byte length0, then copied the complete checkpointed SQLite file exclusively to a new private fixture and compared bytes/SHA. It did not open any DB application row/key/session values or mutate original fixture/sidecars. The original file and new copy were4575232 bytes/SHA13c9f72dee838e12b550519add17130e112ebee1ab3bbbafd79b230456475bd4.

## Private startup and same-environment rollback

HOME/TMP/TEMP/XDG data/state/config/cache and provider/config/share roots remained under/home/jm/.omo/isolated/jarvis-candidate-936a24f via explicit plan-attempt2 environment. No production HOME/session/credential copy or authorization bypass. Candidate actual argv:

```text
node /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-fix1/releases/3750cfb8dbf4e94c213a0e2e1462f4bb72f15502/dist/src/dashboard/main.js --host 127.0.0.1 --port 0 --db /home/jm/.omo/isolated/jarvis-candidate-936a24f/data/authority-fix1.sqlite --static-root /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-fix1/releases/3750cfb8dbf4e94c213a0e2e1462f4bb72f15502/dist/dashboard
```

Candidate PID2896255, port44021, healthHTTP200/status=ok/authority=ready. Providerless second_brain unavailable is retained, not replaced by a fake ready claim. Startup504.170ms, shutdown code0/signal=null/15.374ms. Server in-memory session only; no token contents requested or recorded.

After normal shutdown, backup/home/jm/.omo/isolated/jarvis-candidate-936a24f/backups/pre-rollback-fix1.sqlite exclusive copy is byte-identical to live fixture. Exact existing rollback command:

```text
node /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-fix1/releases/3750cfb8dbf4e94c213a0e2e1462f4bb72f15502/dist/src/cli.js release rollback --db /home/jm/.omo/isolated/jarvis-candidate-936a24f/data/authority-fix1.sqlite --to 7f2bdf081f66aadd19c45b29d27dfe4e399b23f1 --release-root /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-fix1 --restore-backup /home/jm/.omo/isolated/jarvis-candidate-936a24f/backups/pre-rollback-fix1.sqlite --json
```

Exit0/restored=true/dry_run=false, prior target7f2bdf081f66aadd19c45b29d27dfe4e399b23f1. Existing unsealed-release backup-vector restore contract verifies116 migrations, matching vectorsha256:46c057da573aa083fc4c0a4239e272632ea882d912bb16b9d6507c9f406234f0, backup quick_checkok. Current switched atomically to releases/7f2bdf081f66aadd19c45b29d27dfe4e399b23f1. Original live bytes retained at/home/jm/.omo/isolated/jarvis-candidate-936a24f/data/authority-fix1.sqlite.replaced-2026-10-07T19-51-48-015Z. systemd_order is a returned documentation array, not executed service commands. Prior package remains distribution-prohibited and was used only for the local authorized rollback rehearsal.

Prior restart PID2901834, port33311, health200/status=ok/authority=ready, startup486.896ms, shutdown0/signal=null/17.752ms. Same private DB/environment, separate owned ephemeral ports, no production4173 contact.

Final verification proves complete checkpointed SQLite file bytes (including schema/data) before/after equal:4575232 bytes/SHA13c9f72dee838e12b550519add17130e112ebee1ab3bbbafd79b230456475bd4. No application SELECT value dump, key text, session token or plaintext database contents were inspected or printed. Stronger whole-file byte equality avoids excluding any schema/data metadata. Result logs/data-preservation-fix1.json.

## Exact command ledger and raw artifacts

| Label | Exit | Elapsed ms | Raw log SHA-256 |
| --- | ---: | ---: | --- |
| clone-source-fix1 | 0 | 1202.071 | 427af0e3c22d678902edce1fece1fd5f65bd81679dca74025f55bcba2e397a5e |
| branch-source-fix1 | 0 | 182.197 | d59f606ad7e0b1b40189640f316f9f2f90d278ff6547820aa1c9ab6344ca7984 |
| origin-source-fix1 | 0 | 2.399 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 |
| install-source-fix1 | 0 | 2956.153 | 07c8dd63da60a4c65c67d76568d72120fb5ce8be7d629c735bfa441ce5492aeb |
| test-regression-fix1 | 0 | 499.436 | 95c2f9a5cff566523e1884224b0674a3c0bbc45ff9e42ceb31c8838c092e7a1b |
| package-candidate-fix1 | 0 | 20134.129 | b9ad0497fdb3e71109130fbec821e6c115abffc0dddc2ebc69829a4ec1f4b33d |
| check-output-fix1 | 0 | 65.612 | d1bd8023d0bfaf197dda023483c313243841b19b5d7f96e3735e56af47341853 |
| setup-runtime-fix1 | 1 | 1065.210 | 9be43ddb089730e1993d7829bf77f006187d1ce68fcd909eff37563658a17341 |
| inventory-original-fix1 | 0 | 194.223 | f098c14cc426fec1d6335c9617fe98b521df8976f0c29c569fcb399e33d38a63 |
| complete-runtime-fix1 | 0 | 706.416 | 3ae8023e10a642ed9d3733e52d885bccdb21844eaa35a221a593e4049b5de18d |
| inventory-copy-fix1 | 0 | 208.683 | 9a5bfc64f2331b568e9a035961df321815722610620915e6543f4200acfc795f |
| inventory-prior-copy-fix1 | 0 | 222.186 | 0a6909a747625f7ce8247399a23f0c00d8f3a5e3e5083d4bd128e05ccc582b67 |
| boot-candidate-fix1 | 0 | 561.286 | 78a2b5cd44b5430c8b45714dc09afade5c59260254f857c577931289b9de7340 |
| backup-rollback-fix1 | 0 | 46.228 | 19da74dd6175281b4c3009c1730fd43e53db1971ff8c80ba72337481148d0004 |
| rollback-prior-fix1 | 0 | 297.673 | fbfe5f354faea800da0133c972bd439d0961b0dcdac816934d27a2300f82e1dc |
| boot-prior-fix1 | 0 | 547.699 | d47d6de2831a3ba30d8186c5570bde6aa9112db8a5f240a7ac4a0195d18275de |
| verify-preservation-fix1 | 0 | 31.517 | 71038b18abb65fcb395ffa35add130071eef662269fa3e76f4f264375357db86 |
| verify-source-fix1 (monitor) | timed_out/1; no child final receipt | 300000 deadline | d66ad26bf2f1ab31941093f0de9ed898377f9112ec131ba7c99eaef42638c80a |

Actual argv/cwd for logged commands:

```text
cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
git clone --no-hardlinks --no-checkout /home/jm/orca/workspaces/Orca-JARVIS/clean-deploy-candidate-20261007 /home/jm/.omo/isolated/jarvis-candidate-936a24f/source-fix1

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f/source-fix1
git switch -c fix/packaging-smoke-state-20261008 7669b34e6309e93e6f7c9b3a70ffed3cbd76dd0f

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f/source-fix1
git remote set-url origin https://github.com/whelp99-code/Orca-JARVIS.git

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f/source-fix1
npm ci --offline --no-audit --no-fund

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f/source-fix1
node node_modules/vitest/vitest.mjs run tests/integration/runtime-package-smoke.test.mjs --no-file-parallelism

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f/source-fix1
node scripts/package-authority-runtime.mjs --output-parent /home/jm/.omo/isolated/jarvis-candidate-936a24f/packages-fix1

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/check-output-fix1.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/packages-fix1/jarvis-runtime-fYkmTU

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/setup-private-runtime-fix1.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/packages-fix1/jarvis-runtime-fYkmTU /home/jm/.omo/isolated/jarvis-candidate-936a24f/prior-packages/jarvis-runtime-vlBWJw

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/package-inventory.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/packages-fix1/jarvis-runtime-fYkmTU candidate-original-fix1

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/complete-runtime-fix1.mjs

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/package-inventory.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-fix1/releases/3750cfb8dbf4e94c213a0e2e1462f4bb72f15502 candidate-copy-fix1

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/package-inventory.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-fix1/releases/7f2bdf081f66aadd19c45b29d27dfe4e399b23f1 prior-copy-fix1

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/boot-private-package-fix1.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-fix1/releases/3750cfb8dbf4e94c213a0e2e1462f4bb72f15502 boot-candidate-fix1

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/prepare-rollback-fix1.mjs

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-fix1/releases/3750cfb8dbf4e94c213a0e2e1462f4bb72f15502/dist/src/cli.js release rollback --db /home/jm/.omo/isolated/jarvis-candidate-936a24f/data/authority-fix1.sqlite --to 7f2bdf081f66aadd19c45b29d27dfe4e399b23f1 --release-root /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-fix1 --restore-backup /home/jm/.omo/isolated/jarvis-candidate-936a24f/backups/pre-rollback-fix1.sqlite --json

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/boot-private-package-fix1.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-fix1/releases/7f2bdf081f66aadd19c45b29d27dfe4e399b23f1 boot-prior-fix1

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/verify-preservation-fix1.mjs
```

Full transcripts and sibling exact start/end/argv/exit/signal/elapsed/hash JSON under/home/jm/.omo/isolated/jarvis-candidate-936a24f/logs/<label>.log/.json, each launched by control/run-command-fix1.mjs. Interrupted verify-source-fix1 has no final JSON; its complete captured raw log is preserved, not regenerated. Source commit command exit0; its git transcript is the session monitor event, elapsed not measured.

## Preservation failure and review status

The requested old named attempt1-4 raw logs/JSON, terminal-failure records/controllers/profile/receipts and distribution marker are unchanged. Their previously published commits ecc5f0c/a716f6f/61e3dab/c509408 are preserved, PR65 head unchanged. Old package identities match their original manifests, and unrelated wK evidence hashes are preserved.

However npm ci/build reused plan-attempt2 npm_config_logs_dir. npm's retention deleted these11 old auxiliary debug paths, originally hashed in control/preserved-evidence-fix1.json:

- logs/npm/2026-10-07T17_24_12_029Z-debug-0.log
- logs/npm/2026-10-07T17_24_24_616Z-debug-0.log
- logs/npm/2026-10-07T17_28_03_261Z-debug-0.log
- logs/npm/2026-10-07T17_28_15_740Z-debug-0.log
- logs/npm/2026-10-07T17_24_12_099Z-debug-0.log
- logs/npm/2026-10-07T17_28_03_159Z-debug-0.log
- logs/npm/2026-10-07T17_24_26_540Z-debug-0.log
- logs/npm/2026-10-07T17_28_03_082Z-debug-0.log
- logs/npm/2026-10-07T17_28_17_611Z-debug-0.log
- logs/npm/2026-10-07T17_24_12_198Z-debug-0.log
- logs/npm/2026-10-07T17_25_46_638Z-debug-0.log

This is an avoidable execution error, not a packaging source failure. Full preservation cannot be certified. No false replacement log was written. The exact preservation difference is control/preservation-failure-fix1.json; task terminal status staysBLOCKED step4. Old package distribution ban is not lifted.

Manual QA: six functional/package/copy/startup/rollback/byte-preservation scenariosPASS; all-prior-log preservationFAIL; canonical completionINCOMPLETE. Under review-work's no-review-after-failed-QA rule, independent final gate reviewer is NOT_RUN. No independent APPROVE or release-ready claim. QA record control/qa-result-fix1.json. The new PR is an explicitly blocked draft for human review, not ready.

Issue64/Project remain In Progress. New draft PR is separate fromPR65 and links this evidence and preserved failure records. No merge/ready/force-push, other branch edits, production credential/service/DB/port/HOME operation, old package deployment/attachment/external share, or raw secret publication. Generated package/control/test/HOME/cache/data/TMP paths are inside existing isolation; only authorized GitHub records/source branch are published. No extra memory-store write outside that scope; durable technical facts are kept in this repository evidence.

JARVIS_PACKAGING_SMOKE_STATE_FIX_BLOCKED reason=PREVIOUS_NPM_DEBUG_LOGS_PRUNED step=4
