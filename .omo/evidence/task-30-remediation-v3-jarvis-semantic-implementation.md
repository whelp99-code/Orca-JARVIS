# Task 30 remediation v3 - JARVIS semantic implementation evidence

## Verdict

**JARVIS semantic implementation is committed and its scoped/static/manual gates are green, but
Task 30 is not accepted.** Semantic gate 9 remains blocked by the immutable provider's legacy
profile. A fresh archive-built old JARVIS fails its genesis handshake against provider
`f051fe50fdae1af0e88e45be7805fa7cbf53ea9c` before emitting a request. This artifact does not emit
or imply `TASK30_ACCEPTANCE_PASS`.

Reserved canonical verifier commands were not run. Independent final adjudication remains
reserved.

## Immutable bindings

- JARVIS frozen entry: `49e8e4d6e45710fdbb0d548bae972e57f7bd4549`
- Provider commit: `f051fe50fdae1af0e88e45be7805fa7cbf53ea9c`
- Provider tree: `ebbb5ca0add11c579319aa662908b1062c3ee120`
- Provider status at sealing: clean
- Provider wheel SHA-256:
  `b3dc653b26d1e00b8ed0cd3938aa6d787bf2a27679eecccf17041709e5b53002`
- Provider contract SHA-256:
  `1406f97695970a099af2569ab93777b67603a2a2261b9f6d03646e430d6098fe`
- Archived old JARVIS skew entry:
  `c89fd43a2f4bac9862f2c4427e71e1b74657d840`
- Archived old provider skew entry:
  `30cebe1670c0b65dc9832066a09c2c64f8371b20`

The provider repository, wheel, contract, and tooling were not edited.

## JARVIS commit chain

### Atomic preparation increment

- Commit: `6cddd37a86440df436bfd9b9f00c8a891d9164a3`
- Tree: `ff5aa10535f60bd7b5f54cacbba297fdd837f27f`
- Parent: `49e8e4d6e45710fdbb0d548bae972e57f7bd4549`
- Author/committer time: `2026-09-01T07:27:45+09:00`
- Subject: `fix(memory): make destructive preparation atomic`

### Projection/lifecycle/compaction increment

- Commit: `6e5ca695347f062a539691fe98cc053ba1e42b3b`
- Tree: `d6872c59d623452a93d7012b0e29323a1d720b24`
- Parent: `6cddd37a86440df436bfd9b9f00c8a891d9164a3`
- Author/committer time: `2026-09-01T09:13:37+09:00`
- Subject: `fix(memory): enforce lifecycle suppression and compaction`

## Additive migrations

Migrations `001-047` were not edited. The committed Task 30 migration hashes are:

| Migration | SHA-256 |
|---|---|
| `048_task30_atomic_effect_runtime.sql` | `fb01e06f91d409048c980ab85eb14be58cbfab469a3c418e824cfeafff05e53c` |
| `049_task30_projection_authority.sql` | `87ae3402cf417be249a86ab3410a56f993979b41f57aed8c2da73dabe0ee1b78` |
| `050_task30_compaction_inventory.sql` | `dc6311086477854aa7fcbe66cb956a15b39e273461ce40df116596d47556a700` |

Fresh and legacy-prefix migration tests passed, including rejected-candidate recovery and direct
migration integrity.

## Nine semantic gates

| Gate | Result | Evidence |
|---|---|---|
| 1. Immediate normalized projection suppression | GREEN | Normalized lineage, unresolved quarantine, immediate suppression events, notification denial, state/dashboard/timeline filtering, and SSE invalidation passed focused and projection suites. |
| 2. Quiesced fresh-file AuthorityDb reconstruction | GREEN | The compactor reconstructed a fresh DB, changed inode atomically, retained unrelated data, drained runtime ownership, and removed forgotten bytes from the physical file. |
| 3. Fixed owner-qualified 70-surface inventory | GREEN | Catalog and scanner tests passed with exactly 70 fixed rows; the manual built-runtime probe reported `managed_surfaces=70`. |
| 4. Atomic destructive preparation and replay | GREEN | Correction/deletion preparation, tombstone append, suppression, request/delegation materialization, and ordered dispatch are immediate-transaction atomic. Semantic replay preserves original effective time/request identity and returns current global high-water. |
| 5. One production lifecycle boundary | GREEN | Approved executor, dashboard, and CLI use one `ProductionMemoryLifecycleService`; typed observations and the three JARVIS barrier IDs are wired without callback/root/needle bypasses. |
| 6. Export expiry and restore sanitation | GREEN | Proof-time one-day expiry and exact-prefix fresh-file restore passed; restored candidates, outbox/control copies, dependent rows, and citation-form content are suppressed/sanitized without activation authority. |
| 7. External 26-row crash matrix | GREEN | Provider external process suites passed 29 tests covering the 23 provider rows. An armed external supervisor killed and restarted each of the 3 JARVIS rows; every row had one durable barrier record, zero watchdog expiry, and zero residual process/listener count. |
| 8. 32-worker/four-lane/two-provider process gate | GREEN | An armed real-process run used 32 JARVIS workers across remember/correction/deletion/export and two workers loading the pinned provider wheel's `RequestStore`. It reported exact `frames/claims/effects/settlements=4/4/4/4`, duplicate frames/effects `0/0`, watchdog expirations `0`, and residual processes/listeners `0/0`. The real MCP lifecycle separately proved all four actual effects. |
| 9. Fresh skew matrix | **BLOCKED** | New/new is green and new/old fails closed, but fresh archive-built old/new fails at genesis with `SECOND_BRAIN_SCHEMA_MISMATCH`, zero start/request events. The immutable provider's own legacy V1 write test also fails. |

## Physical-scan RED and GREEN

The concrete RED was:

```text
npx vitest run --no-file-parallelism tests/integration/memory-real-process-driver.test.ts
MEMORY_COMPACTION_PHYSICAL_SCAN_FAILED
```

The retained managed copies were identified in `control_command_requests.args_json` and
`memory_outbox.request_json`. Existing restore derivation and fresh-authority copy filters were
extended to sanitize matching candidates, authority dependencies, outbox attempts/reconciliation,
and control requests. Ordinary compaction now applies the same blocked-projection derivation.
Temporary diagnostics were removed.

Final isolated GREEN:

```text
Test Files  1 passed (1)
Tests       1 passed (1)
```

The final 24-file semantic batch then passed `24` files / `44` tests, including the same real built
MCP child and physical scan.

## Barrier and process QA

### Provider barrier rows

```text
uv run pytest -q tests/integration/test_provider_process_harness.py \
  tests/integration/test_memory_crash_recovery.py
29 passed in 78.33s
```

### JARVIS external supervisor rows

```json
{"rows":[
  {"barrier_id":"jarvis_suppression_tombstone_commit","signal":"SIGKILL","restart":0,"durable_rows":1},
  {"barrier_id":"jarvis_proof_observation","signal":"SIGKILL","restart":0,"durable_rows":1},
  {"barrier_id":"before_settlement_commit","signal":"SIGKILL","restart":0,"durable_rows":1}
],"watchdog_expirations":0,"processes_after":0,"listeners_after":0}
```

Every supervisor subscribed to the exact armed/reached message before trigger. There were no fixed
sleeps or polling loops.

### Combined process counters

```json
{"schema_version":1,"workers":32,"providers":2,"provider_runtime":"pinned-wheel",
 "frames":4,"claims":4,"effects":4,"settlements":4,"duplicate_frames":0,
 "duplicate_effects":0,"watchdog_expirations":0,"processes_after":0,"listeners_after":0}
```

## Skew blocker

### Fresh old JARVIS / new provider at genesis

The old JARVIS archive was built from `c89fd43...` with an offline clean install. The provider wheel
was freshly extracted from the immutable `f051...` artifact and initialized at genesis. The archived
old contract and transport produced:

```json
{"lane":"old_jarvis_new_provider_genesis",
 "archive_commit":"c89fd43a2f4bac9862f2c4427e71e1b74657d840",
 "provider_commit":"f051fe50fdae1af0e88e45be7805fa7cbf53ea9c",
 "outcome_kind":null,"error_code":"SECOND_BRAIN_SCHEMA_MISMATCH",
 "error_disposition":"fatal","started_events":0,"requested_events":0,
 "diagnostics_codes":["SECOND_BRAIN_SCHEMA_MISMATCH"]}
```

### Fresh new JARVIS / old provider

The old provider was freshly archived, offline-synced, and built from `30cebe1...`. Current JARVIS
failed closed as required:

```json
{"lane":"new_jarvis_old_provider",
 "provider_archive_commit":"30cebe1670c0b65dc9832066a09c2c64f8371b20",
 "outcome_kind":null,"error_code":"SECOND_BRAIN_SCHEMA_MISMATCH",
 "error_disposition":"fatal","started_events":0,"requested_events":0,
 "diagnostics_codes":["SECOND_BRAIN_SCHEMA_MISMATCH"]}
```

### Provider self-test corroboration

`uv run pytest -q tests/test_mcp_profile_compatibility.py tests/test_mcp_generation.py` failed:

```text
test_legacy_mode_preserves_task29_tool_and_v1_write_schemas
assert result.is_error is False
1 failed, 6 passed
```

Earlier real-stdio profile/contract tests passed `7/7`, including exact-selector and unknown-profile
fail-closed behavior. This does not repair the archived schema mismatch or failed legacy V1 write.
No JARVIS change can alter an archived old client's contract or the immutable provider facade.

## Final scoped verification

- Task 30 semantic batch: `24` files / `44` tests passed.
- Exact Task 27-29 adjacent batch: `54` files / `454` tests passed.
- Exact policy/projection batch after the observed pre-049 compatibility fix: `60` files / `405`
  tests passed.
- Control-plane/approved executor: `2` files / `21` tests passed.
- Dashboard/control affected rerun: `4` files / `40` tests passed.
- Migration batches: `2` files / `15` tests passed.
- Reviewability command: `3` files / `11` tests passed.
- Electron package tests: `1` file / `5` tests passed.
- Real Electron packaging with an isolated remote-only product home: `ok=true`, Electron `44.0.0`,
  remote-only authority mode, temporary package removed.
- `npm run typecheck`: passed.
- `npm run lint`: passed with zero warnings.
- `npm run build`: passed; backend and dashboard built.
- Installed no-excuse checker: `No violations in 81 file(s).`
- Changed/new TypeScript review: 81 files; no line exceeded 160 columns; the sole file above 250
  lines is the indivisible 478-line real-process lifecycle test with one `SIZE_OK` annotation.
- `git diff --check`: passed.
- Manual built-runtime QA: migration-050 schema present, current-state JSON/Markdown written,
  doctor green, timeline readable, catalog count 70, sensitive count 0, residual process/listener
  counts 0/0.

One initially observed adjacent failure (`no such table: memory_projection_authority` against a
migration-035 fixture) was fixed only at the projection binding/read boundary. The focused test
passed `14/14`, then the complete policy/projection batch passed `405/405`.

## Cleanup and scope

Product paths (`migrations`, `src`, `tests`, package metadata, and contracts) were clean after the
implementation commit. Session-created temp roots, SQLite sidecars, sockets, keys, package roots,
worker processes, and listeners were removed. `.debug-journal.md` and its shared Git exclude entry
were removed before sealing. Unrelated pre-existing untracked `.omo` artifacts were not modified or
claimed as product WIP.

## Final status

The JARVIS implementation increments are reproducibly green and committed. Semantic gate 9 is an
exact, independently reproduced blocker in immutable provider compatibility. Therefore Task 30
remains **NOT PASS** and must not be checked or accepted from this evidence.
