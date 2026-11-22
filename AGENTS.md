> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

> 리포 간 결정·관례·라우팅 규칙은 [`../dev-wiki`](../dev-wiki/README.md) 를 정본으로 본다. 이 파일은 이 리포 내부 규칙만 담는다.
> 이 체크아웃에서 작업을 시작하면, 도구 이름을 묻기 전에 `/home/jm/orca/engineering-vault/index.json`과 이 경로의 `projects/proj-*.json`을 읽고 `relations`와 `depends_on`을 따라간다. 생산 배포와 개발 HEAD를 한 값으로 합치지 않는다.

# PROJECT KNOWLEDGE BASE

**Generated:** 2026-11-21T12:09:02Z
**Commit:** 49275fa
**Branch:** release/jarvis-fp5-local-20261007

## OVERVIEW
Orca-JARVIS shadow authority/control-plane: Node 24.19.0 ESM TypeScript (SQLite via better-sqlite3, Ed25519 receipts) + React 19/Vite control-center. Package `orca-jarvis-shadow`; bin `jarvis` → `dist/src/cli.js`. Evolution is shadow-only.

## STRUCTURE
```
.
├── src/                  # flat NodeNext lib + CLI (681 top-level .ts/.mts); never import ./index.js
│   ├── dashboard/        # loopback node:http API, not the Vite app
│   └── integration/      # nested Core5 read/draft; flag default off
├── dashboard/            # Vite phone UI → dist/dashboard; 152 files; not a workspace pkg
├── tests/                # Vitest: unit 222 / integration 422 / fixtures 99 / longitudinal 10
├── test/fixtures/        # legacy JSON (pre-gjc-e2e, personal-os); do not merge with tests/fixtures
├── e2e/                  # Playwright; not in npm run verify
├── migrations/           # 110 NNN_snake.sql; journal key = filename, not prefix
├── contracts/            # 34 files; frozen MCP/scoped set is 23 + sha256 sidecars
├── scripts/              # 50 files; lib/ only importable layer
├── config/               # policy/schema JSON; only personal-os-policy.json is dist-copied
├── deploy/, ops/         # host-absolute units; src never imports these
└── docs/                 # executable Linux procedure = personal-os/release.md only
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Backend/CLI | `src/cli.ts` | mains: dashboard/main, phone-gateway-main, task-verifier-main, phone-memory-client-mcp; executor `cli-runtime.mts` |
| Dashboard HTTP | `src/dashboard/main.ts` | literal `127.0.0.1`; other host throws `LOCAL_SESSION_REQUIRED` |
| Frontend | `dashboard/src/main.tsx` | phone `/` `/memory` `/security`; `/finance-read` only with an adapter; tests live here, not `tests/` |
| Public API | `src/index.ts` | incomplete barrel (~81 export lines); not a runtime main |
| DB | `src/db.ts` + `migrations/` | re-export shim; mixin ends `authority-worker-store.ts`; errors also `jarvis-error.ts` |
| Live send | `src/orca-resume.ts` | sole `execFileSync("orca", argv)`; maxBuffer 1_000_000 |
| Core5 boundary | `src/integration/` | mail draft cannot approve/send/cancel; synthetic reads never write |
| Linux deploy | `docs/personal-os/release.md` | `deployment roots` / `render-units`; rehearsal is not a restart proof |
| Test hub | `tests/helpers.ts` | tempDb/initialized/localKey/externalAnchors; not `src/` |

## CODE MAP
| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `AuthorityDb` | class | `src/authority-worker-store.ts` | mixin chain end; `db.ts` / `authority-db.ts` are shims |
| `canonicalize` | fn | `src/canonical.ts` | common digest shape: `sha256:` + NUL domain |
| `ControlPlane` | class | `src/control-plane.ts` | approval control plane |
| `createDashboardClient` | fn | `dashboard/src/api.ts` | GET hub; no second API client |
| `MigrationStore.migrate` | method | `src/migration-store.ts` | filename journal + SHA-256 |
| `loadSecondBrainContract` | fn | `src/second-brain-transport-contract.ts` | profile → `contracts/` bytes+sidecar |
| `BACKEND_OUTPUT_ROOTS` | const | `scripts/lib/backend-build-identity.mjs` | backend publish identity; build-last manifest rule |

## CONVENTIONS
- Strict TS (`noUncheckedIndexedAccess`); 3 tsconfigs (backend NodeNext/ES2024 + `.js` specifiers, dashboard ESNext/Bundler+React JSX, e2e); only backend emits.
- Frontend imports backend contracts via `../../src/...` (no workspace).
- Wire JSON snake_case. `schema_version` usually `1`; scoped-write and phone memory body use `4`; integration finance reads use `2`. `sha256:` + canonicalize + NUL domain is the common digest shape, not the only one.
- Daily-loop calendar is fixed KST, not Intl TZ. GJC spawn uses `shell: false`.
- Vitest `fileParallelism: false`. `backend` includes `tests/**` (longitudinal runs only there); `unit`/`integration` are directory-scoped; `gui` is exactly `task33-driver.test.ts` + `package-electron-real.test.ts`. Unknown profile throws `TEST_PROFILE_INVALID`.
- Playwright `fullyParallel: false`, 1 worker, 0 retries. Default e2e: `control-center`, `task-lineage`, `sse-recovery`.
- ESLint `--max-warnings=0`; explicit `any` permitted.
- Deploy: immutable 40-hex release dirs + `current` symlink. Units bind dashboard `127.0.0.1:4173` and phone gateway `127.0.0.1:4176` (Node `/home/jm/.nvm/versions/node/v24.19.0/bin/node`).

## ANTI-PATTERNS (THIS PROJECT)
- NEVER edit shipped migration SQL; schema change = new file. Journal id is **filename**, not prefix. Duplicates: `028`, `072`–`075`, `079`, `080`, `097` (two each); `098` has three. `055` is the empty slot.
- Do not copy/pretty-print MCP contracts; sidecar+TS digest dual pin. `cancellation-result-v1.json` is not a dist artifact. `copy-migrations.mjs` copies 22 contract files plus `config/personal-os-policy.json`.
- Terminal prose is NOT status. `live-supervisor.ts` observes and never sends. Uncertain/`sending` acks are not success. Sole live send: `orca-resume.ts`.
- UI is never an authority source; no second dashboard API client; cached SSE never enables mutation; memory query never in URL/storage. Phone surface does not expose overview/tasks/agents/approvals.
- No `launchctl` of `docs/historical/` (`HISTORICAL_NON_EXECUTABLE`). Linux procedure = `docs/personal-os/release.md`.
- `publish-package-release.sh` moves `current` only with `--activate` and `JARVIS_PRODUCTION_ACTIVATION_APPROVAL=approved`. `publish-verified-release.sh` always activates and requires that gate before `npm run build`. Do not derive the receipt hash from the candidate.
- `CORE5_INTEGRATION_ENABLED` default off. Do not register `mail.send`. Do not add ClamAV, Docling, OpenTelemetry, DBOS, or a direct `jose` dependency. Native finance never authenticates or posts.
- No production bind mounts; bypass flags stay `0`; no `AUTH_DEMO_PASSWORD` in production.
- No deploy/restore/restart/dirty-checkout edits without explicit operator instruction. A rehearsal must not migrate the DB it was pointed at.
- Raw `git worktree` forbidden; use Orca worktree commands. Do not treat `.omo/evidence/` copies or plan checkboxes as product rules.

## UNIQUE STYLES
- `AuthorityDb` mixin chain ends at `authority-worker-store.ts`. Lightweight errors: `jarvis-error.ts`. Portfolio collector is a separate process and does not open `AuthorityDb`. Historical outbox/settlement/control proofs never renew write authority.
- Dual fixture trees stay separate: `test/fixtures/` (legacy JSON) vs `tests/fixtures/` (compiled harnesses, emit `dist/tests/fixtures/`). Most fixture `.mjs` workers load `dist/src`; `second-brain-mcp-child.mjs` reads `SB_CONFIG` and `contracts/second-brain-mcp-v*.json` instead. Product CLI has no clock flag; morning process tests spawn `compiled-daily-cli.js`. Declared read-surface fixtures are not producer proof.
- Nested AGENTS.md: `src/`, `src/dashboard/`, `src/integration/`, `dashboard/`, `tests/` (+ `unit/`, `integration/`, `fixtures/`), `migrations/`, `scripts/`, `contracts/`, `e2e/`, `deploy/`, `docs/` (+ `personal-os/`, `planning/`), `config/`, `ops/`, `.omo/`.

## COMMANDS
```bash
npm run verify              # runtime, lint, typecheck, tests, acceptance (fixed clock), build, CLI smoke; no e2e
npm test                    # pretest builds; backend vitest (serial) then dashboard
npm run test:e2e            # control-center, task-lineage, sse-recovery
npm run test:e2e:production-smoke  # JARVIS_E2E_NO_FIXTURE=1
npm run build:backend       # lock, staging, copy-migrations, metadata last
npm run build:dashboard     # vite outDir dist/dashboard
npm run architecture:check
node dist/src/cli.js deployment roots
node dist/src/cli.js deployment render-units --out DIR
```

## NOTES
- `PROJECT_INVENTORY.md` is stale; do not trust. `.omo/**` excluded from Vitest (~26k files, mostly `evidence/`).
- Empty-args `test:backend` shards 1/2 + 2/2. `test:unit|integration|backend|gui` via `node scripts/run-tests.mjs`. `build:fixtures` aliases `build:backend`. Dashboard tests are not under `tests/`.
- Node pin `.node-version` 24.19.0; npm@11.17.0.
- Acceptance: `npm run acceptance:pre-gjc -- --fixture test/fixtures/pre-gjc-e2e.json --clock 2026-08-09T00:00:00.000Z`. No `migrate` npm script.
- CI (`.github/workflows/ci.yml`): push/PR to `main`, `contents: read`, 30 min — `npm ci`, bubblewrap, `npm run verify`, then xvfb + `test:gui` + Playwright chromium + `test:e2e`.


<!-- github-development-management:v1:start -->
## GitHub 기반 개발 작업 관리 (사용자 지정 기본 흐름)
개발·수정·개선·고도화 요청을 받으면 `~/ops/github-development-management/WORKFLOW.md`를 읽고 자동 적용한다. 이 섹션은 같은 작업을 Linear/별도 보드에 중복 관리하라는 기존 안내보다 우선한다. 모델·권한·전문 검증 지침은 바꾸지 않는다.
- 실제 remote/registry로 대상 확인 → 기존 Issue/PR 검색·재사용(없을 때만 생성) → 목표·범위·인수 조건 기록 → 통합 Project 연결 → 구현·검증 → 근거 기록 → GitHub 재조회.
- 해당 작업의 Issue/Project 등록·상태·검증 댓글 갱신은 사용자 상시 승인 범위다. commit/push/PR/merge/deploy/삭제/권한 변경은 별도 기존 승인 범위를 따른다. 원격이 미확정이면 임의 저장소에 쓰지 않는다.
- 시작/종료 보고에 Issue URL을 남긴다. 등록 실패는 로컬 pending으로 보존하고 미등록이라고 밝힌다. 단순 질문·번역·읽기 전용 조사에는 생성하지 않는다.
- 상태 Backlog → In Progress → Verify → Done. 실제 인수 근거 없이 Done 처리하지 않는다. 코드 존재·테스트·배포·실사용을 구분한다. HANDOFF draft/사람 ready 규칙을 유지한다.
- 상세 원본: `~/ops/github-development-management/WORKFLOW.md`; 연결표: `~/ops/github-development-management/registry.json`; 도구: `python3 ~/ops/github-development-management/manage.py`.
<!-- github-development-management:v1:end -->
