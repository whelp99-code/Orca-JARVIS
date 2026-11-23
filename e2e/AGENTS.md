> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# e2e/ — Playwright specs, serial, not Vitest

Score 6 (21 TypeScript files; distinct from dashboard unit tests). Configs live at repo root, not here.

## OVERVIEW
Browser specs and harnesses. Default `npm run test:e2e` is not this whole directory. `npm run verify` does not run these specs.

## WHERE TO LOOK
| Surface | Files | How to run |
|---------|-------|------------|
| Default gate | `control-center.spec.ts`, `task-lineage.spec.ts`, `sse-recovery.spec.ts` | `npm run test:e2e` (`playwright.config.ts`) |
| Production smoke | `production-smoke.spec.ts` | `JARVIS_E2E_NO_FIXTURE=1` |
| Memory / task32 | `task32-memory*.spec.ts` | `playwright.task32.config.ts`; no shared webServer |
| Remote approval | `remote-approval*.spec.ts`, `remote-approval-*.ts` | `playwright.remote.config.ts` |
| Phone SPA | `phone-gateway-spa.spec.ts` | forbidden routes stay closed |
| Helpers | `browser-qa.ts`, `control-center-flows.ts`, `fixture-access.ts` | not specs |

## CONVENTIONS
- Playwright: `fullyParallel: false`, one worker, zero retries. Default config starts two fixture webServers and does not reuse an existing server.
- `JARVIS_E2E_NO_FIXTURE=1` drops webServer. Task32 must not touch seeded or production ports.
- Accessibility checks use `@axe-core/playwright`. Task32 fixtures use `undici`.
- Typecheck is `tsc -p tsconfig.e2e.json` (noEmit). Lint includes this tree.

## ANTI-PATTERNS
- Do not run production-smoke as a stand-in for isolated `npm run test:e2e`.
- A Memory search query must not land in the URL, history, storage, or any request URL.
- Do not render provider offline, unavailable, `no_data`, or stale as empty memory.
- Deleted or superseded text must not render after forget or correction.
- Do not treat a passing spec as product completion or as a live `:4173` measurement.
