# Task 30 implementation evidence

Acceptance authority: SHA-256 `bcf1336f5ca8eeb1686c04dbaf334d38827f7fc2619ab1365baa2b79773e843c` (`task-30-option-b-frozen-acceptance.md`).
Red-team authority: SHA-256 `75dcbc26d83b5c0818b52a509bf89fed2c77bca844daac710f015a621040c462` (`task-30-acceptance-redteam.md`).

## Entry and atomic provider-first pair

- JARVIS entry: `4853f7d643551354778cc6245a4d02f354127497`
- Second Brain entry: `b847824359f764a9ddb2fb5f4332bb6ced7d4a93`
- Second Brain provider commit: `b1c6b981862853b4b2510c27244de0bc00477c54`
- JARVIS implementation: the commit containing this evidence
- Both commit subjects: `feat(memory): propagate correction and erasure`
- No push, deployment, release activation, service action, or production/personal/Mac path was used.

## Frozen contract, dependency, and vectors

- MCP schema/tool count: `3` / `9`
- Tools: `sb_generation_status`, `sb_open_conflicts`, `sb_read_page`, `sb_recent_changes`, `sb_remember`, `sb_request_status`, `sb_resolve_memory_target`, `sb_search`, `sb_write_request`
- Canonical contract SHA-256 and checked sync result: `1406f97695970a099af2569ab93777b67603a2a2261b9f6d03646e430d6098fe`
- Frozen vectors: correction, export, forget, delegation revocation, feature/tool count; cross-language byte/digest tests passed.
- Runtime Zod dependency: exact `4.1.5`; registry integrity `sha512-rcUUZqlLJgBC33IT3PNMgsCq6TzLQEG/Ei/KTCU0PedSWRMAXoOUN+4t/0H+Q8bdnLPdqUYnvboJT0bn/229qg==`.
- Provider wheel SHA-256 at the final provider commit: `89ebfbf6526cf11ca4da9bd344b883f2c53abaf2a9f4b2d6b29ae6c5b498c56c` (the final build is repeated by the recorded build gate).

## RED and implementation closure

Characterization/RED reproduced the rejected behavior before remediation: local control completed while the provider remained pending, the superseded provider record remained readable, and correction plaintext remained in JARVIS SQLite bytes. Provider RED also demonstrated missing cross-process FD drain and missing fresh derived stores.

The implemented closure provides:

- provider-owned durable V1/V2 request execution, global replay aliases, one claim/fence, signed disposition proof, and additive Task 29 compatibility;
- sealed copy-on-write generations with fresh Git/ledger/search/vector/brief stores, shared read pins, process FD drain, atomic activation journal, predecessor/backup/export disposal, and crash recovery;
- permanent JARVIS tombstone high-water plus distinct correction, deletion, and export sagas;
- strict Zod wire parsing, signed delegated capability, release-bound provider proof verification, metadata-only authority rows, mode-0600 erasable spool, immediate suppression, physical compaction, restore sanitation, and reingress rejection;
- same-target sequential export/forget support without treating target/scope/payload bindings as globally unique replay aliases;
- Task 29 genesis remember through Task 30 MCP mode without requiring a pre-existing generation, with deterministic citation/frontmatter materialization for artifact settlement.

## Writer gates

Second Brain writer gates (reserved independent canonical command not used):

- focused effect/executor/erasure/generation/export/write/MCP/search/brief/vault: `105 passed`;
- sqlite-vec deterministic lane: `18 passed, 1 skipped`;
- target/delegation/proof/store/restore/reingress/systemd/lifecycle/crash/two-process: `21 passed`;
- connector/store/compile/CLI/MCP-contract/walking-skeleton adjacent lane: `214 passed, 1 skipped`;
- `uv run ruff check sb tests`: clean;
- `uv run basedpyright sb tests`: `0 errors, 0 warnings, 0 notes`;
- installed Python no-excuse checker: `no violations in 21 file(s)`;
- `uv build`: sdist and wheel built successfully.

JARVIS writer gates (`npm run verify` was not used):

- exact Task 30 focused command including real process driver: `16 files, 20 passed`;
- all memory/Second Brain Task 27-30 adjacent lanes: `67 files, 446 passed`;
- policy/context/recommendation/daily/morning/evening/notification/TaskTimeline/dashboard/API/SSE reads: `84 files, 642 passed`;
- control plane and approved-executor focused lane: `2 files, 21 passed`;
- reviewability derivation: no omitted modules or non-baselined offenders;
- installed TypeScript no-excuse checker: `No violations in 57 file(s)`;
- changed-file LSP diagnostics: zero errors/warnings/hints on checked Task 30 source and real driver;
- `npm run lint`, `npm run typecheck`, and `npm run build`: pass.

## Real non-synthetic lifecycle

`tests/integration/memory-real-process-driver.test.ts` runs with a runtime-random old/corrected sentinel and cleans its unique roots in `finally`. It uses the built provider wheel, actual stdio MCP child, JARVIS transport, approved and signed Task 29 remember authority, actual `sb apply-requests --once` processes, and the three dedicated Task 30 sagas.

Observed/asserted effect delta:

- exactly four `sb_write_request` frames: one schema-1 remember and one each correction/export/forget schema-2 frame;
- four provider requests, each `proved`, phase `proved`, fence `1`;
- one correction proof/settlement, one export proof/publication/settlement, and one deletion proof/settlement;
- export state `available` before forget and `invalidated` after forget;
- JARVIS high-water advances only for correction and forget;
- pre-correction and pre-forget managed backups contain zero target matches before proof;
- stale pre-correction JARVIS DB restore is sanitized and not activated;
- replay/reconcile calls produce zero additional write frames or effects;
- final active provider generation count is one, managed export data files are zero, provider/JARVIS physical sentinel matches are zero, and old-generation open FDs are zero.

No sentinel value, private key material, correction content, or external receipt body is recorded in this evidence.

## Scope and cleanup

- Runtime lifecycle roots were created only under unique `/tmp/task30-real-process-*` directories and were removed by the test; post-run enumeration found none.
- The separate manual QA root under `/tmp/orca-task30-real-lifecycle` is removed in the final cleanup receipt after digest-only evidence extraction.
- Provider tracked work is clean at the provider commit. JARVIS stages only Task 30 product/tests/migrations/package metadata and this evidence; pre-existing approved `.omo/` work is preserved.
- Canonical reserved commands `uv run pytest -q --ignore=tests/test_embeddings.py` and `npm run verify` were not invoked. No push or deploy was performed.
