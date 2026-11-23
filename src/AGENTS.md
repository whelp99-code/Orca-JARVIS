> ENGINEERING-MAP-START: 작업을 시작하면 `/home/jm/orca/engineering-vault/index.json`에서 이 디렉터리의 프로젝트 기록을 읽고 relations와 depends_on을 따라간다. 측정하지 않은 배포는 unknown이다. 이 문장은 기존 규칙을 바꾸지 않는다.

# src/ — backend authority library + CLI

Earned this file: score 15 (681 top-level `.ts`/`.mts`, `index.ts` barrel, >30 symbols, >10 exports, centrality). Distinct domain: flat NodeNext library. Nested exceptions: `dashboard/`, `integration/` (own files).

## OVERVIEW
Flat domain-heavy Node library. `index.ts` is a barrel, not a complete public surface (most modules are path-imported). Runtime entries: `cli.ts` (`jarvis` → `dist/src/cli.js`), `dashboard/main.ts`; extra processes `phone-gateway-main.ts`, `task-verifier-main.ts`, `phone-memory-client-mcp.ts`.

## WHERE TO LOOK
| Task | File | Notes |
|------|------|-------|
| SQLite + errors | `db.ts` | re-exports `AuthorityDb`/`JarvisError`; ~544 inbound. Class lives in `authority-worker-store.ts` (mixin chain). Lightweight error: `jarvis-error.ts` |
| Canonical JSON | `canonical.ts` | `canonicalize`; ~288 inbound |
| Approvals | `control-plane.ts` | `ControlPlane` stage/decide/claim/settle; crypto in `control-plane-contract.ts` |
| Receipts | `receipt.ts` | Ed25519; `RECEIPT_DOMAIN` / `POLICY_DOMAIN` / `VERIFICATION_DOMAIN` |
| Domain types | `types.ts`, `personal-contracts.ts` | type-only census; brand/envelope hub |
| Orca | `orca.ts`, `orca-env.ts`, `orca-resume.ts`, `adapters.ts` | `orca-resume.ts` is the only live terminal-send boundary |
| Pre-GJC | `pre-gjc.ts`, `pre-gjc-shadow.ts` | fixture + densest shadow class |
| GJC | `gjc.ts`, `service.ts` | MCP client (`shell: false`); `GjcRuntimeService` |
| Supervision | `live-supervisor.ts`, `progress.ts`, `progress-signal.ts` | observe-only facade |
| Workflow | `loopgraph.ts`, `runbook.ts`, `microloops.ts` | `DEFAULT_AGENTOPS_LOOP` |
| Memory | `memory-projection-authority.ts`, `memory-outbox.ts`, `second-brain-effect-v2.ts` | bind/suppress (~103 importers); outbox; V2 write contract (~62) |
| Second brain | `second-brain-transport.ts`, `second-brain-adapter.ts` | supervised MCP child; frozen schemas |
| Daily loop | `daily-loop.ts`, `daily-loop-time.ts` | facade; fixed KST offset, not Intl |
| Evolution | `budgeted-evolution-engine.ts`, `evolution-*.ts` | shadow only |
| Projections | `state-projection.ts`, `task-timeline.ts` | often wrapped by `recommendation-*` |
| CLI dispatch | `cli-runtime.mts` | `execute`; deployment/portfolio before any DB open |
| HTTP/API | `dashboard/` | own AGENTS.md |
| Core5 reads | `integration/` | own AGENTS.md; default off |

## CONVENTIONS
- New public surface must be re-exported from `index.ts`. Sibling imports use NodeNext `.js` (CLI `.mts` → `.mjs`). Do not import `./index.js` from inside `src/`.
- `src/dashboard/` is a nested domain; do not dump HTTP details here.
- Domain in filename (`memory-*`, `task-*`, `second-brain-*`), not nested packages. Facades (`task-spec.ts`, `memory-lifecycle-api.ts`, `orca-public-api.ts`) re-export split modules.
- Digests: `sha256:` + `canonicalize` + NUL-terminated domain (`orca-jarvis/.../v1\0`). Exact-key parsers; `JarvisError("SCREAMING_CODE")`. Injected clocks. SQLite `.transaction(…).immediate()`.
- Wire JSON: snake_case. `schema_version` is usually `1`. Measured exceptions: scoped-write and phone memory body `4`, `integration/` finance reads `2`. Do not treat undeclared refresh profiles as accepted.

## ANTI-PATTERNS
- `live-supervisor.ts` never sends or mutates terminals.
- `cli.ts` consume path never invokes the terminal adapter.
- Unstructured terminal output is never status; uncertain acks are never blind-replayed (`orca-resume.ts` persisted `sending` is terminal — no blind replay).
- Historical reconstruction (outbox observe, scoped settlement, control proofs) never renews write authority.
- Evolution is shadow-only. Retired collaboration actions stay `executable: false`.
