> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# src/dashboard/ — Node HTTP/API for the control center

Earned this file: score 13 (77 TS modules, no barrel, loopback HTTP domain). Distinct from parent `src/` and from the React app in `dashboard/`.

## OVERVIEW
Dashboard server. Entry `main.ts` builds `AuthorityDb` + `runtimeCapabilityProbe()` + `defaultRunner`, then `createDashboardServer()`.

## WHERE TO LOOK
| Task | File |
|------|------|
| Route composition | `server.ts` — loopback `BoundSocket`, GET+POST, then static/SPA |
| API fan-out | `api-routes.ts` → `tryHandle*` (authority/read/post/proposal/task/personal/memory/SSE) |
| Backend↔frontend contracts | `read-model.ts` (`DashboardReadModel`); types in `legacy-read-contracts.ts` / `contracts.ts` |
| Authority HTTP | `authority-routes.ts`, `authority-service.ts` (`decideDashboardRequest` / `executeDashboardRequest`) |
| Task execution | `task-execution-service.ts`, `task-execution-read.ts`, `task-routing-read.ts` |
| Memory | `memory-mutation-service.ts`, `memory-read-service.ts`, `memory-runtime.ts`, `memory-session-source.ts` |
| Personal | `personal-today.ts` (`todayProjection`), `personal-privacy.ts`, `personal-routes.ts` |
| Session/auth | `session.ts`, `phone-session.ts` (shared with phone gateway) |
| Portfolio | `portfolio-collector-main.ts` (separate process), `portfolio-collector.ts`, `portfolio-auth.ts`, `portfolio-spool.ts` |
| SSE | `events.ts` (`ReconcileHub`), `sse-route.ts`, `sse-bounded-sink.ts` |
| Boundary | `request-boundary.ts`, `validation.ts`, `redaction.ts`, `http.ts`, `terminal-reader.ts` |

## CONVENTIONS
- `read-model.ts` is imported by `dashboard/src` via `../../src/...` (no workspace package). Contract changes need both backend and dashboard Vitest.
- Playwright fixture server: `tests/fixtures/dashboard-http-server.ts`, not this tree.
- `portfolio-collector-main.ts` is a separate process; collector does not open authority DB (HMAC spool only).
- `server.ts` composes routes + SSE + sessions + static assets over one `AuthorityDb`. Bind host `127.0.0.1`; non-loopback → `LOCAL_SESSION_REQUIRED`.
- Mutations: CSRF `x-jarvis-csrf`, exact Origin match, `MAX_JSON_BODY_BYTES` 64KiB. JSON `schema_version: 1`, snake_case, exact-key parsers.
- SSE: max 128 clients; frame 16KiB / buffer 128KiB.

## ANTI-PATTERNS
- External UI is never an authority source (`docs/TASK_TIMELINE_KO.md`).
- Do not persist/accept receipts from dashboard request paths that skip control-plane verification.
- `terminal-reader.ts` is read-only log access, not a send/mutate adapter.
- Memory review responses never include private spool paths, credentials, or unbound text. Page cursors are never authorization.
- `memory-session-source.ts` takes agent identity from trusted gateway config, never a user-supplied project/session claim.
