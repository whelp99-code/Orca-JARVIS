> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# tests/integration/ — process and HTTP Vitest

Earned this file (score 14): 422 files, distinct domain (live loopback HTTP, CLI spawn, SQLite). Profile include is `tests/integration/**` only. Parent owns profile names, clock injection, and the no-sleep rule.

## OVERVIEW
Vitest specs that open a temp DB, bind `127.0.0.1`, or spawn `dist/`. Not the unit parser tree.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Personal-ops DB | `personal-operations-test-helpers.ts` | only shared module here; `personalDb`, `legacyRemoteAuthDb` |
| Dashboard HTTP | `dashboard-*.test.ts` | `createDashboardServer` + `X-JARVIS-CSRF` / Origin |
| Phone gateway | `phone-gateway*.test.ts` | loopback; port 4176 is the fixture reservation |
| Morning CLI process | `daily-morning-cli-process.test.ts` | spawns `dist/tests/fixtures/compiled-daily-cli.js` |
| GJC assemble | `gjc-dispatch-assemble.test.ts` | 909 lines; largest file in this tree |
| Task 32 HTTP/memory | `task32-*.test.ts` | largest filename cluster |
| Electron package | `package-electron.test.ts` vs `package-electron-real.test.ts` | real driver is gui-profile only |
| Non-TS specs | `backend-build.test.mjs`, `runtime-identity.test.mjs`, `daemon-runtime-cli.test.mjs` | still Vitest |

## CONVENTIONS
- Suites import `../helpers.js` (`tempDb`, `initialized`, `localKey`) and `../fixtures/*`. No second helper barrel.
- `personal-operations-test-helpers.ts` clocks are `T0`–`T5` on `2026-08-28T00:00:00.000Z`. `legacyRemoteAuthDb` is the retained-trigger DB; current remote-approval is the v2 suites.
- In-process path is `execute` from `src/cli.js`. Process path is `node dist/src/cli.js` after `pretest` build. Do not treat a missing `dist/` as a product failure.
- Some files use top-level `it` with no `describe`. Assert envelopes and typed errors, not log prose.

## ANTI-PATTERNS
- Do not import this tree from `tests/unit/`.
- Do not add the two gui files to the integration include; `vitest.config.ts` already excludes them unless `JARVIS_TEST_PROFILE=gui`.
- `memory-candidates` deletion-refusal drives `python -m sb.cli`; that is not a license to shell out to host CLIs elsewhere.
- Do not mark a spawned CLI green when stderr is host-tooling noise.
