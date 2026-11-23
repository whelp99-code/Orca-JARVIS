> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# tests/unit/ — injected runners

Earned this file (score 14): 222 `.test.ts` files, distinct domain (parsers, contracts, policy). No HTTP server and no `dist/` spawn. Parent owns the profile enum and the no-live-Orca rule.

## OVERVIEW
Vitest modules that import `src/` in-process. Profile include is `tests/unit/**` only.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Public barrel pin | files importing `../../src/index.js` | `AuthorityDb`, personal-context, second-brain adapter |
| Deep module pin | `../../src/<module>.js` | one or two importers each; NodeNext `.js` specifier |
| Contract corpora | `personal-contracts-generative.test.ts`, `*-contract.test.ts` | byte/discriminant tables, not prose |
| Second Brain adapter | `second-brain-*.test.ts` | transport, readiness, write-request |
| Phone gateway logic | `phone-gateway.test.ts` | config/routes/limiter; HTTP process tests are integration |
| Shared failure table | `orca-read-envelope.test.ts` | only module `export` in this tree: `failures` |
| Script-adjacent | `electron-deep-link.test.ts`, portfolio probe | may import `scripts/lib/*.mjs` |

## CONVENTIONS
- Zero `export` except `orca-read-envelope.test.ts` `failures` (6 Orca read codes). Do not import another unit file; share via `tests/helpers.ts` or `tests/fixtures/`.
- `../helpers.js` is optional. Many files never open SQLite.
- Given/When/Then comments appear on task-numbered and contract files. Not required on every spec.
- `it.each` fail-closed matrices. No `it.only` / `describe.only`.

## ANTI-PATTERNS
- Do not spawn `dist/src/cli.js`, bind a port, or call live Orca/GJC from this tree. That belongs in `integration/`.
- Do not add a product clock flag to reach a frozen `NOW`; inject the runner.
- Do not treat `../../src/index.js` coverage as proof a deep module's side effects ran.
- `undici` in `task12-characterization.test.ts` is not a pattern for new unit files.
