> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# tests/fixtures/ — harnesses and declared records

Earned this file (score 12, files remeasured 99). `memoryDatabase` is the memory-DB hub; importer count was not remeasured. Distinct from Vitest suites. `task27/` and `task30/` are single-file corpora; parent covers them.

## OVERVIEW
Compiled harnesses and JSON/PEM corpora for Vitest/Playwright/process tests — not a public package.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Memory DB + seeds | `memory-candidate-store.ts` | `memoryDatabase` / `closeMemoryDatabase` |
| Memory constants | `memory-candidate-fixture.ts` | `MEMORY_NOW`, `memoryPolicy` |
| Outbox saga | `memory-outbox-fixture.ts` | `outboxFixture` |
| Declared read-surface graph | `local-observation-chain.ts` | inserts recommendation/context; **not** producer proof |
| Production chain | `daily-production-chain.ts` | inserts **no** recommendation/context |
| Playwright webServer | `dashboard-http-server.ts` | serves `dist/dashboard`; ids/ports in `dashboard-fixture-ids.ts` |
| Clock-injected morning CLI | `compiled-daily-cli.ts` | run as `dist/tests/fixtures/compiled-daily-cli.js` |
| MCP fake | `second-brain-mcp-child.mjs` | stdio JSON-RPC; `SB_CONFIG` + frozen `contracts/second-brain-mcp-v*.json`. Does **not** import `dist/src` |
| IPC/crash workers | `*.mjs` under this dir | GJC, retention, progress, task-*, memory concurrency; those load `../../dist/src` |
| Task 27 SQL copy | `task27/037_recommendation_work_runtime.sql` | byte/layout tests |
| Task 30 rejected manifest | `task30/rejected-migration-manifest.ts` | `REJECTED_TASK30_MIGRATIONS` |
| Phone TLS | `phone-memory-test-*.pem` | disposable TEST ONLY |
| Empty migrated template | `migrated-database.ts` | schema cache only — no keys or rows |

## CONVENTIONS
- `.ts` imports `../../src/*.js`. Crash/task `.mjs` workers import `../../dist/src`. Exception: `second-brain-mcp-child.mjs` reads frozen contract JSON only.
- `npm run build:fixtures` aliases `build:backend`.
- Loopback `127.0.0.1` only. Port 4176 reserved for phone gateway. Origins `*.example.invalid`.
- Frozen clocks mostly `2026-08-28T12:00:00.000Z`. IDs `pos:v1:…`.
- Two families: **declared/read-surface** vs **production-path**. Do not mix evidence.

## ANTI-PATTERNS
- Never treat `local-observation-chain.ts`, `recommendation-fixture.ts`, or `forged-citation-fixture.ts` as evidence the producer works.
- Never add a clock flag to the product CLI; inject via `execute()` deps.
- `gjc-dispatch-coordinator.mjs` never invokes an agent or host coordinator.
- `migrated-database.ts` never seeds keys or test rows.
- `provable-exclusion.ts` is not isolation proof (same-uid can still open the DB).
- `dashboard-orca-runner.ts` canary includes `FIXTURE_SECRET` — assert redaction, do not leak.
