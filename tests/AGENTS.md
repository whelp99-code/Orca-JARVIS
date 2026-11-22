> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# tests/ — backend Vitest tree

Earned this file (score 14, remeasured 2026-11-21): unit 222 + integration 422 + fixtures 99 + longitudinal 10. Distinct from Playwright `e2e/` and dashboard Vite tests. Child files: `unit/`, `integration/`, `fixtures/`.

## OVERVIEW
Backend Vitest only. Dashboard React tests live in `dashboard/src`. Playwright specs live in `e2e/`.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Isolated parsers/contracts | `unit/` (222) | own AGENTS.md |
| HTTP/CLI/SQLite/process | `integration/` (422) | own AGENTS.md |
| Shared temp DB + Ed25519 | `helpers.ts` | `tempDb`, `initialized`, `localKey`, `snapshot`, `decisionReceiptFor` |
| Spawnable harnesses | `fixtures/` | own AGENTS.md; emit `dist/tests/fixtures/` |
| Personal-OS eval | `longitudinal/` (10) | `scripts/personal-os-eval.mjs`; legacy `test/fixtures/personal-os/` |
| GUI Electron/driver | vitest `gui` include | two integration files; excluded from every other profile |
| Legacy acceptance JSON | `test/fixtures/` (singular) | `pre-gjc-e2e.json`; not under `tests/` |

## CONVENTIONS
- `JARVIS_TEST_PROFILE` is `backend` / `unit` / `integration` / `gui`. Unknown throws `TEST_PROFILE_INVALID`. `backend` include is `tests/**`; `unit` and `integration` are directory-scoped, so `longitudinal/` runs only on `backend`.
- Empty-args `backend` shards `1/2` then `2/2`.
- ESM NodeNext `.js` specifiers from `.ts`. Mix barrel `src/index.js` and deep `src/*.js`.
- Inject clock / fixture `NOW` (2026-08-28 family). Product CLI has no clock flag — spawn `fixtures/compiled-daily-cli.ts`.
- HTTP via `undici` against `127.0.0.1` + `X-JARVIS-CSRF`. Child: `once(child, "exit"|"message")` before work.
- Exact envelope/byte/typed-error asserts. `it.each` fail-closed matrices. Given/When/Then on task-numbered files.

## ANTI-PATTERNS
- No sleeps/polling for async; subscribe then assert. Bounded `setTimeout` only as IPC/SSE guards.
- Do not call live Orca or live GJC from unit tests.
- Do not write host-CLI-dependent probe stderr tests.
- Do not add a clock-override flag to the product binary.
- Keep GUI files excluded from non-gui profiles.
- `legacyRemoteAuthDb` is retained-trigger only; current remote-approval is the v2 suites.

## COMMANDS
```bash
npm run test:unit
npm run test:integration
npm run test:backend
npm run test:gui
npx vitest run tests/integration/<file>.test.ts
```
