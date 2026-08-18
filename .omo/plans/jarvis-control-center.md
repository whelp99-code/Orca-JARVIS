# Argo-informed JARVIS Control Center — executable plan

Status: READY
Tier: HEAVY
Upstream reference: argoproj/argo-workflows@de874c1254da8fe170ad7de9c82f11c626349847
Tracking goal: browser dashboard at http://127.0.0.1:4173/ with authority-safe controls and hidden Orca runtime.

I read this as plan-only architecture and execution design - I surveyed the repository, runtime, Argo source, authority seams, tests, GitHub state, and deployment host, and will return the decision-complete implementation plan without editing files.

# JARVIS Control Center implementation plan

No repository files were edited during this task.

## 1. Decision summary

- `CONFIRMED` Repository worktree: `/Volumes/DevSpace/orca/workspaces/Orca-JARVIS/feat-jarvis-argo-cli-jaw-integration`.
- `CONFIRMED` Current worktree is clean at `aec51c1`.
- `CONFIRMED` `origin/main` is `1291ae9`; its tree matches the current branch, but the current branch has already been merged by PR #5. Implementation must start from a new branch off `origin/main`.
- `CONFIRMED` Existing backend is strict TypeScript, Node `24.19.0`, npm `11.17.0`, SQLite WAL, with no frontend or HTTP/SSE layer.
- `CONFIRMED` Read authority is supplied by `buildCurrentState()` and `TaskTimeline`.
- `CONFIRMED` browser mutations must terminate at `ControlPlane` or `ApprovedCommandExecutor`; no dashboard module may issue SQL `INSERT`, `UPDATE`, or `DELETE`.
- `CONFIRMED` `http://127.0.0.1:4173/` currently refuses connections.
- `CONFIRMED` production DB has `quick_check=ok`, 29 migration journal rows, 15 live bindings, and zero workflow/control/task rows.
- `CONFIRMED` the production checkout has 4 modified and 18 untracked unrelated paths. Deployment must not switch, pull, reset, clean, build in, or otherwise alter that checkout.
- `CONFIRMED` existing daemon `com.jmpark.orca-jarvis` is running as PID `42901` from `/Volumes/DevSpace/Orca-JARVIS`.
- `CONFIRMED` baseline `npm run verify` exits 1: 34/35 test files and 187/188 tests pass; the fixed-time negative-evidence projection test calls an executor whose settlement clock still uses wall time.
- `CONFIRMED` Argo source surveyed at `argoproj/argo-workflows@de874c1254da8fe170ad7de9c82f11c626349847`.
- `ASSUMED` Plan tier: **L / HEAVY** — 15 MUST requirements, 58 estimated changed paths, no migration, highest risk R3. The supplied HEAVY ratchet remains in force.
- `ASSUMED` Specification state: **READY**. Questions: N/A — all product decisions use the conservative defaults below.

## 2. Architecture options

### Option A — separate local dashboard process, shared authority DB

```text
React SPA
  │ JSON + SSE, same-origin, local CSRF token
  ▼
JARVIS dashboard process bound only to 127.0.0.1:4173
  ├─ SELECT-only DashboardReadModel
  │    ├─ buildCurrentState
  │    ├─ TaskTimeline
  │    └─ live binding SELECTs
  ├─ OrcaReadonlyAdapter for bounded terminal reads
  ├─ ControlPlane for stage/decide
  └─ ApprovedCommandExecutor for effects
          │
          ▼
       authority SQLite in WAL mode

Existing com.jmpark.orca-jarvis daemon remains a separate process.
```

Trade-offs:

- Coupling: directly reuses repository classes and SQLite schema.
- Testability: server accepts injected DB, clock, capability probe, and Orca runner.
- Migration cost: zero schema migrations.
- Failure isolation: dashboard crashes do not stop supervisor/GJC work.
- Deployment: one additional LaunchAgent and release directory.
- Failure mode: two Node processes contend on SQLite; existing `busy_timeout=5000` and WAL bound the impact.

### Option B — host HTTP/SSE inside existing `service run`

Trade-offs:

- Coupling: HTTP lifecycle, supervisor loop, GJC reconciliation, static serving, and authority mutations share one process.
- Testability: requires driving an infinite service loop to test HTTP shutdown and failures.
- Migration cost: fewer deployment files.
- Failure mode: malformed HTTP traffic or frontend-serving errors can terminate the production supervisor.
- Rollback: requires restarting the existing daemon.

### Recommendation

`ASSUMED` **Choose Option A.**

It is the simplest design that preserves the authority boundary while isolating the operational daemon. A message bus, secondary store, Kubernetes API, GraphQL layer, Redux dependency, or reverse proxy would add failure modes without satisfying an unmet requirement.

## 3. Architecture decisions

### ADR-JCC-001 — separate local process

- Status: ACCEPTED.
- Context: existing service is an infinite supervisor/GJC process.
- Decision: create a separate Node HTTP process and LaunchAgent.
- Consequence: shared WAL DB, isolated process lifecycle.
- Rollback: unload only `com.jmpark.orca-jarvis-dashboard`.

### ADR-JCC-002 — invalidate and refetch, not event-state authority

- Status: ACCEPTED.
- Argo source basis:
  - `ui/src/shared/list-watch.ts`: list first, then reconcile watch events.
  - `ui/src/shared/retry-watch.ts`: close subscriptions on unmount and reconnect.
  - workflow list/detail components: list/detail and watch are separate concerns.
- Decision: SSE sends opaque revision and topic invalidations. The browser refetches canonical JSON instead of merging event payloads into authority state.
- Consequence: reconnects cannot invent or replay mutations.
- Rollback: disable SSE and leave explicit refresh controls.

### ADR-JCC-003 — adapt Argo presentation, reject Kubernetes mutation

- Status: ACCEPTED.
- Reused concepts: fixed app shell, routed list/detail views, graph/timeline/log composition, explicit empty/error states, list-plus-watch reconciliation.
- Rejected concepts: Kubernetes resource versions as authority, direct retry/resubmit/terminate APIs, namespace semantics, pod mutation, YAML submission.
- Attribution: ship `dashboard/public/NOTICE-ARGO.txt` and a footer link naming Argo Workflows and the surveyed revision.

### ADR-JCC-004 — no browser signing

- Status: ACCEPTED.
- Decision: browser accepts externally signed receipt JSON; it never receives or reads a private key.
- Consequence: approval and rejection dialogs paste an exact signed receipt.
- Rollback: make the UI read-only; CLI authority paths continue working.

### ADR-JCC-005 — anti-CSRF token plus signed effect authority

- Status: ACCEPTED.
- Decision:
  - bind only `127.0.0.1`;
  - reject non-loopback `Host`;
  - reject browser mutation origins other than the server origin;
  - issue a process-memory token from `GET /api/v1/session`;
  - require `Content-Type: application/json` and `X-JARVIS-CSRF` on every POST;
  - require signed receipts before decision/effect transitions.
- Consequence: the CSRF token protects the local browser surface; it does not replace signed authority.
- Rollback: stop the dashboard rather than weaken either check.

### ADR-JCC-006 — task creation is an approved workflow start

- Status: ACCEPTED.
- Decision: creating a task stages `workflow.start` through `ControlPlane`.
- `ApprovedCommandExecutor` will call `LoopGraph.ensureDefaults(now)` only for `agentops-default`, inside receipt-authorized workflow-start execution.
- Consequence: production currently has zero loop definitions but can still execute the first approved task.
- Rollback: require an independently approved `workflow.register` command.

### ADR-JCC-007 — conservative cancellation and retry

- Status: ACCEPTED.
- Cancel: stage `workflow.cancel`; do not expose direct `ControlPlane.cancel`.
- Retry: create a fresh request from an exact prior `failed` executable command.
- `uncertain`, `claimed`, `completed`, `rejected`, and `cancelled` requests are not retryable.
- Consequence: emergency revocation remains CLI/trusted-runtime only.
- Rollback: remove cancel/retry buttons without changing authority history.

### ADR-JCC-008 — immutable release deployment

- Status: ACCEPTED.
- Decision: build merged source in a temporary directory, publish under `.jarvis-runtime/control-center/releases/<merge-sha>`, and atomically move a `current` symlink.
- Consequence: production checkout dirt is untouched.
- Rollback: repoint the symlink and restart only the dashboard LaunchAgent.

## 4. Fixed assumptions

| ID | Fixed default | Basis | Impact | Rollback |
|---|---|---|---|---|
| A-001 | HTTP only on `127.0.0.1:4173` | Explicit target URL | No remote clients or TLS | Unload dashboard |
| A-002 | External authority supplies receipt JSON | Private signing key is absent from repository | Approval UI is paste-and-submit | Read-only UI |
| A-003 | Team proposals remain ephemeral | `planTeamProposal` is proposal-only | Proposal preview changes zero DB rows | Remove preview route |
| A-004 | Retry only `failed` executable requests | `uncertain` may hide an external effect | Prevents blind replay | Remove retry |
| A-005 | Positive mutation QA uses a disposable DB | Production has no safe reason for synthetic control rows | Production smoke remains read-only | Delete QA DB |
| A-006 | Custom frontend reducer/store, no Redux package | State requirements are small | Lower dependency and coupling | Introduce Redux only after demonstrated need |
| A-007 | No dashboard migration | Existing projections and control tables suffice | Extra migration journal rows remain tolerated | N/A |
| A-008 | Separate LaunchAgent label | Existing daemon must remain isolated | Two processes | Unload dashboard label |
| A-009 | One tracking issue, dependency-ordered PRs | No repository issue template exists | Traceability remains centralized | Close issue and preserve PR records |

## 5. Requirements and acceptance

### Atomic requirements

| Requirement | Contract |
|---|---|
| REQ-BASE-001 P0 MUST | Make the existing negative-evidence projection test use one injected mutable test clock. No production behavior changes. |
| REQ-SHELL-001 P0 MUST | Serve the React app and deep-link fallback from `127.0.0.1:4173`; reject non-loopback binding and invalid Host/Origin. |
| REQ-OVERVIEW-001 P0 MUST | Show title, live indicator, task/approval/risk/agent cards, recent task timeline, approvals, and risks. |
| REQ-TASKREAD-001 P0 MUST | List tasks and show one task’s sanitized context, timeline, graph, workers, and evidence. |
| REQ-AGENT-001 P0 MUST | List live bindings and show one stable agent identity and bounded terminal log view. |
| REQ-SSE-001 P0 MUST | Open SSE, publish initial snapshot, invalidate/refetch after API mutations and external SQLite changes, and reconnect safely. |
| REQ-PROP-001 P0 MUST | Preview `planTeamProposal` results without persistence. |
| REQ-TASKCREATE-001 P0 MUST | Recompute a ready proposal digest and stage one `workflow.start` request. |
| REQ-DECIDE-001 P0 MUST | Approve or reject a pending control request only with an applicable Ed25519 receipt. |
| REQ-EXEC-001 P0 MUST | Execute only an already-approved request through `ApprovedCommandExecutor`. |
| REQ-CANCEL-001 P0 MUST | Stage task cancellation as a fresh `workflow.cancel` request; execution still requires approval. |
| REQ-RETRY-001 P0 MUST | Stage a fresh request only from a prior `failed`, executable request. |
| REQ-SEC-001 P0 MUST | Missing/invalid CSRF or receipt changes no protected DB state; no raw secrets, signatures, session IDs, or private keys appear in normal read responses/log UI. |
| REQ-UX-001 P1 MUST | 1440×1000 and 1024×768 layouts, keyboard navigation, visible focus, semantic empty/error states, WCAG AA automated scan, zero browser console errors, Argo attribution. |
| REQ-DEPLOY-001 P0 MUST | Build merged source, back up production DB/plist, install immutable release and dashboard LaunchAgent, prove curl/browser production surfaces, preserve existing daemon and dirty checkout. |

### Given–When–Then acceptance

| Acceptance ID | Normal path | Failure path |
|---|---|---|
| JCC-AC-001 | Given fixed test time, when focused and full tests run, then the projection test passes deterministically. | Given wall time after receipt expiry, the test still uses injected time and does not depend on execution date. |
| JCC-AC-002 | Given built assets, when `/` or `/tasks/<encoded-id>` is requested, then HTML is returned and React routes render. | Given invalid Host, Origin, traversal path, or non-JSON POST, return 400/403/415 without DB change. |
| JCC-AC-003 | Given empty authority tables, when `/api/v1/overview` and `/` load, then cards show zero/empty states and existing agents remain visible. | Given read failure, UI displays a retryable error rather than stale success. |
| JCC-AC-004 | Given a seeded workflow, when list/detail routes load, then timeline and graph preserve event order and source IDs. | Given unknown task ID, API returns 404 `TASK_NOT_FOUND`; UI renders not-found state. |
| JCC-AC-005 | Given an exact live binding, when logs are requested, then at most 500 redacted lines are returned through `OrcaReadonlyAdapter`. | Given ambiguous/missing binding or Orca failure, return 404/502 and never call terminal send. |
| JCC-AC-006 | Given an SSE subscriber registered before mutation, when a request is staged, then one reconcile event is observed and canonical resources refetch. | Given disconnect, the UI becomes `reconnecting`; reconnect receives a snapshot and does not duplicate mutations. |
| JCC-AC-007 | Given valid proposal input, when previewed, then ready/blocked/needs-input output matches `planTeamProposal` and DB fingerprint is unchanged. | Given malformed or capability-blocked input, return 400 or typed blocked result without writes. |
| JCC-AC-008 | Given a ready proposal and matching digest, when Create task is submitted, then one pending `workflow.start` request is staged. | Given a stale digest or malformed budget, return 409/400 and stage zero requests. |
| JCC-AC-009 | Given a pending command and valid signed receipt, when decision is submitted, state becomes approved or rejected exactly once. | Missing receipt returns 403; invalid signature returns 403; request/receipt mismatch returns 409; all protected-table fingerprints remain unchanged. |
| JCC-AC-010 | Given an approved request, when execute is submitted, then one redemption and settled effect are recorded. | Given no approved receipt, return 403 and leave redemptions, effects, workflow tables, and request state unchanged. |
| JCC-AC-011 | Given an active workflow, when Cancel is selected, then a pending `workflow.cancel` request appears; approved execution cancels the workflow. | Given terminal workflow or mismatched run/task, return 409 and stage zero requests. |
| JCC-AC-012 | Given a failed executable command, when Retry is selected, then a fresh pending command copies exact action/target/args with a new request ID and nonce. | Given `uncertain` or non-executable source, return 409 `RETRY_NOT_ALLOWED` and stage zero requests. |
| JCC-AC-013 | Given token/secret/private-key-shaped content, when read APIs/logs render, then sensitive values or entire lines become `[REDACTED]`. | Given missing/invalid local token or receipt, return safe error JSON with no stack and no DB mutation. |
| JCC-AC-014 | Given both required viewports, when keyboard and axe QA run, then all controls are reachable, focus is visible, contrast scan has zero serious/critical violations, and console errors equal zero. | Given API/SSE failure, connection and retry UI remain keyboard-operable. |
| JCC-AC-015 | Given merged commit and valid backup, when dashboard LaunchAgent starts, then health/overview/SSE and production browser smoke pass at 4173. | Given deployment failure, unload dashboard, restore prior plist/symlink, and leave `com.jmpark.orca-jarvis` running. |

## 6. API contracts

All JSON responses include `schema_version: 1`. All errors use:

```ts
{
  schema_version: 1;
  error: {
    code: string;
    message: string;       // safe fixed vocabulary
    request_id: string;
  };
}
```

Every response includes `X-Request-Id`.

### Read API

| Method/path | Success | Errors |
|---|---|---|
| `GET /api/v1/health` | `200 {status:"ok", authority:"ready", generated_at}` | `503 AUTHORITY_NOT_READY` |
| `GET /api/v1/session` | `200 {csrf_token}` with `Cache-Control: no-store` | 500 |
| `GET /api/v1/overview` | `200 {cards, recent_tasks, pending_approvals, risks, agents}` | 500 |
| `GET /api/v1/tasks?limit=1..500` | `200 {items: TaskTimelineSummary[]}` | 400 |
| `GET /api/v1/tasks/:taskId` | `200 {context}`; sanitized; max 500 events/512 KiB | 400, 404 |
| `GET /api/v1/agents` | `200 {items: AgentSummary[]}` | 500 |
| `GET /api/v1/agents/:agentId` | `200 {agent}` | 404 |
| `GET /api/v1/agents/:agentId/logs?limit=1..500` | `200 {agent_id,status,lines,truncated,next_cursor}` | 400, 404, 502 |
| `GET /api/v1/control/requests` | sanitized control requests ordered by `requested_at,request_id` | 500 |

`agent_id` is `sha256:` over canonical `{canonical_path, provider, terminal_id, incarnation_id}`. It is opaque and stable for that binding incarnation.

### SSE

`GET /api/v1/events`

Headers:

```text
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

Initial event:

```text
id: <instance-uuid>:<sequence>
event: snapshot
data: {"schema_version":1,"type":"snapshot","revision":"<opaque>","topics":["overview","tasks","agents","approvals"],"occurred_at":"..."}
```

Change event:

```text
id: <instance-uuid>:<sequence>
event: reconcile
data: {"schema_version":1,"type":"reconcile","revision":"<opaque>","topics":["overview","tasks","task:<id>","agents","approvals"],"occurred_at":"..."}
```

- API mutations publish immediately after successful completion.
- A 1-second production `PRAGMA data_version` observer detects writes from the existing daemon.
- Tests inject or call exact reconciliation; they do not wait for the interval.
- Heartbeat is an SSE comment every 15 seconds.
- Event IDs are opaque and process-local, not authority versions.
- No event carries mutation instructions or raw receipt data.

### Mutation API

All POST routes require:

```text
Content-Type: application/json
X-JARVIS-CSRF: <GET /api/v1/session token>
Origin absent (CLI) or exactly the current http://127.0.0.1:<port> origin
Body <= 64 KiB
```

#### Proposal preview

`POST /api/v1/proposals/preview`

Body: exact `TeamProposalRequestV1`.

Success: `200 {proposal: TeamProposalResultV1}`.

Side effects: none. Assert `total_changes()` and authority fingerprint unchanged.

#### Create task request

`POST /api/v1/tasks`

```ts
interface CreateTaskRequest {
  schema_version: 1;
  request_id: string; // NFC, 1..128 bytes
  nonce: string;      // NFC, 1..128 bytes
  task_id: string;
  run_id: string;
  expected_proposal_digest: `sha256:${string}`;
  proposal_request: TeamProposalRequestV1;
  budget: {
    max_steps: number;              // 1..100
    max_attempts_per_node: number;  // 1..10
    deadline: string;               // RFC3339 millis, now < deadline <= now+24h
  };
}
```

Server recomputes capability matrix and proposal. A matching ready proposal stages:

```ts
{
  action: "workflow.start";
  action_level: 2;
  target: {
    environment: "local";
    run_id;
    loop_id: "agentops-default";
    correlation_id: task_id;
    task_id;
  };
  args: {
    run_id;
    loop_id: "agentops-default";
    correlation_id: task_id;
    input: {
      task_id;
      objective;
      proposal_digest;
      members;
    };
    budget;
  };
  reversible: true;
  requested_by: "jarvis-control-center";
}
```

Success: `202 {request: StoredControlCommand}`.

#### Decide

`POST /api/v1/control/requests/:requestId/decision`

Body:

```ts
{schema_version: 1; receipt: CommandApprovalReceipt}
```

- URL request ID, receipt request ID, command digest, trusted key, principal, times, signature, and decision must match.
- Success: `200 {request_id, decision, state:"approved"|"rejected"}`.
- Missing receipt: 403 `AUTHORITY_RECEIPT_REQUIRED`.
- Invalid receipt: 403 `CONTROL_APPROVAL_INVALID`.
- Not applicable/replay mismatch: 409.

#### Execute

`POST /api/v1/control/requests/:requestId/execute`

Body: `{schema_version:1}`.

Calls only:

```ts
ApprovedCommandExecutor.execute(requestId, "dashboard-approved-executor", now)
```

Success: `200 {execution: ApprovedExecutionResult}`. A settled `failed` result remains HTTP 200 and is rendered as a failed execution; thrown authority/state errors map to 403/409.

#### Cancel task

`POST /api/v1/tasks/:taskId/cancel`

```ts
{
  schema_version: 1;
  request_id: string;
  nonce: string;
  run_id: string;
  reason: string; // NFC, 1..512 bytes
}
```

Stages `workflow.cancel`, level 3. It does not call `LoopGraph.cancel` directly.

#### Retry failed request

`POST /api/v1/control/requests/:sourceRequestId/retry`

```ts
{
  schema_version: 1;
  request_id: string;
  nonce: string;
}
```

Copies exact action level, target, args, and reversible flag from the failed source; fixes `requested_by`, `requested_at`, and a 15-minute request expiry.

### Error mapping

| HTTP | Codes |
|---:|---|
| 400 | `JSON_INVALID`, `VALIDATION_ERROR`, `CONTROL_COMMAND_INVALID`, `TEAM_PROPOSAL_INPUT_INVALID` |
| 403 | `LOCAL_SESSION_REQUIRED`, `AUTHORITY_RECEIPT_REQUIRED`, `CONTROL_APPROVAL_INVALID`, `CONTROL_APPROVAL_REQUIRED` |
| 404 | `NOT_FOUND`, `TASK_NOT_FOUND`, `AGENT_NOT_FOUND` |
| 409 | `PROPOSAL_STALE`, `CONTROL_STATE_CONFLICT`, `RETRY_NOT_ALLOWED`, replay conflicts |
| 413 | `BODY_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 502 | `ORCA_UNAVAILABLE` |
| 500 | `INTERNAL_ERROR` |

No stack, SQL text, file contents, private keys, CSRF token, or receipt payload is logged.

## 7. Data, state, and security contracts

### Data

`ASSUMED` New tables/migrations: **N/A — no schema is required.**

Read queries may access existing tables. Dashboard source is forbidden from raw SQL mutation.

### State transitions

```text
proposal input ──preview──> transient needs_input | blocked | ready
ready proposal ──ControlPlane.stage(workflow.start)──> pending
pending ──valid approve receipt──> approved
pending ──valid reject receipt──> rejected
approved ──ApprovedCommandExecutor.claim──> claimed
claimed ──settle──> completed | failed | uncertain

active workflow ──stage workflow.cancel──> pending cancellation command
failed executable request ──stage exact copy──> new pending request
uncertain request ──retry──> REJECTED
```

Undefined transitions return 409.

### Redaction

`redactDashboardValue(value)` recursively:

- replaces values under case-insensitive keys matching `token|secret|password|authorization|cookie|signature|private_key|receipt_json|session_id`;
- replaces entire terminal lines containing bearer/basic credentials, known token prefixes, cloud key IDs, assignment-shaped credentials, cookies, or PEM private-key markers;
- preserves safe IDs, digests, states, action names, evidence references, and timestamps;
- bounds traversal depth and output bytes;
- never interprets terminal prose as state.

### Read-only proof

`DashboardReadModel` wraps operations with `SELECT total_changes()` before and after. Any difference throws `DASHBOARD_READ_MUTATED`.

A repository test scans `src/dashboard/**/*.ts` and fails if direct SQL mutation verbs appear outside test fixtures.

## 8. Frontend contract

### Routes

| Route | Screen |
|---|---|
| `/` | Dashboard overview, cards, recent timeline, approvals, risks |
| `/tasks` | Task list |
| `/tasks/:taskId` | Task detail with Summary, Timeline, Graph, Agents, Logs, Controls tabs |
| `/agents` | Agent binding list |
| `/agents/:agentId` | Agent detail and terminal logs |
| `/approvals` | Pending/approved/rejected control requests and receipt dialog |
| `/proposals/new` | Proposal interview, preview, task staging |
| `*` | Not-found screen |

### Components

- `AppShell`: fixed left navigation, top title, SSE state, skip link, attribution footer.
- `DashboardPage`: status cards, timeline, approvals, risks.
- `TaskListPage`: status filters and accessible table/card fallback.
- `TaskDetailPage`: tab state in query string.
- `AgentsPage`: binding list/detail.
- `ProposalPage` and `TaskCreateForm`.
- `ApprovalsPage`, `ReceiptDialog`, `CommandControls`.
- `TaskGraph`: sanitized workflow nodes/edges as SVG plus equivalent ordered list.
- `Timeline`: chronological event list.
- `TerminalLog`: terminal selector, line count, manual refresh, `<pre>`.
- `StatePanel`: INITIAL, LOADING, SUCCESS, EMPTY, RETRYING, OFFLINE, FORBIDDEN, NOT_FOUND, SERVER_ERROR.
- `StatusCard`: text plus icon; never color-only.

### State

```ts
type ResourceState<T> =
  | {status: "idle" | "loading" | "retrying"}
  | {status: "success"; data: T}
  | {status: "empty"; data: T}
  | {status: "error"; kind: "offline" | "forbidden" | "not_found" | "server"; error: ApiError};

interface DashboardStore {
  getSnapshot(): DashboardState;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
  refreshOverview(): Promise<void>;
  refreshTasks(): Promise<void>;
  refreshTask(taskId: string): Promise<void>;
  refreshAgents(): Promise<void>;
  refreshApprovals(): Promise<void>;
}
```

Startup order:

1. Fetch local session token.
2. Open SSE and receive snapshot.
3. Fetch overview/tasks/agents/approvals.
4. On reconcile, refetch named topics.
5. On SSE error, retain last canonical data but mark connection `reconnecting`.
6. Close EventSource on unmount.

No authority state is persisted to localStorage.

## 9. Exact file plan

### MODIFY

```text
.github/workflows/ci.yml
eslint.config.js
package.json
package-lock.json
tsconfig.json
src/approved-executor.ts
tests/integration/approved-executor.test.ts
tests/integration/negative-evidence.test.ts
tests/integration/repository-hygiene.test.ts
```

### CREATE — backend

```text
src/dashboard/contracts.ts
src/dashboard/validation.ts
src/dashboard/redaction.ts
src/dashboard/read-model.ts
src/dashboard/http.ts
src/dashboard/server.ts
src/dashboard/events.ts
src/dashboard/read-routes.ts
src/dashboard/terminal-reader.ts
src/dashboard/command-service.ts
src/dashboard/control-routes.ts
```

### CREATE — frontend

```text
tsconfig.dashboard.json
dashboard/vite.config.ts
dashboard/index.html
dashboard/public/NOTICE-ARGO.txt
dashboard/src/main.tsx
dashboard/src/app.tsx
dashboard/src/api.ts
dashboard/src/store.ts
dashboard/src/styles.css
dashboard/src/pages/dashboard-page.tsx
dashboard/src/pages/task-list-page.tsx
dashboard/src/pages/agents-page.tsx
dashboard/src/pages/proposal-page.tsx
dashboard/src/pages/approvals-page.tsx
dashboard/src/components/app-shell.tsx
dashboard/src/components/status-card.tsx
dashboard/src/components/state-panel.tsx
dashboard/src/components/task-create-form.tsx
dashboard/src/components/task-graph.tsx
dashboard/src/components/timeline.tsx
dashboard/src/components/terminal-log.tsx
dashboard/src/components/receipt-dialog.tsx
dashboard/src/components/command-controls.tsx
```

### CREATE — tests and deployment

```text
tests/unit/dashboard-validation.test.ts
tests/unit/dashboard-redaction.test.ts
tests/unit/dashboard-read-model.test.ts
tests/integration/dashboard-api.test.ts
tests/integration/dashboard-sse.test.ts
tests/integration/dashboard-terminal.test.ts
tests/integration/dashboard-authority.test.ts
tests/integration/dashboard-controls.test.ts
dashboard/src/app.test.tsx
dashboard/src/proposal-page.test.tsx
dashboard/src/controls.test.tsx
dashboard/src/task-graph.test.ts
playwright.config.ts
e2e/control-center.spec.ts
e2e/production-smoke.spec.ts
tests/fixtures/dashboard-http-server.ts
tests/fixtures/dashboard-sign-receipt.ts
deploy/com.jmpark.orca-jarvis-dashboard.plist
```

### FORBIDDEN

```text
migrations/**
src/control-plane.ts
src/task-timeline.ts
src/state-projection.ts
src/db.ts
/Volumes/DevSpace/Orca-JARVIS/**   # except ignored release/backup runtime paths during deployment
~/Library/LaunchAgents/com.jmpark.orca-jarvis.plist
production control/task rows during release QA
```

## 10. Dependency versions

Install exact versions:

```bash
npm install --save-exact \
  react@19.2.8 react-dom@19.2.8 react-router-dom@7.18.2

npm install --save-dev --save-exact \
  @types/react@19.2.18 @types/react-dom@19.2.4 \
  vite@8.2.1 @vitejs/plugin-react@6.0.5 \
  @testing-library/react@16.3.2 \
  @testing-library/user-event@14.6.5 \
  @testing-library/jest-dom@7.0.1 \
  jsdom@30.0.1 \
  @playwright/test@1.62.1 \
  @axe-core/playwright@4.13.0
```

Final scripts:

```json
{
  "build:backend": "tsc && node scripts/copy-migrations.mjs",
  "build:dashboard": "vite build --config dashboard/vite.config.ts",
  "build": "npm run build:backend && npm run build:dashboard",
  "typecheck": "tsc --noEmit && tsc -p tsconfig.dashboard.json --noEmit",
  "lint": "eslint src tests dashboard e2e playwright.config.ts --max-warnings=0",
  "test": "vitest run --no-file-parallelism",
  "test:e2e": "playwright test",
  "verify": "npm run runtime:check && npm run lint && npm run typecheck && npm test && npm run acceptance:pre-gjc -- --fixture test/fixtures/pre-gjc-e2e.json --clock 2026-08-09T00:00:00.000Z && npm run build && node scripts/cli-smoke.mjs && npm run test:e2e"
}
```

CI installs Chromium before `npm run verify`:

```yaml
- run: npx playwright install --with-deps chromium
```

## 11. RED → GREEN and real-surface evidence

Evidence root:

```bash
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
EVIDENCE="artifacts/control-center/$RUN_ID"
mkdir -p "$EVIDENCE"/{red,green,curl,browser,deploy}
```

| Acceptance | Upfront RED | GREEN command | Real artifact |
|---|---|---|---|
| AC-001 | Observed `npm run verify`, exit 1, 1 failed test | `npx vitest run tests/integration/negative-evidence.test.ts --no-file-parallelism` | focused transcript |
| AC-002/003 | `curl http://127.0.0.1:4173/`, exit 7 | focused dashboard API/app tests | root HTML, overview JSON, screenshot |
| AC-004 | GET task API test expects 200 but receives 404/missing module | `npx vitest run tests/integration/dashboard-api.test.ts` | task list/detail JSON and screenshot |
| AC-005 | terminal API test receives 404 | `npx vitest run tests/integration/dashboard-terminal.test.ts` | redacted log JSON and browser log screenshot |
| AC-006 | SSE test receives 404 | `npx vitest run tests/integration/dashboard-sse.test.ts` | SSE transcript containing snapshot/reconcile |
| AC-007 | proposal endpoint test receives 404 | `npx vitest run tests/unit/dashboard-read-model.test.ts dashboard/src/proposal-page.test.tsx` | before/after DB fingerprint and browser proposal |
| AC-008 | task create endpoint receives 404 | `npx vitest run tests/integration/dashboard-authority.test.ts` | pending command JSON |
| AC-009/010 | missing/invalid receipt tests initially lack route | same authority test | HTTP 403 transcripts plus identical before/after fingerprints |
| AC-011/012 | cancel/retry controls absent | `npx vitest run tests/integration/dashboard-controls.test.ts dashboard/src/controls.test.tsx` | browser action log and DB state transcript |
| AC-013 | redaction unit tests fail missing module | `npx vitest run tests/unit/dashboard-redaction.test.ts` | credential-shaped fixture absent from output |
| AC-014 | Playwright against absent 4173 fails | `npx playwright test e2e/control-center.spec.ts` | four screenshots, axe JSON, console JSON |
| AC-015 | production curl exit 7 | production curl and `e2e/production-smoke.spec.ts` | LaunchAgent print, curl transcripts, production screenshots |

Async tests must subscribe to the exact SSE event or HTTP response before triggering the action. No fixed sleep is permitted.

### Protected-state fingerprint

Before and after each missing/invalid receipt request, capture:

```sql
SELECT state,lease_fence,completed_at,failure_code
FROM control_command_requests WHERE request_id=?;

SELECT
  (SELECT COUNT(*) FROM control_command_receipts) AS receipts,
  (SELECT COUNT(*) FROM control_command_redemptions) AS redemptions,
  (SELECT COUNT(*) FROM control_command_effects) AS effects,
  (SELECT COUNT(*) FROM control_command_revocations) AS revocations,
  (SELECT COUNT(*) FROM workflow_runs) AS runs,
  (SELECT COUNT(*) FROM workflow_steps) AS steps,
  (SELECT COUNT(*) FROM workflow_transitions) AS transitions;
```

The two serialized records must be byte-identical.

## 12. PR and commit graph

```text
PR-000 baseline clock
  └─ PR-001 contracts/toolchain
       └─ PR-002 overview walking skeleton
            └─ PR-003 tasks/agents/SSE
                 └─ PR-004 proposal/task staging
                      └─ PR-005 decide/execute/cancel/retry
                           └─ PR-006 graph/log/UX hardening
                                └─ PR-007 browser/release
```

### PR-000 — deterministic baseline

- Risk: R2; execution: SEQUENTIAL.
- MODIFY: `tests/integration/negative-evidence.test.ts`.
- STEP:
  1. Add mutable `executionTime`.
  2. Construct executor with `clock: () => executionTime`.
  3. Set `executionTime = at` before each execute.
- RED: already observed.
- GREEN: focused test, then `npm run verify`.
- Commit: `test: bind negative evidence projection clock`.
- Change budget: 1 modified file, 0 new.

### PR-001 — contracts and toolchain

- Risk: R2; execution: SEQUENTIAL.
- CREATE: contracts, validation, redaction, two unit tests, dashboard tsconfig/Vite config.
- MODIFY: package manifests.
- Contract symbols:
  - `parseCreateTaskRequest(value: unknown): CreateTaskRequest`
  - `parseReceiptDecision(value: unknown): ReceiptDecisionRequest`
  - `redactDashboardValue(value: unknown): unknown`
  - `redactTerminalLine(line: string): string`
- GREEN: two unit tests, lint, typecheck.
- Commit: `build: add dashboard contracts and toolchain`.
- Change budget: 2 modified, 7 new.

### PR-002 — overview walking skeleton

- Risk: R2; execution: SEQUENTIAL.
- CREATE: read model, HTTP primitives, executable server, minimal SPA files, API integration test.
- Contract:
  - `createDashboardServer(options): DashboardServer`
  - `DashboardReadModel.overview(now): Promise<OverviewResponse>`
  - `listen({host:"127.0.0.1",port})`
  - signal handlers close server and DB.
- GREEN: dashboard API test, app test, build, real curl on random test port.
- Commit: `feat: add control center overview skeleton`.
- Change budget: 2 modified, 8 new.

### PR-003 — task/agent reads and SSE

- Risk: R3; execution: PARALLEL_SAFE inside PR.
- Backend lane: events, read routes, terminal reader, SSE/terminal tests.
- Frontend lane: API client, store, task and agent pages.
- Contracts:
  - `DashboardReadModel.tasks(limit)`
  - `DashboardReadModel.task(taskId)`
  - `DashboardReadModel.agents()`
  - `DashboardReadModel.agent(agentId)`
  - `DashboardTerminalReader.read(agentId, limit)`
  - `ReconcileHub.publish(topics)`
- GREEN: API, SSE, terminal, store tests; browser task/agent views.
- Commit: `feat: stream task and agent read models`.
- Change budget: 6 modified, 8 new.

### PR-004 — proposal and task staging

- Risk: R3; execution: SEQUENTIAL.
- CREATE: command service/control route, proposal page/form, authority/read-model tests.
- MODIFY: `src/approved-executor.ts` and its test for approved default-loop initialization.
- Contract:
  - `previewProposal(input)`
  - `createTask(input)`
  - all persistence calls `ControlPlane.stage`.
- GREEN: authority tests prove preview no writes and task execution requires receipt.
- Commit: `feat: stage proposed tasks through control receipts`.
- Change budget: 8 modified, 7 new.

### PR-005 — authority controls

- Risk: R3; execution: SEQUENTIAL.
- CREATE: approvals page, receipt dialog, controls, integration/component tests.
- Contract:
  - `decide(requestId, receipt)`
  - `execute(requestId)`
  - `stageCancel(taskId, input)`
  - `stageRetry(sourceRequestId, input)`
- Negative proofs: missing/invalid receipts and unchanged fingerprint.
- Commit: `feat: add receipt-bound command controls`.
- Change budget: 7 modified, 5 new.

### PR-006 — Argo-informed graph/log/UX

- Risk: R2; execution: PARALLEL_SAFE inside PR.
- CREATE: shell, overview, status/error panels, graph, timeline, terminal log, graph test.
- Acceptance: both viewports, keyboard focus, empty/error states, no direct Argo code copy.
- Commit: `feat: finish Argo-informed operational views`.
- Change budget: 5 modified, 8 new.

### PR-007 — browser, CI, and release definition

- Risk: R3; execution: SEQUENTIAL.
- CREATE: Playwright config/specs, disposable fixture server/signer, NOTICE, plist, app test.
- MODIFY: package scripts, CI, hygiene test.
- Commits:
  1. `test: prove control center browser workflows`
  2. `chore: add dashboard LaunchAgent release definition`
- GREEN: `npm run verify`.
- Change budget: 4 modified, 8 new.

Each PR must:

```bash
git diff --check
npm run lint
npm run typecheck
npm test
npm run build
```

PR-007 additionally runs `npm run verify`.

## 13. Parallel delegation topology

For a PR with parallel lanes:

```bash
git worktree add /tmp/jcc-<pr>-backend -b lane/jcc-<pr>-backend <pr-base-sha>
git worktree add /tmp/jcc-<pr>-frontend -b lane/jcc-<pr>-frontend <pr-base-sha>
```

- Backend lane owns only `src/dashboard/**` and `tests/{unit,integration}/dashboard-*.test.ts`.
- Frontend lane owns only `dashboard/src/**`.
- Integration lead owns package files, server route registration, CI, and cherry-picks.
- No lane modifies `src/control-plane.ts`, migrations, or production paths.
- Each lane runs focused RED, implements GREEN, commits one atomic diff, and reports command output.
- Integrator cherry-picks backend then frontend, resolves only imports/registration, and runs the PR gate.
- Remove temporary worktrees only after the integrated PR is pushed.

## 14. GitHub Issue structure

Create one issue before PR-000:

```text
Title: [JCC] Argo-informed JARVIS Control Center

Sections:
1. Context and authority invariants
2. ADR summary and Argo source revision
3. Acceptance checklist JCC-AC-001..015
4. Dependency graph PR-000..007
5. RED evidence table
6. GREEN evidence table
7. Real curl/browser evidence links
8. Security fingerprint results
9. Deployment backup/release/rollback
10. Final merge SHA and production proof
```

Execution:

```bash
gh issue create \
  --repo whelp99-code/Orca-JARVIS \
  --title '[JCC] Argo-informed JARVIS Control Center' \
  --body-file "$EVIDENCE/issue-body.md"
```

Each PR body includes:

```text
Refs #<issue>
Requirements: <REQ IDs>
Acceptance: <JCC-AC IDs>
RED evidence: <issue comment URL>
GREEN evidence: <issue comment URL>
Real surface: <artifact paths>
```

Use merge commits to preserve atomic commits:

```bash
gh pr checks <number> --watch --fail-fast
gh pr merge <number> --merge --delete-branch
```

## 15. Real curl and browser QA

### Disposable QA surface

Start the compiled test fixture on 4174:

```bash
node dist/tests/fixtures/dashboard-http-server.js \
  --host 127.0.0.1 \
  --port 4174 \
  --metadata "$EVIDENCE/qa-fixture.json" \
  >"$EVIDENCE/curl/qa-server.out" \
  2>"$EVIDENCE/curl/qa-server.err" &
QA_PID=$!
```

Read surface:

```bash
curl -fsS -D "$EVIDENCE/curl/health.headers" \
  http://127.0.0.1:4174/api/v1/health \
  | tee "$EVIDENCE/curl/health.json"

curl -fsS http://127.0.0.1:4174/api/v1/overview \
  | tee "$EVIDENCE/curl/overview.json"

curl -N --max-time 3 http://127.0.0.1:4174/api/v1/events \
  >"$EVIDENCE/curl/events.txt"
test $? -eq 28
grep -q 'event: snapshot' "$EVIDENCE/curl/events.txt"
```

Get CSRF without logging it:

```bash
CSRF="$(curl -fsS http://127.0.0.1:4174/api/v1/session \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).csrf_token))')"
```

Missing receipt:

```bash
curl -sS -o "$EVIDENCE/curl/missing-receipt.json" -w '%{http_code}\n' \
  -H 'Content-Type: application/json' \
  -H "X-JARVIS-CSRF: $CSRF" \
  -d '{"schema_version":1}' \
  http://127.0.0.1:4174/api/v1/control/requests/qa-pending/decision
# Expected: 403 and unchanged fingerprint
```

Invalid receipt and execute-without-approval use the same before/after SQL fingerprint. Positive approve/reject/cancel/retry receipts are generated only by `dist/tests/fixtures/dashboard-sign-receipt.js` against the disposable fixture key.

### Browser QA

```bash
npx playwright test e2e/control-center.spec.ts \
  --project=chromium-1440

npx playwright test e2e/control-center.spec.ts \
  --project=chromium-1024
```

Assertions:

- title and H1 `JARVIS Control Center`;
- live indicator;
- cards, timeline, approvals, risks;
- empty DB state;
- Korean fixture objective renders without clipping;
- proposal preview changes zero DB rows;
- task stage, receipt approval, execute, cancellation, rejection, retry;
- invalid receipt visible error and no DB change;
- logs contain `[REDACTED]` and no fixture secret;
- axe serious/critical count zero;
- browser console/page errors zero.

No `waitForTimeout`, fixed sleeps, or polling loops.

## 16. Deployment and rollback

### Preflight and backup

Do not touch the production checkout’s tracked or untracked files.

```bash
DB=/Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime/jarvis.sqlite
RUNTIME=/Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP="$RUNTIME/backups/pre-jcc-$STAMP.sqlite"

sqlite3 -readonly "$DB" 'PRAGMA quick_check;'
sqlite3 "$DB" ".timeout 5000" ".backup '$BACKUP'"
sqlite3 -readonly "$BACKUP" 'PRAGMA quick_check; SELECT COUNT(*) FROM schema_migrations;'
shasum -a 256 "$BACKUP" | tee "$BACKUP.sha256"

launchctl print "gui/$(id -u)/com.jmpark.orca-jarvis" \
  >"$EVIDENCE/deploy/existing-daemon-before.txt"

cp -p "$HOME/Library/LaunchAgents/com.jmpark.orca-jarvis-dashboard.plist" \
  "$RUNTIME/backups/com.jmpark.orca-jarvis-dashboard.$STAMP.plist" 2>/dev/null || true
```

### Build merged source outside production checkout

```bash
git fetch origin main
MERGE_SHA="$(git rev-parse origin/main)"
ROOT="$RUNTIME/control-center"
STAGE="$(mktemp -d "$ROOT/.stage.XXXXXX")"

mkdir -p "$STAGE/source"
git archive "$MERGE_SHA" | tar -x -C "$STAGE/source"

(
  cd "$STAGE/source"
  npm ci
  npx playwright install chromium
  npm run verify
)

mkdir -p "$STAGE/release"
cp "$STAGE/source/package.json" "$STAGE/source/package-lock.json" "$STAGE/release/"
cp -R "$STAGE/source/dist" "$STAGE/release/"
(
  cd "$STAGE/release"
  npm ci --omit=dev
)

mkdir -p "$ROOT/releases"
mv "$STAGE/release" "$ROOT/releases/$MERGE_SHA"
```

Atomically publish `current` with `fs.renameSync`, not by editing production source:

```bash
ROOT="$ROOT" MERGE_SHA="$MERGE_SHA" node --input-type=module <<'NODE'
import {renameSync, rmSync, symlinkSync} from "node:fs";
import {join} from "node:path";
const root = process.env.ROOT;
const sha = process.env.MERGE_SHA;
const temporary = join(root, `.current-${sha}`);
rmSync(temporary, {force: true});
symlinkSync(join("releases", sha), temporary);
renameSync(temporary, join(root, "current"));
NODE
```

### LaunchAgent

`deploy/com.jmpark.orca-jarvis-dashboard.plist` uses:

```text
Label: com.jmpark.orca-jarvis-dashboard
Program:
  /Users/jmpark/.nvm/versions/node/v24.19.0/bin/node
  /Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime/control-center/current/dist/src/dashboard/server.js
  --db /Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime/jarvis.sqlite
  --host 127.0.0.1
  --port 4173
  --static-root /Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime/control-center/current/dist/control-center
WorkingDirectory: /Volumes/DevSpace/Orca-JARVIS
stdout: .jarvis-runtime/dashboard.out.log
stderr: .jarvis-runtime/dashboard.err.log
RunAtLoad: true
KeepAlive: true
ThrottleInterval: 10
```

Install from the merged source copy because launchd bootstrap from the external-volume plist is known to return I/O error 5:

```bash
install -m 600 \
  "$STAGE/source/deploy/com.jmpark.orca-jarvis-dashboard.plist" \
  "$HOME/Library/LaunchAgents/com.jmpark.orca-jarvis-dashboard.plist"

plutil -lint "$HOME/Library/LaunchAgents/com.jmpark.orca-jarvis-dashboard.plist"

launchctl bootout "gui/$(id -u)/com.jmpark.orca-jarvis-dashboard" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.jmpark.orca-jarvis-dashboard.plist"
launchctl kickstart -k "gui/$(id -u)/com.jmpark.orca-jarvis-dashboard"
```

### Production proof

```bash
launchctl print "gui/$(id -u)/com.jmpark.orca-jarvis-dashboard" \
  | tee "$EVIDENCE/deploy/dashboard-launchctl.txt"

curl -fsS http://127.0.0.1:4173/api/v1/health \
  | tee "$EVIDENCE/deploy/health.json"

curl -fsS http://127.0.0.1:4173/api/v1/overview \
  | tee "$EVIDENCE/deploy/overview.json"

JARVIS_DASHBOARD_URL=http://127.0.0.1:4173 \
  npx playwright test e2e/production-smoke.spec.ts \
  --project=chromium-1440
```

Production smoke performs only GET/SSE operations.

Recheck the original daemon label/PID state and verify the production checkout’s porcelain output is byte-identical to its preflight capture.

### Rollback

If health, SSE, browser, or launchd checks fail:

```bash
launchctl bootout "gui/$(id -u)/com.jmpark.orca-jarvis-dashboard" || true
```

Then:

1. Restore the prior dashboard plist backup if one existed.
2. Atomically repoint `control-center/current` to the captured prior release.
3. Bootstrap only `com.jmpark.orca-jarvis-dashboard`.
4. Do not restart `com.jmpark.orca-jarvis`.
5. Do not restore the DB merely for a dashboard startup failure.
6. Restore `pre-jcc-*.sqlite` only after stopping both JARVIS processes and only if a proven authority-data corruption occurred.

## 17. Risks

| ID | Risk | P | I | D | Score | Level | Prevention | Recovery |
|---|---|---:|---:|---:|---:|---|---|
| R-001 | Browser authority bypass | 3 | 5 | 4 | 60 | R3 | local bind, CSRF, exact receipts, seam-only mutations | unload dashboard |
| R-002 | Terminal secret leakage | 3 | 5 | 4 | 60 | R3 | bounded reads, key/line redaction, no raw context | disable logs route |
| R-003 | Dirty production checkout overwritten | 3 | 5 | 4 | 60 | R3 | immutable release directory; no checkout commands | remove release and restore symlink |
| R-004 | Blind retry duplicates an external effect | 2 | 5 | 4 | 40 | R3 | failed-only; uncertain forbidden; fresh receipt | disable retry |
| R-005 | CSRF/DNS rebinding | 2 | 5 | 4 | 40 | R3 | loopback bind, Host, Origin, custom token/header | unload dashboard |
| R-006 | SQLite writer contention | 2 | 4 | 3 | 24 | R2 | WAL, 5s busy timeout, bounded queries | stop dashboard |
| R-007 | SSE misses external write | 3 | 3 | 3 | 27 | R2 | immediate local publish plus data_version invalidation | manual refresh/read API |
| R-008 | XSS from terminal/event content | 2 | 5 | 3 | 30 | R2 | React text rendering, no raw HTML, strict CSP | disable affected panel |
| R-009 | Partial workflow-start setup | 2 | 4 | 3 | 24 | R2 | full validation before stage; built-in-only registration | retry only after operator review |
| R-010 | Existing regression | 3 | 4 | 2 | 24 | R2 | baseline fix, focused tests, full verify | revert PR |
| R-011 | Migration failure | 1 | 5 | 1 | 5 | R1 | no new migration; assert existing migrations | stop dashboard |
| R-012 | Orca CLI unavailable | 3 | 2 | 1 | 6 | R1 | typed 502 and empty logs; no inferred state | restore when Orca returns |

R3 failure modes:

- Authority bypass: unexpected effect/control row without signed receipt. Detect through negative tests and table fingerprint. Recovery: unload dashboard and preserve DB for audit.
- Secret leakage: credential fixture appears in API/browser artifact. Detect via unit, integration, Playwright, and artifact grep. Recovery: disable logs/read route and rotate the exposed credential outside this plan.
- Dirty checkout overwrite: pre/post porcelain differs. Detect exact captured diff. Recovery: stop immediately; restore only files changed by deployment using captured copies.
- Blind retry: source state is uncertain or action is non-executable. Detect 409 requirement. Recovery: no request is staged.
- CSRF/rebinding: invalid Host/Origin/token reaches command service. Detect route tests and unchanged fingerprint. Recovery: unload dashboard.

## 18. Known adjustment points

| # | Planned assumption | Why it may differ | Worker action |
|---:|---|---|---|
| 1 | New branch names are unused | Another worker may create them | inspect `git branch -a`; choose the same prefix plus issue number |
| 2 | Argo revision remains available | Upstream may advance | retain surveyed SHA in NOTICE; do not silently change source basis |
| 3 | Port 4173 is free before deploy | Another local process may start | use `lsof`; stop only the dashboard label if it owns the port |
| 4 | production DB has extra migration journal rows | dirty production work added one migration | use `assertMigrationsReady`; do not reject unknown extra rows |
| 5 | current LaunchAgent paths remain stable | operator may update Node/runtime path | read installed plist and preserve exact Node 24 path |
| 6 | API seam signatures match surveyed code | earlier PRs may alter imports | grep/read the actual symbol before editing; keep authority behavior unchanged |
| 7 | Vite output is `dist/control-center` | config may resolve relative paths differently | inspect build output and update only server/plist static-root paths together |

At these points, the execution worker must not ask a question. It must inspect the actual code/runtime, apply the narrow compatibility adjustment, and report the adjustment in the PR evidence. A contract contradiction requires a BLOCKED report.

## 19. Autonomous and manual boundaries

- `AUTONOMOUS`: branch creation, issue publication, all PRs, tests, screenshots, CI, merge, backup, immutable release, LaunchAgent install, read-only production QA, and cleanup.
- `MANUAL`: N/A for implementation completion.
- External production receipt signing is an operator capability after release, not a release prerequisite. Positive mutation QA uses disposable generated keys and DB only.

## 20. Dispatch prompts

### First task

```text
TASK: PR-000 — Make the existing negative-evidence projection test deterministic.

DELIVERABLE:
- tests/integration/negative-evidence.test.ts diff
- focused Vitest and npm run verify outputs with exit codes
- adjustment report

SCOPE:
- Read this plan’s PR-000 and JCC-AC-001 sections first.
- MODIFY: tests/integration/negative-evidence.test.ts
- FORBIDDEN: src/**, migrations/**, production checkout
- Inject one mutable test clock; do not weaken authority expiry assertions.
- Do not add sleeps, retries, skips, ts-ignore, or changed production behavior.

VERIFY:
npx vitest run tests/integration/negative-evidence.test.ts --no-file-parallelism
Expected exit 0 and all tests in that file pass.

npm run verify
Expected exit 0.

Report WORKING/BLOCKED and exact command results.
```

Subsequent PR dispatches follow the same TASK/DELIVERABLE/SCOPE/VERIFY form using each PR’s exact file list and gate above.

## 21. Traceability

| REQ | Acceptance | PR | Primary files | Verification |
|---|---|---|---|---|
| BASE | AC-001 | 000 | negative-evidence test | focused Vitest, verify |
| SHELL/OVERVIEW | AC-002/003 | 002 | server, HTTP, app | API/app test, curl |
| TASKREAD/AGENT | AC-004/005 | 003 | read routes/model/terminal | API/terminal tests |
| SSE | AC-006 | 003 | events/store | SSE test, transcript |
| PROP/TASKCREATE | AC-007/008 | 004 | command service/proposal UI | authority tests, browser |
| DECIDE/EXEC | AC-009/010 | 005 | control routes/dialog | fingerprint tests |
| CANCEL/RETRY | AC-011/012 | 005 | command service/controls | controls tests |
| SEC | AC-013 | 001–005 | validation/redaction/HTTP | unit/integration/grep |
| UX | AC-014 | 006–007 | frontend components/e2e | axe, screenshots, console |
| DEPLOY | AC-015 | 007 | plist/release process | launchctl, curl, browser |

## 22. Review log

- Fresh review agent: unavailable in this child session; checklist self-review used.
- Confirmed command availability: 13/13 required host commands found.
- Confirmed package/build/test commands: package scripts and CI were read directly.
- Critical/high findings discovered during review:
  1. current branch already merged;
  2. baseline verify fails nondeterministically;
  3. production checkout is dirty;
  4. production has zero loop definitions.
- All four are addressed by branch reset-from-main, PR-000, immutable release deployment, and approved default-loop initialization.
- Unresolved CRITICAL findings: 0.
- Unresolved HIGH findings: 0.
- Plan-file vague-term grep: N/A — the user prohibited file edits, so this response was not written under `docs/planning/`.
