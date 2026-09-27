> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

> 리포 간 결정·관례·라우팅 규칙은 [`../dev-wiki`](../dev-wiki/README.md) 를 정본으로 본다. 이 파일은 이 리포 내부 규칙만 담는다.
> 이 체크아웃에서 작업을 시작하면, 도구 이름을 묻기 전에 `/home/jm/orca/engineering-vault/index.json`과 이 경로의 `projects/proj-*.json`을 읽고 `relations`와 `depends_on`을 따라간다. 생산 배포와 개발 HEAD를 한 값으로 합치지 않는다.

# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-20T08:37:14Z
**Commit:** 82dc6f3
**Branch:** main

## OVERVIEW
Orca-JARVIS shadow authority/control-plane: Node 24 ESM TypeScript backend (SQLite via better-sqlite3, Ed25519-signed receipts) + React 19/Vite control-center. Package `orca-jarvis-shadow`; CLI bin `jarvis` → `dist/src/cli.js`. Evolution is shadow-only.

## STRUCTURE
```
.
├── src/                  # backend lib + CLI (flat; barrel index.ts; never import ./index.js)
│   └── dashboard/        # loopback node:http API (not the Vite app)
├── dashboard/            # Vite/React UI → dist/dashboard; loopback :4173; not a workspace pkg
├── tests/                # Vitest unit/integration/longitudinal/fixtures
├── test/fixtures/        # legacy pre-gjc-e2e + personal-os JSON
├── e2e/                  # Playwright; excluded from Vitest
├── migrations/           # 103 NNN_snake.sql; journal key = filename, not prefix
├── contracts/            # frozen MCP/scoped JSON + sha256 sidecars (no v2)
├── scripts/              # .mjs drivers; lib/ only importable layer
├── config/               # personal-os-policy-v1, JSON Schema 2020-12, routing/morning examples
├── deploy/, ops/         # host-absolute systemd; src never imports these
└── docs/                 # Linux procedure = personal-os/release.md; historical/ non-executable
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Backend/CLI | `src/cli.ts` | extra: phone-gateway-main, task-verifier-main, phone-memory-client-mcp |
| Dashboard HTTP | `src/dashboard/main.ts` | bind 127.0.0.1; UI is never an authority source |
| Frontend | `dashboard/src/main.tsx` | three stores; dashboard tests live here, not `tests/` |
| Public API | `src/index.ts` | barrel only, not a runtime main |
| DB | `src/db.ts` + `migrations/` | `db.ts` re-exports mixin chain; errors in `jarvis-error.ts` |
| Live send | `src/orca-resume.ts` | sole `execFileSync("orca", argv)` |
| Linux deploy | `docs/personal-os/release.md` | `deployment roots` / `render-units` |
| Test hub | `tests/helpers.ts` | tempDb/initialized/localKey; compiled fixtures in `tests/fixtures/` |

## CODE MAP
| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `AuthorityDb`, `JarvisError` | class | `src/db.ts` | ~544 | SQLite authority store (mixin ends `authority-worker-store.ts`) |
| `canonicalize` | fn | `src/canonical.ts` | ~288 | digest JSON; `sha256:` + NUL-terminated domain |
| `ControlPlane` | class | `src/control-plane.ts` | ~131 | approval control plane |
| memory-projection-authority | module | `src/memory-projection-authority.ts` | ~103 | projection authority |
| `createDashboardClient` | fn | `dashboard/src/api.ts` | ~28 | GET hub; no second API client |
| `createDashboardStore` | fn | `dashboard/src/store.ts` | — | browser SSE/state hub |
| `ControlCenterRoot` | component | `dashboard/src/root.tsx` | — | route table |
| `MigrationStore.migrate` | method | `src/migration-store.ts` | — | filename journal + SHA-256 |
| `loadSecondBrainContract` | fn | `src/second-brain-transport-contract.ts` | — | profile → `contracts/` bytes+sidecar |
| `BACKEND_OUTPUT_ROOTS` | const | `scripts/lib/backend-build-identity.mjs` | — | backend publish identity |

## CONVENTIONS
- Strict TS (`noUncheckedIndexedAccess`); 3 tsconfigs (backend NodeNext/ES2024 + `.js` specifiers, dashboard ESNext/Bundler+React JSX, e2e); only backend emits. CLI runtime: `cli-runtime.mts`.
- Frontend imports backend contracts via `../../src/...` (no workspace).
- Wire JSON snake_case + `schema_version: 1`. Digests: `sha256:` + canonicalize + NUL domain.
- Daily-loop calendar is fixed KST, not Intl TZ. GJC spawn uses `shell: false`.
- Tests serialized: Vitest `--no-file-parallelism`; Playwright `fullyParallel: false`, 1 worker, 0 retries. Profiles via `JARVIS_TEST_PROFILE` (`backend`|`unit`|`integration`|`gui`).
- ESLint `--max-warnings=0`; explicit `any` permitted.
- Deploy: immutable 40-hex release dirs + `current` symlink; dashboard loopback-only :4173.

## ANTI-PATTERNS (THIS PROJECT)
- NEVER edit shipped migration SQL; schema change = new file. Journal id is **filename**, not prefix (duplicates: 028, 072–075, 079–080).
- Do not copy/pretty-print MCP contracts; sidecar+TS digest dual pin; `cancellation-result-v1.json` is not a dist artifact.
- Terminal prose is NOT status; supervisor/CLI consume never send; never blind-replay uncertain acks. Sole live send: `orca-resume.ts`.
- UI is never an authority source; no second dashboard API client; cached SSE never enables mutation; memory query never in URL/storage.
- No `launchctl` of `docs/historical/` (`HISTORICAL_NON_EXECUTABLE`). Linux procedure = `docs/personal-os/release.md`.
- Do not derive publish receipt hash from the candidate; `--activate` needs `JARVIS_PRODUCTION_ACTIVATION_APPROVAL=approved`.
- No production bind mounts; bypass flags stay `0`; no `AUTH_DEMO_PASSWORD` in production.
- No deploy/restore/restart/dirty-checkout edits without explicit operator instruction.
- Raw `git worktree` forbidden; use Orca worktree commands.

## UNIQUE STYLES
- `AuthorityDb` mixin chain ends at `authority-worker-store.ts`; `db.ts` is a one-line re-export. Lightweight errors: `jarvis-error.ts`.
- Dual fixture trees: `test/fixtures/` (legacy JSON) vs `tests/fixtures/` (compiled harnesses). `.mjs` fixture workers load `dist/src`. Product CLI has no clock override.
- Nested AGENTS.md: `src/`, `src/dashboard/`, `dashboard/`, `tests/`, `tests/fixtures/`, `migrations/`, `scripts/`, `contracts/`.

## COMMANDS
```bash
npm run verify              # canonical gate: runtime, lint, typecheck, tests, acceptance (fixed clock), build, CLI smoke
npm test                    # pretest builds; backend vitest (serial) then dashboard
npm run test:e2e            # only control-center, task-lineage, sse-recovery specs
npm run test:e2e:production-smoke  # JARVIS_E2E_NO_FIXTURE=1
npm run build:backend       # lock, staging, copy-migrations, metadata last
npm run build:dashboard     # vite → dist/dashboard
npm run architecture:check
node dist/src/cli.js deployment roots
node dist/src/cli.js deployment render-units --out DIR
```

## NOTES
- `PROJECT_INVENTORY.md` is stale; do not trust.
- `.omo/**` excluded from test discovery. Empty-args `test:backend` shards 1/2 + 2/2. Unknown `JARVIS_TEST_PROFILE` → `TEST_PROFILE_INVALID`.
- Node pinned by `.node-version` (24.x), npm@11.17.0.
- Acceptance: `npm run acceptance:pre-gjc -- --fixture test/fixtures/pre-gjc-e2e.json --clock 2026-08-09T00:00:00.000Z`.
- No `migrate` npm script.


<!-- github-development-management:v1:start -->
## GitHub 기반 개발 작업 관리 (사용자 지정 기본 흐름)
개발·수정·개선·고도화 요청을 받으면 `~/ops/github-development-management/WORKFLOW.md`를 읽고 자동 적용한다. 이 섹션은 같은 작업을 Linear/별도 보드에 중복 관리하라는 기존 안내보다 우선한다. 모델·권한·전문 검증 지침은 바꾸지 않는다.
- 실제 remote/registry로 대상 확인 → 기존 Issue/PR 검색·재사용(없을 때만 생성) → 목표·범위·인수 조건 기록 → 통합 Project 연결 → 구현·검증 → 근거 기록 → GitHub 재조회.
- 해당 작업의 Issue/Project 등록·상태·검증 댓글 갱신은 사용자 상시 승인 범위다. commit/push/PR/merge/deploy/삭제/권한 변경은 별도 기존 승인 범위를 따른다. 원격이 미확정이면 임의 저장소에 쓰지 않는다.
- 시작/종료 보고에 Issue URL을 남긴다. 등록 실패는 로컬 pending으로 보존하고 미등록이라고 밝힌다. 단순 질문·번역·읽기 전용 조사에는 생성하지 않는다.
- 상태 Backlog → In Progress → Verify → Done. 실제 인수 근거 없이 Done 처리하지 않는다. 코드 존재·테스트·배포·실사용을 구분한다. HANDOFF draft/사람 ready 규칙을 유지한다.
- 상세 원본: `~/ops/github-development-management/WORKFLOW.md`; 연결표: `~/ops/github-development-management/registry.json`; 도구: `python3 ~/ops/github-development-management/manage.py`.
<!-- github-development-management:v1:end -->
