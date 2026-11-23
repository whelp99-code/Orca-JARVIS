> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# dashboard/ — React 19 / Vite control-center UI

Score 13 (distinct browser app; 152 files; `api.ts` ~28 importers, count not remeasured). Parent covers stack/tsconfig; this file is the UI map.

## OVERVIEW
Vite+React control-center UI; emit `dist/dashboard`; tests via this dir's `vite.config.ts` (jsdom, globals).

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Bootstrap | `src/main.tsx` | three clients/stores → `ControlCenterRoot` |
| Router | `src/root.tsx` | local adds `/overview` `/tasks/:taskId` `/proposals` `/agents/:agentId` `/approvals`; `/finance-read` only with an adapter; phone is `/` `/memory` `/security` |
| Dashboard state | `src/store.ts` | SSE `/api/v1/events`; coalesced refresh |
| Personal/Today | `personal-api.ts`, `personal-store.ts`, `today-route.tsx` | closed-record parsers |
| Memory | `memory-api.ts`, `memory-store.ts`, `memory-page.tsx` | Zod `.strict()`; no query in URL/storage |
| HTTP GET | `src/api.ts` | only GET client; extend here |
| Mutations | `authority-api.ts`, `api-mutations.ts` | `X-JARVIS-CSRF`; `SAFE_MESSAGES` |
| Guards | `portfolio-guard.ts`, `bounded-response.ts`, `task-execution-guard.ts` | 64KiB body cap |
| Design tokens | `DESIGN.md`, `src/styles.css`, `src/styles/` | dark theme only |
| Pages/components | `src/pages/`, `src/components/` | `TaskGraph`/`TimelinePanel`/`TerminalLog` |
| Backend contracts | `../../src/dashboard/read-model.ts` | relative, no workspace |

## CONVENTIONS
- Tests colocated `*.test.ts(x)`; harness `store-test-harness.ts` (`FakeEventSource`).
- Dashboard Vitest: `vitest run --config dashboard/vite.config.ts --no-file-parallelism`.
- Import specifiers end `.js` for TS/TSX; only `App` is default export.
- Store is the only browser authority-state hub; pages do not keep a parallel copy.
- Feature CSS sits beside the feature; colors only via `styles.css` tokens.
- `index.html` `lang="ko"`; operator task errors Korean (`task-execution-message.ts`).
- Playwright is top-level `e2e/`, not this tree.

## ANTI-PATTERNS
- Do not invent a second API client; extend `src/api.ts` / `authority-api.ts`.
- UI events are not signed evidence (backend `receipt.ts` / control-plane).
- Cached/stale SSE data may render but never enables mutation.
- Raw API `message` must not render; use `SAFE_MESSAGES`.
- Raw colors only in root token declarations; body copy never below `--type-sm`; no motion.
- Memory: no query in URL/storage, no memory-derived links/HTML, no clipboard/download surface.
- Task-execution UI is delivery bookkeeping only; never evict an unresolved operation; HTTP 200 alone does not refresh authority state.
