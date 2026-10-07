# Candidate isolated boot and rollback attempt4

## Outcome

**ATTEMPT4 DONE: directory-mode preservation, candidate boot/shutdown and exact prior rollback/restart/schema-data preservation all passed.** All three isolated acceptance conditions now have measured evidence for the pinned candidate. This does not declare production deployment or fix the separately recorded PACKAGING_DEFECT. PR65 stays draft; Project stays In Progress because the runtime package still contains the separately reported smoke-state private-key test residue.

## Scope and preserved source

Candidate branch release/jarvis-clean-candidate-20261007 began clean at61e3dabfe6697ba59d9c6a1b7de6f680f864d733. Pinned package source936a24f322974e6efd1893d0da91424f3bf18f3a; code7669b34e6309e93e6f7c9b3a70ffed3cbd76dd0f; exact prior7f2bdf081f66aadd19c45b29d27dfe4e399b23f1. Both original package receipts remain dirty=false/tracked_dirty=false. No repository source/test/config/lockfile was changed. This commit adds only this evidence document.

Original packages remain at /home/jm/.omo/isolated/jarvis-candidate-936a24f/packages/jarvis-runtime-RHpbXt and /home/jm/.omo/isolated/jarvis-candidate-936a24f/prior-packages/jarvis-runtime-vlBWJw, untouched. New destination /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt4, never reused an old release directory. Existing attempt1-3 failure logs/JSON/controllers/terminal-failure records, recovery-blocked-step2.json and ecc5f0c/a716f6f/61e3dab commits are preserved.89 prior control/log files were hashed before work and rechecked unchanged. Preservation hashes and quoted failure/source lines: /home/jm/.omo/isolated/jarvis-candidate-936a24f/control/preflight-attempt4.json.

## Exact missing mode step and bounded correction

Attempt3 setup-private-runtime-attempt3.mjs:57-62 copied and immediately compared, without applying original directory permissions:

```javascript
  cpSync(source, destination, {
    recursive: true, dereference: false, force: false, errorOnExist: true,
    verbatimSymlinks: true,
  });
  const copied = entries(destination);
  if (JSON.stringify(originals[index]) !== JSON.stringify(copied)) {
```

Observed attempt3 differences were package root and smoke-state/jarvis-cli-smoke-WP7tmn, source0700 -> copy0775. The mkdir/umask default was left in place by that copier. The only functional copy correction in new setup-private-runtime-attempt4.mjs is restoring all directory modes, child-first, before the original comparison:

```javascript
for (const row of originals[index].filter(row => row.type === "directory").toReversed()) {
  chmodSync(join(destination, row.path), row.mode);
}
```

It changes only new destination directories. cpSync options remain recursive=true/dereference=false/force=false/errorOnExist=true/verbatimSymlinks=true. Original relative .bin links are not rewritten or dereferenced. Existing COPY_MODE_SIZE_HASH_OR_LINK_CHANGED, ORIGINAL_ABSOLUTE_LINK, PACKAGE_LINK_ESCAPES and full JSON metadata equality are unchanged; no file or directory was excluded. Other controller changes are new attempt4 filenames/private DB paths only; previously corrected argv and health contracts and isolated environment are unchanged.

## Full copy qualification and mode table

Each package comparison includes8539 entries:7628 regular files,4 links,907 directories. File/link types, permission modes, file bytes, SHA-256 and link target strings all match source. Lexical and realpath checks require every copied link to resolve inside that copied package. The two complete metadata digests, including all modes, are:

- Candidate aa9bfb2edf2adcc29053db035f887bf6fd8b03fa61bcda8160eb8dd7d97028e9
- Prior 7c7ef30c8c4953c76e0c0d96345499153a91806765665c487d2f96fb595ee1da

All1814 source/copy directory modes match. Full directory-mode table: /home/jm/.omo/isolated/jarvis-candidate-936a24f/logs/directory-mode-table-attempt4.json. Critical rows:

| Package | Relative directory | Source | Copy |
| --- | --- | --- | --- |
| 936a24f322974e6efd1893d0da91424f3bf18f3a | (package root) | 0700 | 0700 |
| 936a24f322974e6efd1893d0da91424f3bf18f3a | smoke-state/jarvis-cli-smoke-WP7tmn | 0700 | 0700 |
| 7f2bdf081f66aadd19c45b29d27dfe4e399b23f1 | (package root) | 0700 | 0700 |
| 7f2bdf081f66aadd19c45b29d27dfe4e399b23f1 | smoke-state/jarvis-cli-smoke-QMa8d3 | 0700 | 0700 |

The original strict package-inventory.mjs independently passed both copied packages. Its whole-package SHA is the unchanged sorted TSV regular-file/symlink manifest (not the mode-inclusive metadata hash); both kinds of proof are recorded.

| Package original and copy | Original root | Copy root | Files | Links | Bytes | Sorted-manifest SHA-256 (both) |
| --- | --- | --- | ---: | ---: | ---: | --- |
| Candidate | /home/jm/.omo/isolated/jarvis-candidate-936a24f/packages/jarvis-runtime-RHpbXt | /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt4/releases/936a24f322974e6efd1893d0da91424f3bf18f3a | 7628 | 4 | 62128440 | 8340403ced708586bfae9e5bfa83f4ac5351643d289928234da3f5ffd1da797b |
| Prior | /home/jm/.omo/isolated/jarvis-candidate-936a24f/prior-packages/jarvis-runtime-vlBWJw | /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt4/releases/7f2bdf081f66aadd19c45b29d27dfe4e399b23f1 | 7628 | 4 | 62128312 | 63e31f6d372a888e372efa3f9ab76f54714cf0bccecf30373fbf5496816e7b74 |

Full copied manifests: /home/jm/.omo/isolated/jarvis-candidate-936a24f/logs/candidate-copy-attempt4-manifest.tsv and /home/jm/.omo/isolated/jarvis-candidate-936a24f/logs/prior-copy-attempt4-manifest.tsv. CLI/dashboard/native binary hashes are identical in both original/copy pairs:

- dist/src/cli.js: a7a5bcd447d31cd1ae8c2f1c07c1b13c21797a2e5c9174d733b49e22e52d336a
- dist/src/dashboard/main.js: c724c52625bc89130ecd4364993e6e9fb47ddefd33e035154f21be24afd392a3
- node_modules/better-sqlite3/build/Release/better_sqlite3.node: 45cb92a176fb758533db6d9a343acdfc73e4de27ac4c20a0cb2a6fb5be3e84f2

## Actual candidate startup and normal shutdown

The already initialized private fixture was copied by SQLite online backup to /home/jm/.omo/isolated/jarvis-candidate-936a24f/data/authority-attempt4.sqlite; no smoke-state DB/key/session values or production data were used. Exact same isolated HOME/TMP/TEMP/XDG config/cache/data/state and provider/config/share roots are retained from plan-attempt2.json. No new permanent token/session credential or guard bypass. Server sessions come only from createDashboardSession() in process memory.

Actual candidate argv:

```text
node /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt4/releases/936a24f322974e6efd1893d0da91424f3bf18f3a/dist/src/dashboard/main.js --host 127.0.0.1 --port 0 --db /home/jm/.omo/isolated/jarvis-candidate-936a24f/data/authority-attempt4.sqlite --static-root /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt4/releases/936a24f322974e6efd1893d0da91424f3bf18f3a/dist/dashboard
```

PID 2775002, bound127.0.0.1:34113, startup 503.943 ms. GET /api/v1/health returned200 with schema_version1/status=ok/authority=ready. Providerless second_brain readiness=unavailable remains explicitly recorded and is not promoted to provider qualification. SIGTERM shutdown code0/signal=null in 12.741 ms; no forced kill was needed. Total boot command 579.920 ms. Full raw response/argv/DB snapshot: logs/boot-candidate-attempt4.log and logs/boot-candidate-attempt4-result.json; server transcript boot-candidate-attempt4-server.log.

## Same-environment exact prior rollback and restart

After candidate shutdown, backup /home/jm/.omo/isolated/jarvis-candidate-936a24f/backups/pre-rollback-attempt4.sqlite, SHA-256 13c9f72dee838e12b550519add17130e112ebee1ab3bbbafd79b230456475bd4, bytes4575232, quick_check=ok. Full backup schema/data/table snapshots equal live snapshots. Existing packaged CLI release rollback --restore-backup was used because this unsealed earlier-runtime packaging path is handled by the documented backup-vector restore contract. No artificial sealed receipt/provider compatibility was fabricated.

Exact rollback command:

```text
node /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt4/releases/936a24f322974e6efd1893d0da91424f3bf18f3a/dist/src/cli.js release rollback --db /home/jm/.omo/isolated/jarvis-candidate-936a24f/data/authority-attempt4.sqlite --to 7f2bdf081f66aadd19c45b29d27dfe4e399b23f1 --release-root /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt4 --restore-backup /home/jm/.omo/isolated/jarvis-candidate-936a24f/backups/pre-rollback-attempt4.sqlite --json
```

Exit0, elapsed295.904 ms, dry_run=false/restored=true. Target migration vectorsha256:46c057da573aa083fc4c0a4239e272632ea882d912bb16b9d6507c9f406234f0, migrations116, equals backup vector; source dist/migrations. The original live DB bytes were retained as /home/jm/.omo/isolated/jarvis-candidate-936a24f/data/authority-attempt4.sqlite.replaced-2026-10-07T19-05-48-952Z. Current changed atomically from releases/936a24f322974e6efd1893d0da91424f3bf18f3a to releases/7f2bdf081f66aadd19c45b29d27dfe4e399b23f1. The systemd_order array in the receipt is documentation only; zero systemd/launchd/service commands were executed.

Prior restart used the same private DB and unchanged controller/environment, exact prior package /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt4/releases/7f2bdf081f66aadd19c45b29d27dfe4e399b23f1. PID2784803, bound127.0.0.1:45305, startup501.254 ms. Health200/status=ok/authority=ready; shutdown0/signal=null in13.506 ms. Raw logs: logs/boot-prior-attempt4.log, -server.log and -result.json.

Final independent read-only comparison includes every schema entry and all 269 table snapshots, with no metadata exclusions: schema_equal=true/data_equal=true/all_tables_equal=true/restart_snapshot_equal=true/integrity=ok.

- Schema before/after SHA-256 d10d7be84b1720fb9b6acea905d7724b30244625dadbd0c6556a91db8b70b5a6
- Full logical data before/after SHA-256 6a52da3825d0512effeaf4767181f63a756ebc64793a326e44ac6cb89cdb2607

Before/backup/after full row-count and table-hash vectors: logs/pre-rollback-attempt4.json, data-preservation-attempt4.json, verify-preservation-attempt4.log. They hash rows without exposing their values. No schema, user-data or restore-fence mutation was ignored to get this equality.

## Exact command ledger and raw transcripts

| Label | Exit | Elapsed ms | Raw log SHA-256 |
| --- | ---: | ---: | --- |
| setup-runtime-attempt4 | 0 | 1153.943 | 166b106c4b661d6442118e24e493e9140e4fecef1a3f09e39b3d1391824169bf |
| inventory-candidate-attempt4 | 0 | 231.777 | a2e3aae969b4b242da24f665828a8f7f319fabb72e39142078b1aedebe79d8d6 |
| inventory-prior-attempt4 | 0 | 224.340 | 1a6c3f3f543563c01424c0bdda6faeabdda7a0571a8c387aa660d3cdc2ab2058 |
| boot-candidate-attempt4 | 0 | 579.920 | b0c3f9d6445cd24981a25545f7056b7984797bcee2ed81126979c0d2344cf8e0 |
| backup-rollback-attempt4 | 0 | 98.265 | bf90666ffda191b5dda1b8ca41eab20be04d6f81d080a9d31801bb5796631008 |
| rollback-prior-attempt4 | 0 | 295.904 | 96917763e029498f78d9d82205ba7b4669d1dc5e33419a9aae1154cd2b934061 |
| boot-prior-attempt4 | 0 | 581.044 | 5ac7a86d6e1e8a57d7b0fd13e7716badbb0be4021e5dd97d1fc54f428c1b850a |
| verify-preservation-attempt4 | 0 | 63.263 | b5028f41b3befc5d3c3b9b26d8d1cb7f7e195bc6f150adf7160908928c6f759c |

Exact actual command/cwd entries:

```text
cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/setup-private-runtime-attempt4.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/packages/jarvis-runtime-RHpbXt /home/jm/.omo/isolated/jarvis-candidate-936a24f/prior-packages/jarvis-runtime-vlBWJw

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/package-inventory.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt4/releases/936a24f322974e6efd1893d0da91424f3bf18f3a candidate-copy-attempt4

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/package-inventory.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt4/releases/7f2bdf081f66aadd19c45b29d27dfe4e399b23f1 prior-copy-attempt4

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/boot-private-package-attempt4.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt4/releases/936a24f322974e6efd1893d0da91424f3bf18f3a boot-candidate-attempt4

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/prepare-rollback-attempt4.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt4/releases/936a24f322974e6efd1893d0da91424f3bf18f3a

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt4/releases/936a24f322974e6efd1893d0da91424f3bf18f3a/dist/src/cli.js release rollback --db /home/jm/.omo/isolated/jarvis-candidate-936a24f/data/authority-attempt4.sqlite --to 7f2bdf081f66aadd19c45b29d27dfe4e399b23f1 --release-root /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt4 --restore-backup /home/jm/.omo/isolated/jarvis-candidate-936a24f/backups/pre-rollback-attempt4.sqlite --json

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/boot-private-package-attempt4.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt4/releases/7f2bdf081f66aadd19c45b29d27dfe4e399b23f1 boot-prior-attempt4

cwd=/home/jm/.omo/isolated/jarvis-candidate-936a24f
node control/verify-preservation-attempt4.mjs /home/jm/.omo/isolated/jarvis-candidate-936a24f/releases-attempt4/releases/7f2bdf081f66aadd19c45b29d27dfe4e399b23f1
```

Each actual command is launched via control/run-command-attempt4.mjs with the identical explicit isolation profile; its complete transcript and sibling JSON under logs record command/argv/start/end/exit/signal/elapsed/log SHA. No failed validation was replayed. Node --check passed the new setup/boot/runner scripts before setup; elapsed for that quick syntax chain was not recorded. Private JS controller LSP is unavailable (no TypeScript in private control workspace), and no install or suppression was added. Product code tests/build are NOT_RUN in attempt4 because product source is frozen and prior canonical checks remain historical, not re-claimed.

## Separate unchanged PACKAGING_DEFECT

별도 패키징 결함(PACKAGING_DEFECT): smoke-state 시험 잔여물(비밀키 파일 포함)이 런타임 패키지 출력에 남음

User-supplied code finding, quoted unchanged: scripts/package-authority-runtime.mjs 27행 mkdtempSync(jarvis-runtime-)로 출력 루트 생성(그래서 루트 0700), 47행 mkdirSync(output/smoke-state), 48~49행 TMPDIR=output/smoke-state로 scripts/cli-smoke.mjs 실행. cli-smoke.mjs 7행 mkdtempSync(tmpdir()/jarvis-cli-smoke-)에 authority.sqlite·decision/verifier 공개키·gjc.json을 만들고, CLI init이 authority.sqlite.policy-key.pem(0600)을 만든다. 패키징 스크립트에 이 디렉터리 정리 단계가 없고 payload 해시 roots에도 없다. 즉 패키징 중 smoke 검증 단계의 시험 잔여물이 출력에 남는다.

No smoke-state file contents are read, decoded or printed. Only metadata/hash comparisons are used. The directory and every file are retained unchanged. This defect is not repaired in attempt4.


This user-supplied finding is also confirmed by reading packaging/cli-smoke sources: output mkdtemp and smoke TMPDIR creation, lack of cleanup, and RUNTIME_PACKAGE_ROOTS not including smoke-state. Ten smoke-state files remain in the two original packages, with two policy-key.pem entries119 bytes/mode0600. Only path/type/bytes/mode/SHA are inspected, never raw DB/key/session values. Metadata-only evidence: logs/smoke-state-metadata-attempt4.json. None was deleted, filtered out, reclassified, repaired or disclosed. This separate defect prevents describing the package as deployment-ready even though the requested isolated rehearsal succeeds.

## Acceptance and publication

- Pinned package creation with actual identity: PASS, preserved attempt2 originals.
- Qualified isolated candidate boot/health/normal shutdown: PASS, attempt4 measured.
- Same-environment exact prior rollback/restart/full schema-data preservation: PASS, attempt4 measured.

Issue64's three isolated conditions may now be checked with this evidence. The separate packaging defect remains unresolved and explicitly recorded; Project stays In Progress, PR65 stays draft, no production release/ready/merge claim. Evidence-only commit and normal push to the existing candidate branch; no other branch/PR/write, production HOME/service/DB/port/systemd/launchd operation, shared-main dirty-file change or secret output. All operational files remain under /home/jm/.omo/isolated/jarvis-candidate-936a24f. Existing private no-write-hooks path prevents shared canonical inventory writes at evidence commit; inventory synchronization is NOT_RUN.

JARVIS_CANDIDATE_PKG_BOOT_ATTEMPT4_DONE
