> 리포 간 결정·관례·라우팅 규칙은 [`../dev-wiki`](../dev-wiki/README.md) 를 정본으로 본다. 이 파일은 이 리포 내부 규칙만 담는다.

# AGY Agent Instructions

## Mandatory Execution Policy (Tool & Skill Exclusive)

- **자가적 추론 및 포장 100% 금지**: 모든 작업, 상태 보고, 결과 검증, 코드 및 문서 조작 시 짐작이나 말뿐인 포장, 자연어 퉁치기를 전면 금지한다.
- **Tool & Skill 기반 100% 실행**: 모든 작업과 판단은 오직 Antigravity CLI 툴(Tool) 및 등록된 스킬(Skill)의 물리적 실행 결과만을 바탕으로 동작한다.
- **실측 수치 기반 보고**: 보고서 작성 시 주관적 단어("100% clean", "이상 없음" 등) 대신 기계적 실측 수치(M/D/?? 개수, exact branch name, ahead/behind count)만 있는 그대로 제시한다.

---

# PROJECT KNOWLEDGE BASE

**Generated:** 2026-08-23T14:34:26Z
**Commit:** 57dec90
**Branch:** main

## OVERVIEW
Orca-JARVIS shadow authority/control-plane: Node 24 ESM TypeScript backend (SQLite via better-sqlite3, Ed25519-signed receipts) + React 19/Vite control-center dashboard. Package `orca-jarvis-shadow`, CLI bin `jarvis` -> `dist/src/cli.js`.

## STRUCTURE
```
.
├── src/                # backend lib + CLI (flat, domain-heavy; barrel: index.ts)
│   └── dashboard/      # dashboard HTTP/API server (Node side)
├── dashboard/          # React/Vite frontend (own tsconfig; NOT a workspace pkg)
├── tests/              # Vitest unit/ + integration/ + fixtures/ (fixture HTTP servers live here)
├── test/fixtures/      # legacy: pre-gjc-e2e.json acceptance fixture only
├── e2e/                # Playwright specs (control-center, production-smoke)
├── migrations/         # 001-030 ordered SQLite migrations; copied to dist by scripts/copy-migrations.mjs
├── scripts/            # .mjs build/acceptance/smoke/release helpers
├── config/             # portfolio repo scope + status JSON (checked in)
├── deploy/, ops/       # systemd/launchd units, portfolio collector shell (host-specific abs paths)
└── docs/               # release/design/planning docs (KO+EN)
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Backend entry | `src/cli.ts` | no src/main.ts; direct-run detection in-module |
| Dashboard server entry | `src/dashboard/main.ts` | builds AuthorityDb + createDashboardServer |
| Frontend entry | `dashboard/src/main.tsx` | API client + store -> ControlCenterRoot |
| Public API | `src/index.ts` | export barrel only, not a runtime main |
| DB/schema | `src/db.ts` + `migrations/` | shipped migration bytes are IMMUTABLE |
| Ops prohibitions | `CONTROL_TOWER.md`, `ORCA_MASTER_CHARTER.md`, `docs/*release*.md` | read before deploy/git/terminal actions |

## CODE MAP
| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `AuthorityDb`, `JarvisError` | class | `src/db.ts` | highest inbound | SQLite authority store; imported by nearly everything |
| `canonicalize` | fn | `src/canonical.ts` | cross-cutting | canonical JSON for signing/persistence |
| `ControlPlane` | class | `src/control-plane.ts` | CLI/exec/loopgraph/runbook/dashboard | approval control plane |
| `types.ts` | types | `src/types.ts` | broad type-only | shared domain types |
| `createDashboardServer` | fn | `src/dashboard/server.ts` | CLI/fixtures/integration tests | route composition boundary |
| read-model contracts | types | `src/dashboard/read-model.ts` | most of dashboard/src | backend<->frontend contract hub |
| store | module | `dashboard/src/store.ts` | React root + harnesses | browser state hub |

## CONVENTIONS
- Strict TS everywhere incl. `noUncheckedIndexedAccess`; 3 tsconfigs (backend NodeNext/ES2024, dashboard ESNext/Bundler+React JSX, e2e); only backend emits.
- Frontend imports backend contracts via relative `../../src/...` (no workspace).
- Tests deliberately serialized: Vitest `--no-file-parallelism`; Playwright 1 worker, 0 retries.
- ESLint `--max-warnings=0`; explicit `any` permitted.
- Deployment: immutable 40-hex release dirs + `current` symlink; dashboard loopback-only :4173.

## ANTI-PATTERNS (THIS PROJECT)
- NEVER edit shipped migration SQL bytes; schema changes = new migration (see `docs/planning/01-DISCOVERY-BASELINE.md`).
- Retired collaboration tables hard-blocked by triggers (`migrations/026`); use task timeline.
- Terminal prose is NOT status; only verified structured signals; never blind-replay uncertain acks/failed sends (`docs/pre-gjc-shadow.md`).
- Supervisor/CLI consume paths never send/mutate terminals (`src/live-supervisor.ts`, `src/cli.ts`).
- No production bind mounts; bypass flags stay `0`; no `AUTH_DEMO_PASSWORD` in production (`CONTROL_TOWER.md:532`).
- No deploy/restore/restart/dirty-checkout edits without explicit operator instruction (`docs/control-center-release.md`).
- Raw `git worktree` forbidden; use Orca worktree commands (`ORCA_MASTER_CHARTER.md:107`).

## COMMANDS
```bash
npm run verify       # canonical gate: runtime check, lint, typecheck, tests, acceptance (fixed clock), build, CLI smoke
npm test             # pretest builds; backend vitest (serial) then dashboard vitest
npm run test:e2e     # builds, seeded fixture servers, control-center.spec.ts @1440+1024
npm run test:e2e:production-smoke   # JARVIS_E2E_NO_FIXTURE=1, live origin, skips if health down
```

## NOTES
- `PROJECT_INVENTORY.md` is stale (describes external /Volumes/DevSpace index); do not trust.
- `.omo/**` excluded from test discovery.
- Node pinned by `.node-version` (24.x), npm@11.17.0; CI = `npm ci` + verify + Chromium E2E, 20min timeout.
- Nested guides: `src/AGENTS.md`, `src/dashboard/AGENTS.md`, `dashboard/AGENTS.md`, `tests/AGENTS.md`.
