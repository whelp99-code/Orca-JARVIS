# jarvis-personal-operating-system - Work Plan

> **STATUS: READY FOR FRESH REVIEW — DO NOT EXECUTE UNTIL APPROVED**
>
> User correction on 2026-08-27: the final JARVIS runtime and sole authority/control-plane host is Linux. The Mac is a user/client surface and may be used for Electron packaging, macOS-native integration, and real-surface QA only. The prior Momus SHA approval is stale. Do not execute until this Linux-centered revision has a new SHA and fresh approval.

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**What you'll get:** JARVIS becomes a persistent personal operating system whose always-on runtime and authority services run on Linux. The packaged Mac app and private phone browser are client surfaces that use those Linux-hosted services without becoming independent authority hosts.

**Why this approach:** Keep the already-proven systems in their proper roles instead of rebuilding them: Second Brain owns durable personal memory, live adapters own current observations, and JARVIS Control Plane remains the only execution authority. The Daily Control Loop is the acceptance spine, so every added capability must prove that it helps observe, decide, execute, verify, or remember.

**What it will NOT do:** It will not create another memory database, continuously record screens or audio, trust stale memory as current truth, expose authority publicly, or let a model/agent execute consequential actions without an exact approval receipt. It will not add a paid cloud processor, public SaaS, native mobile app, code signing, notarization, push, merge, or deployment without separate owner authorization.

**Effort:** XL
**Risk:** High - this crosses two repositories, Linux authority/runtime services, personal-data migration, remote client approval, long-running workflows, and recovery semantics while preserving a live authority system.
**Decisions fixed by the user:** Linux is the final always-on JARVIS runtime and sole authority/control-plane host. Production Second Brain also runs on Linux behind typed stdio MCP. Mac Electron is a client/use surface plus packaging/native-QA target, never the production JARVIS or Second Brain runtime. Other prior decisions remain provisional until this corrected topology receives fresh review.

Your next move: finish this revision, record a new matching plan/draft SHA, obtain fresh approval, then run `/ulw-execute jarvis-personal-operating-system --worktree /home/jm/orca/workspaces/Orca-JARVIS/jarvis-personal-operating-system-linux` from the Linux task worktree. Mac work remains a dependent client/package/native-QA lane.

---

> TL;DR (machine): XL/high-risk, 36 implementation todos across two repositories plus 4 final verifier gates; delivers typed Second Brain integration, provenance-safe context and priority, receipt-bound orchestration, verified memory feedback, Daily Control Loop, Electron/phone surfaces, and 24-hour recovery.

## Scope
### Must have
- Preserve `AuthorityDb`, `ControlPlane`, `ApprovedCommandExecutor`, `LoopGraph`, `LiveSupervisor`, Task Timeline, portfolio projection, existing dashboard, release layout, and the separate Second Brain app/vault.
- Establish and enforce three distinct sources of truth: Second Brain for durable personal knowledge, live connectors for freshness-bounded observations, and JARVIS AuthorityDb for control/audit state.
- Integrate the Second Brain only through typed, bounded MCP contracts with source IDs, timestamps, confidence, sensitivity, purpose, retention, correction history, and freshness metadata.
- Add observation, context snapshot, recommendation, daily-loop, notification-intent, memory-candidate/outbox, connector checkpoint, remote principal, WebAuthn challenge, and audit persistence through forward-only checksummed migrations.
- Produce evidence-backed recommendations that cite memory, live, and authority evidence; expose omissions and conflicts; abstain on stale, unavailable, poisoned, or insufficient evidence.
- Execute the Daily Control Loop: morning synthesis, in-day decision queue, receipt-bound worker dispatch, signed progress correlation, independent verification, evening closeout, and next-session continuity.
- Make memory feedback idempotent and reconcilable across repositories: verified outcomes become candidates, sensitive/inferred facts require confirmation, and settlement requires observing the resulting cited Second Brain artifact.
- Support user-visible memory search, conflicts, correction, forgetting, export, retention, and deletion propagation without requiring terminal commands.
- Port the committed CLI-JAW/Electron dependency stack `6820124` → `e5c75d4` → `d66d898` into a fresh worktree and re-prove packaging plus stale-control removal; never use or clean the dirty source worktree.
- Keep the authority server loopback-only; expose phone access only through a tailnet-only authenticated gateway, and require a WebAuthn assertion bound to the exact command digest for remote approval.
- Provide macOS native redacted notifications plus an in-app decision inbox; notification payloads are informational and never contain executable authority.
- Pass deterministic unit/integration/E2E/security/recovery/longitudinal-memory tests on Linux, packaged Mac client manual QA against Linux authority, private phone-browser QA, Linux backup/restore rehearsal, and immutable release/rollback rehearsal.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No second JARVIS personal-memory database, copied embeddings, direct Second Brain vault mutation, or TypeScript rewrite of the Python memory pipeline.
- No public listener on the authority server, public SaaS, multi-user collaboration workspace, social feed, native mobile app, or independent browser authority.
- No continuous raw screen/audio/video capture, covert monitoring, indefinite transcript retention, secret capture, or personal-data telemetry.
- No model-authored policy, model-minted approval, prompt-only authorization, agent prose as completion evidence, or retrieved content that can redefine instructions/tool scope.
- No autonomous external messaging, push, merge, deployment, destructive/financial action, sensitive-memory publication, or memory deletion without the required exact receipt.
- No fake calendar/mail/messenger success path. An unverified source returns `unavailable` with evidence and does not block the core loop.
- No production self-modification or promotion of budgeted-evolution shadow routing.
- No touching/reverting unrelated `AGENTS.md`, `.omo/senpi-task/`, or the dirty Mac integration worktree.
- No code signing, notarization, public app-store distribution, new paid vendor, or new hosted data processor in this plan.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: TDD. TypeScript uses Vitest/tsc/ESLint plus Playwright from the Linux worktree; Python uses pytest/basedpyright/ruff through Linux `uv`. Mac runs only Electron packaging, native integration, and real-surface client QA. Every behavioral todo captures RED for the exact regression/contract before implementation and then GREEN once.
- Evidence: <attemptDir>/task-<N>-jarvis-personal-operating-system.<ext> (attemptDir = currentAttemptDir from 'omo-agent-toolkit ulw-loop status --json', .omo/evidence/ulw/<session>/<goalId>/a<attempt>; outside ulw-loop use .omo/evidence/)
- Baseline gates before wave 1: Linux `npm run verify` must reproduce the measured 64/64 backend files, 310/310 backend tests, 20/20 dashboard files, and 100/100 dashboard tests. Task 1 first captures the already-proven Linux Second Brain RED, retains the two completed deterministic portability repairs, adds only the newly exposed unified-DB source-scan portability follow-up, and then requires `uv run pytest`, `uv run ruff check .`, and `uv run basedpyright` plus bounded status/doctor to exit 0 against the isolated `.test-vault`; production personal data is not required.
- No fixed sleeps or timing-luck tests. Subscribe to exact SSE/process/file/event state before triggering; use injected clocks and bounded event timeouts.
- Security fixtures must cover prompt injection in memory/tool output, stale/conflicting memories, wrong principal, replayed/expired WebAuthn assertion, duplicate outbox delivery, connector outage, partial cross-repo failure, approval replay, notification leakage, and deletion propagation.
- Manual QA means Linux first proves the real authority/service/API/MCP surfaces, then the executing Mac client lane uses the packaged app (happy path, invalid action, `--help`/launch failure), native notifications/deep links, and Touch ID/passkey QA against Linux; the phone browser also targets Linux. Screenshots and command transcripts are evidence.

## Execution strategy
### Required runtime and execution topology
- Final JARVIS runtime, authority database, ControlPlane, schedulers, workers, gateway authority, and durable services run on Linux.
- Production Second Brain code, refresh/index pipeline, vault generations, backups, and stdio MCP provider run on Linux as a separate provider boundary.
- Mac is a client/use surface. Mac work is limited to Electron packaging, macOS-native integration/notifications/deep links, Touch ID/passkey client behavior, and real-surface QA against the Linux-hosted authority boundary.
- Mac-only source paths and native QA dependencies must not force backend/control-plane implementation or production runtime onto the Mac.
- Linux JARVIS source/worktree: `/home/jm/orca/projects/Orca-JARVIS` and `/home/jm/orca/workspaces/Orca-JARVIS/jarvis-personal-operating-system-linux`.
- Linux JARVIS immutable authority releases live at `/home/jm/.local/state/orca-jarvis/authority/releases/<40-hex-sha>` with atomic `/home/jm/.local/state/orca-jarvis/authority/current`; production `jm-jarvis.service` `WorkingDirectory`/`ExecStart` target only `authority/current`, never a source/task worktree.
- Linux Second Brain source/worktree: `/home/jm/orca/projects/second-brain-app` and `/home/jm/orca/workspaces/second-brain-app/jarvis-personal-operating-system`, pinned initially to `master`/`f36142c85d4a856094815e5d85c2de0002c97157`.
- Linux Second Brain production release/config/state/vault roots: `/home/jm/.local/state/second-brain/app/current`, `/home/jm/.config/second-brain/config.toml`, `/home/jm/.local/state/second-brain`, and `/home/jm/.local/share/second-brain/vault`.
- Production starts safely in typed `no_data` mode with an empty Linux vault generation. Personal-data activation is not a precondition for JARVIS, dashboard, scheduler, or authority startup.
- Existing Mac vault transfer is a separate owner-gated operation named `SECOND_BRAIN_MAC_VAULT_TRANSFER_APPROVAL`; it binds source `main`/`d921878eedcf55014eb8cf48e3383a6ba6a5f86e`, encrypted transfer window, archive digest, manifest, destination import staging, and clean/frozen source. No remote or credential is invented.
- Production restore is separately owner-gated as `SECOND_BRAIN_PRODUCTION_RESTORE_APPROVAL`; restore always creates a new Linux generation under `/home/jm/.local/share/second-brain/vault-generations`, reapplies deletion/tombstone state, rebuilds indexes/briefs, proves forgotten sentinels absent, and only then atomically switches the stable vault symlink.
- Linux adds hardened `jm-second-brain-refresh.service/.timer` and `jm-second-brain-backup.service/.timer` with `UMask=0077`; JARVIS remains independently bootable when Second Brain is unavailable.
- Linux services consume immutable releases, never source/task worktrees. Mac may disconnect or power off without stopping JARVIS, Second Brain refresh, notification intents, backups, or authority.
- This execution is direct/local only: no `--make-pr`, PR, ship, push, merge, production deployment/activation, signing, or notarization. Todo 36 generates/rehearses immutable release and unit artifacts in isolated roots; real activation requires a later separate `JARVIS_PRODUCTION_ACTIVATION_APPROVAL`.

### Host ownership matrix
| Todos | Production owner | Mac role |
| --- | --- | --- |
| 1-3 | Linux preflight, source-of-truth, privacy/security policy | Read-only client/package inventory only |
| 4 | Linux repository/CI test authority | Optional browser rendering QA |
| 5 | Linux backend/control-plane port and canonical commit integration | Electron `.app` packaging and native client QA |
| 6-30 | Linux JARVIS runtime plus Linux Second Brain provider where named | Synthetic client/provider fixtures only; no production authority |
| 31-32 | Linux APIs, receipts, mutations, and state | Today/Memory client UI and accessibility QA |
| 33 | Linux creates/redacts/persists notification intents | macOS delivery and deep-link client handling only |
| 34-35 | Linux gateway, sessions, WebAuthn verification, ControlPlane receipt minting | Phone/Mac client interaction and native authenticator QA |
| 36 | Linux operations, services, backup/restore, release/rollback, and production Second Brain activation | Packaged-client/native QA after Linux gates |
| F1-F2 | Linux compliance and code-quality authority, with separate Mac client artifact review | Client/package/native findings only |
| F3 | Linux production/API/MCP/recovery QA first | Packaged Mac/Touch ID/native notification QA against Linux |
| F4 | Cross-host scope audit proving no Mac authority/runtime | Prove client-only containment |

### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.
- Dependency rows are the scheduling authority. A wave is a bounded delivery band; within a band, launch only rows whose listed blockers are complete.
- **Preflight and bounded repair (todo 1):** verify immutable host/artifact/worktree entry conditions before any edit, capture the known Second Brain RED, retain the two proven portability-repair commits, add one failing-first atomic follow-up for the newly exposed unified-DB source-scan path, then freeze exact all-green cross-repository baselines before wave 1.
- **Wave 1 - Foundation (todos 2-6):** freeze source-of-truth/security contracts, remove the asynchronous React warning debt, port the committed CLI-JAW/Electron stack, and freeze the cross-repo compatibility fixture.
- **Wave 2 - Persistence and bridge (todos 7-12):** add forward-only schemas, typed contracts, MCP transport/read adapter, and Second Brain capability/health reporting.
- **Wave 3 - Observation and judgment (todos 13-18):** normalize existing sources, fail closed for unavailable ones, assemble provenance-safe context, load confirmed principles, and rank/retain recommendations.
- **Wave 4 - Daily loop (todos 19-24):** longitudinal evaluation, durable scheduling, morning/in-day/evening behavior, notification intents, and read APIs.
- **Wave 5 - Authority and memory feedback (todos 25-30):** turn approved recommendations into one worker workflow, verify settlement, classify memory candidates, extend Second Brain write contracts, reconcile outbox delivery, and implement correction/forget/export.
- **Wave 6 - Human surfaces and operations (todos 31-35):** Today/Memory UI, native notifications/deep links, tailnet gateway, and WebAuthn remote approval, scheduled by the dependency matrix.
- **Wave 7 - Release proof (todo 36):** integrate Linux runtime/retention/backup/recovery operations, then prove Mac and phone clients against Linux.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | none | 2-36 | none |
| 2 | 1 | 7-18, 25-30, 34-35 | 3, 4, 5, 6 |
| 3 | 1 | 13-18, 27-30, 33-35 | 2, 4, 5, 6 |
| 4 | 1 | 31-32 | 2, 3, 5, 6 |
| 5 | 1 | 31-32, 36 | 2, 3, 4, 6 |
| 6 | 1 | 10-12, 28-30 | 2, 3, 4, 5 |
| 7 | 2, 5 | 13-24 | 8, 9, 10, 11, 12 |
| 8 | 2 | 19-24, 27-30 | 7, 9, 10, 11, 12 |
| 9 | 2 | 13-18, 25-35 | 7, 8, 10, 11, 12 |
| 10 | 2, 6, 9 | 11-12 | 7, 8 |
| 11 | 6, 9, 10 | 12, 15-17, 28-30 | 7, 8 |
| 12 | 6, 9, 10, 11 | 15-17, 28-30, 36 | 7, 8 |
| 13 | 2, 3, 7, 9, 12 | 15-18 | 14 |
| 14 | 2, 3, 7, 9 | 15-18 | 13 |
| 15 | 2, 3, 7, 9, 11-14 | 16-24 | none |
| 16 | 3, 11, 12, 15 | 17-24 | none |
| 17 | 2, 9, 12, 15, 16 | 18-25 | none |
| 18 | 7, 9, 13-17 | 19-25, 31 | none |
| 19 | 12, 15-18 | 20-24, 36 | none |
| 20 | 7-9, 12, 15-19 | 23-24, 31, 36 | none |
| 21 | 7-9, 12, 15-18, 20 | 23, 31-32, 36 | 22 |
| 22 | 7-9, 12, 15-18 | 23, 30-31, 36 | 21 |
| 23 | 8-9, 18, 20-22 | 31-32, 36 | none |
| 24 | 7-9, 18, 20-23 | 31, 36 | none |
| 25 | 2, 7-9, 17-18 | 26, 31, 36 | 27 |
| 26 | 2, 7-9, 18, 25 | 27, 31, 36 | none |
| 27 | 2-3, 8-9, 17-18 | 28-30, 32, 36 | 25 |
| 28 | 6, 9, 11-12, 27 | 29-30, 32, 36 | none |
| 29 | 8-9, 12, 27-28 | 30, 32, 36 | none |
| 30 | 2-3, 8-9, 12, 22, 27-29 | 32, 35-36 | none |
| 31 | 4-5, 9, 18, 20-26 | 33-34, 36 | 32 |
| 32 | 4-6, 9, 21-23, 27-30 | 36 | 31 |
| 33 | 3, 7, 9, 31 | 34, 36 | 35 |
| 34 | 2-3, 7-9, 25-26, 31, 33 | 36 | 35 |
| 35 | 2-3, 7-9, 30, 33 | 36 | 34 |
| 36 | all 1-35 | F1-F4 | none |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. Establish clean cross-repository execution baselines
  What to do / Must NOT do: First, before any effect, assert execution is on Linux; resolve Orca and load its live `orca-cli` guide; verify the canonical plan/draft SHA; confirm the existing task-owned JARVIS worktree `/home/jm/orca/workspaces/Orca-JARVIS/jarvis-personal-operating-system-linux`, Second Brain source `/home/jm/orca/projects/second-brain-app`, and Second Brain task worktree `/home/jm/orca/workspaces/second-brain-app/jarvis-personal-operating-system`; verify the Second Brain task worktree started from remote `master` `f36142c85d4a856094815e5d85c2de0002c97157`; require both tracked/index states clean; verify the isolated `.test-vault` exists, the production transfer gate is unset, and Mac task terminal count is zero; record branch/HEAD/ahead-behind/dirty counts, Linux Node `v24.19.0`, and current active/enabled `jm-jarvis.service`, `jm-jarvis-dashboard.service`, and `jm-jarvis-portfolio-collector.timer`. This immutable preflight is read-only and must pass before creating or changing any file, vault generation, process, mount, terminal, or Git state. Only after it passes, create/verify the empty Linux production vault generation and typed `no_data` state without copying personal data. Then execute the following sub-todos in order and never collapse them:
    1. Reproduce and retain the existing focused RED proving that SQL NULL rows are dropped and pipe/multiline values corrupt the delimiter-framed ledger transport.
    2. Add failing regressions for exact NULL versus empty-string preservation plus pipe and multiline round-trips; replace the ambiguous sqlite CLI framing with one lossless machine-parsed output contract; run focused GREEN; make one atomic Second Brain commit.
    3. Reproduce and retain the existing Linux RED for `tests/test_connectors_records.py`, `tests/test_connectors_sessions_a.py`, and `tests/integration/test_walking_skeleton.py` dereferencing hardcoded `/Volumes/DevSpace/...` roots.
    4. Add deterministic repository-owned fictional fixtures and route those tests to them without personal data, skips, xfails, weakened assertions, host mounts, or environment shims; run focused GREEN; make one atomic Second Brain commit.
    5. Reproduce the full-suite RED for `tests/test_connectors_unified_db.py::test_executed_sql_and_module_contain_no_write_or_ddl` dereferencing `/Volumes/DevSpace/second-brain-app/sb/connectors`; route that source scan to the imported repository module path without changing the assertion, run focused GREEN, and make one scoped atomic Second Brain follow-up commit without rewriting the two already-green commits.
    6. Run the full Second Brain pytest/ruff/basedpyright/status/doctor gates and exact JARVIS verify baseline, record the resulting clean heads/counts, and only then unblock wave 1.
  Read the paused Mac client/integration worktrees only when exact committed client code or native-QA inventory is needed. Must NOT edit JARVIS product files during todo 1, use Mac as runtime/authority, contact/start a Mac terminal for these Linux repairs, transfer the Mac vault without `SECOND_BRAIN_MAC_VAULT_TRANSFER_APPROVAL`, create or mount host `/Volumes`, use a lossy sqlite/PATH shim, weaken/delete/skip tests, reset, clean, switch source checkouts, amend/rebase, push, merge, deploy, run the production refresh pipeline, or touch unrelated `AGENTS.md`/`.omo/senpi-task/`.
  Parallelization: Preflight | Blocked by: none | Blocks: 2-36
  References (executor has NO interview context - be exhaustive): `AGENTS.md`; `ORCA_MASTER_CHARTER.md`; `package.json#scripts`; `/home/jm/.config/systemd/user/jm-jarvis.service`; `/home/jm/.config/systemd/user/jm-jarvis-dashboard.service`; Second Brain remote `https://github.com/whelp99-code/second-brain-app.git`; draft findings in `.omo/drafts/jarvis-personal-operating-system.md`.
  Acceptance criteria (agent-executable): pre-edit preflight proves Linux is the execution host; both Linux task worktrees and the isolated fixture vault exist; plan SHA equals the draft receipt; wrong-host/missing-path/mismatched-plan/dirty-entry cases stop before edits. Existing evidence plus fresh focused runs establish the correct RED before each repair. Ledger tests prove SQL NULL remains `None`, empty remains `""`, pipe and multiline fields round-trip exactly, and no valid row is dropped. Connector/walking-skeleton tests consume only committed fictional repository fixtures and contain no host-absolute fixture root. The two approved repairs remain as two independently green atomic Second Brain commits; the newly exposed unified-DB source-scan portability defect lands as one separate scoped follow-up commit without rewriting history; JARVIS receives no product edit. Final JARVIS baseline exits 0 with 64/64 backend files, 310/310 backend tests, 20/20 dashboard files, and 100/100 dashboard tests; any count drift halts rather than accepting a lower/different baseline. Full Second Brain pytest/ruff/basedpyright/status/doctor all exit 0 at the repaired task-worktree HEAD. Evidence records exact before/after heads, commits, statuses, counts, and cleanup; proves `6820124d2e3cdf620fe04b4d98b85dafb0f6470b` reachability and records `e5c75d4`/`d66d898` as later todo-5 dependencies without starting a Mac terminal; confirms Mac task terminal count 0 and zero destructive commands. Production remains `no_data`; no personal-data gate is consumed.
  QA scenarios (name the exact tool + invocation): RED ledger: Linux `bash` runs `cd /home/jm/orca/workspaces/second-brain-app/jarvis-personal-operating-system && umask 022 && UV_LINK_MODE=copy SB_SQLITE=/home/jm/.local/bin/sqlite3 uv run pytest -q tests/test_cli.py tests/test_store_ledger.py` before the parser edit and requires nonzero with the captured NULL/row-reload failures. GREEN ledger: rerun the same command plus the new exact NULL/empty/pipe/multiline regressions and require exit 0. RED fixtures: run `uv run pytest -q tests/test_connectors_records.py tests/test_connectors_sessions_a.py tests/integration/test_walking_skeleton.py` before fixture edits and require nonzero hardcoded-path failures. GREEN fixtures: rerun exactly those files after repository fixture routing and require exit 0 with no skip/xfail/deselection. RED unified source scan: run `uv run pytest -q tests/test_connectors_unified_db.py::test_executed_sql_and_module_contain_no_write_or_ddl` at commit `55f9cc7f8fb16324c4cabf29f5f4b4847affd82a` and require the captured `/Volumes/DevSpace/second-brain-app/sb/connectors` failure. GREEN unified source scan: route the scan through the imported repository module path, rerun the exact node, and require exit 0 before the scoped follow-up commit. Final happy: run full Second Brain `uv run pytest`, `uv run ruff check .`, `uv run basedpyright`, bounded `uv run sb status`, bounded `uv run sb doctor`, and JARVIS `npm run verify`; every command exits 0 and trees are clean after the three commits. Failure: run the preflight checker against wrong-host, stale-SHA, dirty entry, missing Second Brain remote, and unavailable later client patches and assert it refuses before any corresponding effect. Evidence `<attemptDir>/task-1-jarvis-personal-operating-system.md`.
  Recommended task executor category: `unspecified-high`
  Commit: Y (Second Brain only, three atomic increments) | `fix(store): make sqlite row transport lossless`; then `test: make connector fixtures portable`; then `test: make unified connector source scan portable`

- [x] 2. Freeze the personal operating system source-of-truth contracts
  What to do / Must NOT do: Add `docs/personal-os/architecture.md` and `docs/personal-os/contracts.md` defining authority, live observation, durable memory, context, recommendation, workflow, notification, remote identity, and deletion ownership; define exact state machines and versioned envelope fields. Must NOT let memory authorize actions, let observations become permanent personal facts automatically, or let model output bypass deterministic parsing/policy.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 7-18, 25-30, 34-35
  References (executor has NO interview context - be exhaustive): `docs/planning/03-ARCHITECTURE-CONTRACTS.md`; `docs/TASK_TIMELINE_KO.md`; `ORCA_MASTER_CHARTER.md`; `src/control-plane.ts#ControlPlane`; `src/task-timeline.ts#TaskTimeline`; Linux Second Brain worktree `sb/contracts.py` and `sb/mcp.py`.
  Acceptance criteria (agent-executable): docs contain one source-of-truth/host matrix naming Linux authority/runtime, separate Linux Second Brain provider, and Mac client-only ownership; complete state diagrams and canonical identifiers include `no_data`, transfer/restore gates, observation, recommendation, memory candidate/outbox, notification, and remote approval; every transition names authority, idempotency key, freshness/expiry rule, and failure disposition; no `<fill>`, TBD, or unresolved fork remains. Do not add a test that pins prose.
  QA scenarios (name the exact tool + invocation): happy: `read` plus repository path/symbol checks confirm every cited pre-existing reference exists and a reviewer records the canonical identifiers todo 9 must implement; failure: any undocumented state/authority/freshness edge blocks todo 9 until corrected, Evidence `<attemptDir>/task-2-jarvis-personal-operating-system.md`.
  Recommended task executor category: `unspecified-high`
  Commit: Y | `docs(personal-os): freeze authority and memory contracts`

- [x] 3. Define privacy, threat, retention, and consent policy
  What to do / Must NOT do: Add `docs/personal-os/privacy-security.md` and machine-consumed policy config under `config/personal-os-policy.json`; enumerate sensitivity tiers, purpose limitation, retention/expiry, confirmation requirements, quiet hours, critical alert classes, export/delete semantics, wrong-principal isolation, prompt-injection and memory-poisoning controls. Must NOT record raw screens/audio, secrets, full mail/calendar bodies by default, or use prose-only policy for runtime gates.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 13-18, 27-30, 33-35
  References (executor has NO interview context - be exhaustive): `src/dashboard/redaction.ts`; `src/secure-filesystem.ts`; `src/control-actions.ts`; Linux Second Brain worktree `sb/config.py` and `sb/connectors/fs_safety.py`; GDPR Articles 5/16/17/25; NIST AI RMF; OWASP LLM/Agentic guidance.
  Acceptance criteria (agent-executable): Linux policy parser rejects unknown tiers/actions, invalid time windows, indefinite retention, and notification payloads containing prohibited fields; every data class has purpose, retention, confirmation, export, deletion, host ownership, `no_data`, Mac-vault transfer, and Linux restore behavior; Mac receives only policy-approved/redacted client payloads.
  QA scenarios (name the exact tool + invocation): happy: `vitest` parses the shipped policy and evaluates representative memory/notification cases; failure: injected secret/raw-body/indefinite-retention fixtures fail closed, Evidence `<attemptDir>/task-3-jarvis-personal-operating-system.json`.
  Recommended task executor category: `unspecified-high`
  Commit: Y | `feat(policy): define personal data and consent boundaries`

- [x] 4. Remove asynchronous React test warning debt
  What to do / Must NOT do: Fix existing routed dashboard tests so all state transitions are awaited through exact store/SSE events and React `act(...)`; no fixed sleeps, broad console suppression, warning filtering, or weakened assertions. Lock the harness before adding Today/Memory asynchronous surfaces.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 31-32
  References (executor has NO interview context - be exhaustive): `dashboard/src/root.test.tsx`; `dashboard/src/root-approvals.test.tsx`; `dashboard/src/root-task.test.tsx`; `dashboard/src/root-agent.test.tsx`; `dashboard/src/store-test-harness.ts`; `dashboard/src/store-sse.test.ts`.
  Acceptance criteria (agent-executable): `vitest run --config dashboard/vite.config.ts --no-file-parallelism` exits 0 with 20/20 files and 100/100 existing tests before new tests; captured stderr contains zero `not wrapped in act` occurrences.
  QA scenarios (name the exact tool + invocation): happy: Linux test worktree subscribes before emitting snapshot/reconcile and asserts rendered state; failure: intentionally omit awaited event in a fixture and prove the harness detects an unflushed update; optional Mac browser rendering is client QA only, Evidence `<attemptDir>/task-4-jarvis-personal-operating-system.txt`.
  Recommended task executor category: `quick`
  Commit: Y | `test(dashboard): make async routing deterministic`

- [x] 5. Port the committed CLI-JAW and Electron stack safely
  What to do / Must NOT do: In the clean Linux JARVIS worktree, port committed functionality from `6820124d2e3cdf620fe04b4d98b85dafb0f6470b`, `e5c75d40f7c2e7a421fbf67f98cbc8e60c30a53a`, and `d66d898d1da3bed64c1fb7348aa764c8c401ed77` in dependency order; obtain exact read-only patches from the paused Mac client reference only when a commit is not remotely reachable; reconcile migration `031_control_ingress_idempotency.sql`, scripts, package dependencies, tests, and stale-control removal against current main. Linux owns backend/control-plane integration and canonical commits; Mac owns only `.app` packaging/native client QA from the reviewed Linux commit. Must NOT copy dirty worktree changes, create Mac authority/runtime, or modify authority semantics to make packaging pass.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 31-32, 36
  References (executor has NO interview context - be exhaustive): remote branch `feat/jarvis-argo-cli-jaw-integration`; commits `6820124`, `e5c75d4`, `d66d898`; `migrations/030_dashboard_portfolio_projection.sql`; committed paths `scripts/lib/electron-shell.mjs`, `scripts/lib/package-electron-app.mjs`, `scripts/package-electron.mjs`, `scripts/lib/print-surfaces.mjs`; tests `tests/integration/open-electron.test.ts`, `package-electron.test.ts`, `package-electron-real.test.ts`, `electron-local-decision.test.ts`.
  Acceptance criteria (agent-executable): Linux migration order is unique/checksummed and `npm run verify` plus dashboard warning gate pass; Mac client lane packages the exact reviewed Linux commit, generated `.app` contains Electron `v44.0.0`, connects to Linux authority without a local AuthorityDb fallback, and stale controls disappear after Linux settlement.
  QA scenarios (name the exact tool + invocation): happy: Linux tests pass, then Mac packages/launches the client against Linux, settles one request, and observes pending `1→0`/controls `1→0`; failure: invalid Electron resolution, Linux-unreachable authority, local-authority fallback attempt, and already-settled request fail safely, Evidence `<attemptDir>/task-5-jarvis-personal-operating-system.md` plus screenshots.
  Recommended task executor category: `unspecified-high`
  Commit: Y | `feat(electron): port verified CLI-JAW application stack`

- [x] 6. Freeze the Second Brain MCP compatibility fixture
  What to do / Must NOT do: In the Linux Second Brain task worktree, add a machine-readable contract fixture for the five existing tools (`sb_search`, `sb_read_page`, `sb_recent_changes`, `sb_open_conflicts`, `sb_remember`), typed `no_data`, their arguments/results/errors, pinned app commit/schema version, and inbox idempotency behavior; add a JARVIS-side copy generated only by a checked script. Use only `.test-vault`; Mac may replay synthetic fixtures for client QA but cannot produce the production contract.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 10-12, 28-30
  References (executor has NO interview context - be exhaustive): Linux Second Brain worktree `sb/mcp.py#K5_TOOLS`, `sb/contracts.py`, `sb/inbox.py`, `tests/test_mcp.py`, and `tests/integration/test_walking_skeleton.py`.
  Acceptance criteria (agent-executable): Python fixture exporter and TypeScript fixture consumer produce identical canonical SHA-256; all five happy responses and stable error classes are covered; fixture contains no real personal content, credentials, or absolute private file contents.
  QA scenarios (name the exact tool + invocation): happy: export fixture then validate it from both repos; failure: version/tool/field drift yields `SECOND_BRAIN_CONTRACT_MISMATCH`, Evidence `<attemptDir>/task-6-jarvis-personal-operating-system.json`.
  Recommended task executor category: `unspecified-high`
  Commit: Y | atomic commits in both repos: `test(mcp): freeze compatibility contract` and `test(second-brain): consume MCP contract fixture`

- [x] 7. Add observation, context, and recommendation persistence
  What to do / Must NOT do: Add forward-only migration `032_personal_context.sql` for immutable observation envelopes, bounded context snapshots, recommendations/actions/evidence links, source checkpoints, expiry, and audit events; add typed `AuthorityDb` methods with constraints and indexes. Must NOT store raw MCP pages, secrets, complete terminal output, or mutable “current truth” rows without version/history.
  Parallelization: Wave 2 | Blocked by: 2, 5 | Blocks: 13-24
  References (executor has NO interview context - be exhaustive): `src/db.ts#AuthorityDb`; `migrations/008_orca_observations.sql`; `migrations/026_task_timeline.sql`; `migrations/030_dashboard_portfolio_projection.sql`; `tests/integration/migrations.test.ts`; `tests/integration/orca-observation-persistence.test.ts`.
  Acceptance criteria (agent-executable): migration checksum/ordering tests pass from empty and prior-031 databases; duplicate observation identity is idempotent; expired snapshots are rejected for decisions; SQLite quick_check is `ok`; sensitive payload columns are absent.
  QA scenarios (name the exact tool + invocation): happy: persist and reconstruct one mixed-source context/recommendation; failure: duplicate digest, future timestamp, expired source, and oversize payload fail with stable `JarvisError` codes, Evidence `<attemptDir>/task-7-jarvis-personal-operating-system.json`.
  Recommended task executor category: `unspecified-high`
  Commit: Y | `feat(db): persist personal context and recommendations`

- [x] 8. Add daily-loop, notification, memory-outbox, and remote-auth persistence
  What to do / Must NOT do: Add migration `033_personal_operations.sql` for daily loop runs/steps, notification intents/deliveries, memory candidates/outbox/reconciliation/tombstones, remote principals, WebAuthn credentials/challenges/assertions, and retention jobs; use unique correlation/idempotency keys, leases, fences, expiries, and append-only audit events. Must NOT store private keys, raw biometric data, notification secrets, or memory content in authentication tables.
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: 19-24, 27-30
  References (executor has NO interview context - be exhaustive): `migrations/021_approval_control_plane.sql`; `migrations/024_microloop_runtime.sql`; `migrations/027_control_execution_hardening.sql`; `src/control-plane.ts`; `src/microloops.ts`; `src/negative-evidence.ts`; `tests/integration/worker-crash-idempotency.test.ts`.
  Acceptance criteria (agent-executable): migration tests prove one active lease per job, one outbox row per candidate/idempotency key, single-use unexpired challenges, no assertion replay, valid tombstone lifecycle, and upgrade/rollback backup compatibility.
  QA scenarios (name the exact tool + invocation): happy: create/claim/settle each state machine once; failure: duplicate claimant, stale fence, replayed challenge, duplicate outbox send, and delete-before-confirm fail closed, Evidence `<attemptDir>/task-8-jarvis-personal-operating-system.json`.
  Recommended task executor category: `unspecified-high`
  Commit: Y | `feat(db): persist daily operations and remote authority`

- [x] 9. Implement versioned personal operating contracts and parsers
  What to do / Must NOT do: Add flat modules `src/personal-contracts.ts` and `src/personal-validation.ts` for `ObservationEnvelopeV1`, `ContextSnapshotV1`, `RecommendationV1`, `DailyLoopRunV1`, `NotificationIntentV1`, `MemoryCandidateV1`, `MemoryOutboxV1`, and remote approval envelopes; parse at boundaries with exhaustive discriminants, byte/list limits, canonicalization, and no `any`. Must NOT accept extra authority-bearing fields, instruction text as policy, unbounded arrays, ambiguous timestamps, or unknown enum values.
  Parallelization: Wave 2 | Blocked by: 2 | Blocks: 13-18, 25-35
  References (executor has NO interview context - be exhaustive): `src/types.ts`; `src/control-plane.ts` input types; `src/dashboard/contracts.ts`; `src/dashboard/validation.ts`; `src/canonical.ts`; `src/AGENTS.md`; programming TypeScript strict-type rules.
  Acceptance criteria (agent-executable): `tsc --noEmit` and public API tests pass; machine-consumed discriminant/state identifiers exactly match the canonical identifiers fixed by todo 2; property/table tests cover all discriminants and limits; canonical hashes are stable across object key order; all parsed objects are immutable/read-only types.
  QA scenarios (name the exact tool + invocation): happy: round-trip one value of every contract; failure: unknown source/trust/sensitivity/state, malformed ISO time, oversized excerpt, extra approval field, and prototype-pollution payload all reject, Evidence `<attemptDir>/task-9-jarvis-personal-operating-system.json`.
  Recommended task executor category: `unspecified-high`
  Commit: Y | `feat(contracts): define personal operating envelopes`

- [x] 10. Implement a supervised stdio MCP transport
  What to do / Must NOT do: Add `src/second-brain-transport.ts` that Linux `jm-jarvis.service` uses to launch `/home/jm/.local/state/second-brain/app/current/bin/second-brain-mcp` with `execFile` argument arrays and `SB_CONFIG=/home/jm/.config/second-brain/config.toml`; validate the frozen handshake, correlate requests, enforce 5s startup, 10s reads, 30s writes, four concurrent reads, one serialized write, 1 MiB frames, redacted logs, cancellation, and typed restart/reconciliation behavior. Must NOT use a shell, broad environment, Mac process, direct vault access, or automatic replay of an uncertain write.
  Parallelization: Wave 2 | Blocked by: 2, 6, 9 | Blocks: 11-12
  References (executor has NO interview context - be exhaustive): Linux Second Brain release/worktree `sb/mcp.py`; `src/orca.ts#defaultRunner`; `src/gjc.ts`; `src/service.ts`; `src/orca-resume.ts`; `tests/integration/gjc-runtime.test.ts`.
  Acceptance criteria (agent-executable): deterministic Linux transport tests prove launcher discovery/freeze, handshake, request correlation, budgets, explicit environment allowlist, bounded reads, cancellation, malformed frame rejection, child crash recovery, no-data operation, secret-free diagnostics, and `uncertain` disposition for interrupted writes; stopping Mac changes none of these results.
  QA scenarios (name the exact tool + invocation): happy: call a fixture MCP child for all read methods; failure: wrong version, partial frame, oversize payload, hung child, crash mid-write, and command injection argument all fail with stable codes, Evidence `<attemptDir>/task-10-jarvis-personal-operating-system.txt`.
  Recommended task executor category: `deep`
  Commit: Y | `feat(second-brain): add supervised MCP transport`

- [x] 11. Implement the bounded Second Brain read adapter
  What to do / Must NOT do: Add `src/second-brain-adapter.ts` mapping Linux stdio `sb_search`, `sb_read_page`, `sb_recent_changes`, and `sb_open_conflicts` into typed memory evidence with source ID/version, cited SID, sensitivity, observed/valid time, freshness, trust, excerpt digest, and explicit `no_data`/unavailable/stale states; retain references and bounded excerpts only. Must NOT load whole pages/vaults into prompts, use Mac filesystem paths, execute retrieved instructions, mutate memory, or treat search rank as confidence.
  Parallelization: Wave 2 | Blocked by: 6, 9, 10 | Blocks: 12, 15-17, 28-30
  References (executor has NO interview context - be exhaustive): Linux Second Brain worktree `sb/mcp.py`, `sb/search.py`, `sb/contracts.py#SourceRef`; `src/task-timeline.ts#context`; `src/dashboard/redaction.ts`.
  Acceptance criteria (agent-executable): adapter enforces configured max hits/excerpt bytes/total bytes; every item has a source reference and content digest; conflicts remain separate; missing/stale server returns typed degradation rather than fabricated empty success.
  QA scenarios (name the exact tool + invocation): happy: retrieve a fixture principle and cited project fact; failure: embedded prompt injection, conflicting facts, missing SID, oversize page, sensitive tier, and offline MCP all remain non-authoritative and fail/degrade exactly, Evidence `<attemptDir>/task-11-jarvis-personal-operating-system.json`.
  Recommended task executor category: `unspecified-high`
  Commit: Y | `feat(second-brain): add provenance-safe read adapter`

- [x] 12. Add Second Brain capability, health, and compatibility reporting
  What to do / Must NOT do: Extend `src/capabilities.ts`, `src/doctor.ts`, CLI JSON, dashboard health, and public API with a Linux `second_brain` capability evaluated independently across installed/configured/protocol-compatible/operational/authorized/data-state/last-successful-refresh/freshness; compare the frozen digest and run bounded status/doctor probes without triggering refresh. Must NOT mark healthy from process existence, require Mac availability, or expose paths/credentials.
  Parallelization: Wave 2 | Blocked by: 6, 9-11 | Blocks: 15-17, 28-30, 36
  References (executor has NO interview context - be exhaustive): `src/capabilities.ts`; `src/doctor.ts`; `src/cli.ts`; `src/dashboard/read-model.ts`; Linux Second Brain worktree `sb/cli.py`; `tests/unit/capabilities.test.ts`; `tests/unit/doctor.test.ts`.
  Acceptance criteria (agent-executable): Linux `jarvis capabilities --json` and dashboard health report each stage with bounded fixed vocabulary; protocol drift, `no_data`, capped/failed/previous-date refresh, vault absence, and unauthorized write are distinct; probes have injected clocks/runners, no leaked paths, and remain available with Mac disconnected.
  QA scenarios (name the exact tool + invocation): happy: live status/doctor and fixture handshake yield operational=true; failure: missing executable, wrong digest, stale/capped run, locked vault, and write-disabled mode each produce the correct stage failure, Evidence `<attemptDir>/task-12-jarvis-personal-operating-system.json`.
  Recommended task executor category: `unspecified-high`
  Commit: Y | `feat(capabilities): report Second Brain readiness`

- [x] 13. Implement the connector registry and fail-closed source states
  What to do / Must NOT do: Add `src/personal-connectors.ts` with explicit adapters for Second Brain, Orca, TaskTimeline, and authenticated portfolio plus typed `calendar`, `mail`, and `messenger` slots returning `unavailable` until a separately verified source is configured; implement per-source scopes, field allowlists, freshness thresholds, cursor/checkpoint semantics, and health. Must NOT introspect local Mail/Calendar databases, invent provider support, or persist bodies.
  Parallelization: Wave 3 | Blocked by: 2, 3, 7, 9, 12 | Blocks: 15-18
  References (executor has NO interview context - be exhaustive): `src/orca.ts#OrcaReadonlyAdapter`; `src/task-timeline.ts`; `src/dashboard/portfolio-projection.ts#portfolioFreshness`; `src/capabilities.ts`; Linux Second Brain worktree `sb/connectors/base.py`; draft connector findings.
  Acceptance criteria (agent-executable): Linux registry lists exact capabilities/scopes; `no_data`, stale, offline, and unavailable remain distinct with reason/evidence/last-check; thresholds reproduce portfolio live≤90s/stale≤300s/offline and source-specific values; unknown connectors reject and Mac-local sources stay explicitly unavailable unless separately configured as non-authoritative client observations.
  QA scenarios (name the exact tool + invocation): happy: enumerate four configured sources and three unavailable slots; failure: stale cursor, replayed envelope, unconfigured mail, overbroad body scope, and unknown source fail closed, Evidence `<attemptDir>/task-13-jarvis-personal-operating-system.json`.
  Recommended task executor category: `unspecified-high`
  Commit: Y | `feat(connectors): register bounded personal sources`

- [x] 14. Normalize Orca, timeline, and portfolio observations
  What to do / Must NOT do: Add `src/personal-observations.ts` on Linux to transform Orca worktree/terminal state, TaskTimeline summaries/decisions/evidence, and signed portfolio projection into `ObservationEnvelopeV1`; identify `linux-control-plane`, remote `jm-server`, and `mac-client` distinctly; persist digests/checkpoints through todo 7 without duplicating source rows. Update `docs/dual-environment-monitoring.md` so `local`/default authority means the Linux control plane, `jm-server` remains explicit remote observation, and Mac appears only as optional `mac-client` QA evidence; mark previous Local-Mac/master-runtime commands historical and non-executable. Must NOT use terminal preview/prose for identity, infer completion from idle/prompt return, or conflate Mac Orca with Linux authority.
  Parallelization: Wave 3 | Blocked by: 2, 3, 7, 9 | Blocks: 15-18
  References (executor has NO interview context - be exhaustive): `src/orca.ts`; `src/orca-env.ts`; `src/live-supervisor.ts`; `src/task-timeline.ts`; `src/dashboard/portfolio-projection.ts`; `docs/dual-environment-monitoring.md` (must be corrected by this todo before use); `tests/unit/orca-readonly-adapter.test.ts`; `tests/unit/portfolio-projection.test.ts`.
  Acceptance criteria (agent-executable): normalized observations preserve explicit host/environment/worktree/terminal/incarnation/cursor/task IDs and evidence refs; Linux authority and Mac client IDs cannot collide; replay/out-of-order is idempotent or rejected; docs contain no executable Mac-master/runtime instruction; no raw terminal text or secret-bearing fields persist.
  QA scenarios (name the exact tool + invocation): happy: aggregate one local and one jm-server active task with timeline evidence; failure: ambiguous terminal, stale incarnation, out-of-order portfolio, agent “done” prose without evidence, and cross-host ID collision fail closed, Evidence `<attemptDir>/task-14-jarvis-personal-operating-system.json`.
  Recommended task executor category: `unspecified-high`
  Commit: Y | `feat(observation): normalize live work evidence`

- [x] 15. Build the provenance-safe context assembler
  What to do / Must NOT do: Add `src/context-assembler.ts` that takes a declared purpose/query and combines bounded live observations, pending authority decisions, timeline evidence, and Second Brain memory into `ContextSnapshotV1`; enforce source budgets, freshness, sensitivity, trust, conflict/omission lists, canonical digest, and expiry. Retrieved content is delimited data only. Must NOT silently resolve conflicts, pull unrelated personal data, exceed budgets, or let memory replace live checks.
  Parallelization: Wave 3 | Blocked by: 2, 3, 7, 9, 11-14 | Blocks: 16-24
  References (executor has NO interview context - be exhaustive): `src/state-projection.ts#buildCurrentState`; `src/task-timeline.ts#context`; `src/dashboard/read-model.ts`; `src/canonical.ts`; Linux Second Brain worktree `sb/search.py`; LongMemEval dimensions.
  Acceptance criteria (agent-executable): configurable fixed budgets cap item count/excerpt/total bytes; snapshot records all included/excluded/conflicting/stale/`no_data` sources; same inputs/clock produce same digest; absent critical Linux live evidence or no-data memory yields `insufficient`/abstention-ready status without consulting Mac files.
  QA scenarios (name the exact tool + invocation): happy: assemble a “what now?” fixture with confirmed priority principle and fresh work state; failure: prompt-injected page, contradictory priority, stale task, sensitive unrelated memory, budget overflow, and source outage are surfaced without instruction execution, Evidence `<attemptDir>/task-15-jarvis-personal-operating-system.json`.
  Recommended task executor category: `deep`
  Commit: Y | `feat(context): assemble cited personal operating snapshots`

- [x] 16. Enforce freshness, trust, conflict, and abstention policy
  What to do / Must NOT do: Add `src/context-policy.ts` implementing deterministic rules for source maximum age, user-confirmed vs inferred memory, conflicting/superseded facts, required evidence classes, low-confidence exclusions, and explicit abstention reasons; policy reads todo 3 config and returns structured decisions. Must NOT ask a model to decide whether evidence is trusted or silently choose newest when valid-time semantics conflict.
  Parallelization: Wave 3 | Blocked by: 3, 11, 12, 15 | Blocks: 17-24
  References (executor has NO interview context - be exhaustive): `config/personal-os-policy.json`; Linux Second Brain worktree `sb/conflict.py` and `sb/contracts.py`; `src/negative-evidence.ts`; `docs/pre-gjc-shadow.md`.
  Acceptance criteria (agent-executable): exhaustive Linux policy tests cover supports/contradicts/supersedes/unrelated, `no_data`/stale/offline/unavailable, confirmed/inferred, source clock skew, and required-evidence absence; policy returns stable codes and Mac cannot override abstention.
  QA scenarios (name the exact tool + invocation): happy: current live fact plus confirmed principle is eligible; failure: two unresolved priorities, stale-only status, poisoned memory, or missing owner decision forces abstention, Evidence `<attemptDir>/task-16-jarvis-personal-operating-system.json`.
  Recommended task executor category: `unspecified-high`
  Commit: Y | `feat(context): enforce trust and abstention policy`

- [x] 17. Implement confirmed-principle retrieval and deterministic prioritization
  What to do / Must NOT do: Add `src/priority-engine.ts` that retrieves only user-confirmed principles and ranks candidate actions with a documented lexicographic policy: owner/safety gate, customer impact, deadline bucket, dependency blocking, irreversible risk, then effort/cost; return rationale and evidence links. A model may phrase the explanation only after ranking. Must NOT use opaque model ranking, hidden numeric weights, unconfirmed personality inference, or optimize self-project work ahead of confirmed customer obligations.
  Parallelization: Wave 3 | Blocked by: 2, 9, 12, 15, 16 | Blocks: 18-25
  References (executor has NO interview context - be exhaustive): synthetic confirmed-principle fixture plus cited Linux Second Brain MCP evidence after owner-gated import; `system/jarvis-purpose.md` memory projection; `src/team-proposal.ts`; `src/capabilities.ts`; `ORCA_MASTER_CHARTER.md`.
  Acceptance criteria (agent-executable): table-driven scenarios are stable across model and Mac absence; `no_data` abstains from memory-dependent ranking; customer-critical work outranks self-development when actionable; owner-gated work is surfaced rather than executed; every ranked action cites Linux policy/current evidence.
  QA scenarios (name the exact tool + invocation): happy: customer deadline outranks running self-project while non-blocking worker work remains delegated; failure: unconfirmed principle, tie with insufficient evidence, stale deadline, and model disagreement cannot alter deterministic order, Evidence `<attemptDir>/task-17-jarvis-personal-operating-system.json`.
  Recommended task executor category: `ultrabrain`
  Commit: Y | `feat(priority): rank actions from confirmed principles`

- [ ] 18. Persist and project evidence-backed recommendations
  What to do / Must NOT do: Add `src/recommendations.ts` for recommendation creation/expiry/supersession, action status, evidence links, approval requirement, confidence class, omissions, and canonical digest; extend `src/state-projection.ts`, TaskTimeline, and public exports without changing authority. Must NOT mutate work from a recommendation or treat an expired recommendation as executable.
  Parallelization: Wave 3 | Blocked by: 7, 9, 13-17 | Blocks: 19-25, 31
  References (executor has NO interview context - be exhaustive): `src/state-projection.ts`; `src/task-timeline.ts`; `src/control-plane.ts`; `src/index.ts`; `tests/integration/task-timeline.test.ts`; `tests/integration/dashboard-read.test.ts`.
  Acceptance criteria (agent-executable): recommendation lifecycle is pending→accepted/rejected/expired/superseded with immutable evidence digest; projections show ranked next actions, needed decisions, conflicts, and stale warnings; no control command exists until todo 25 stages one.
  QA scenarios (name the exact tool + invocation): happy: create and project three ranked actions with one owner decision; failure: expired snapshot, changed evidence digest, duplicate recommendation, and direct execute attempt fail closed, Evidence `<attemptDir>/task-18-jarvis-personal-operating-system.json`.
  Recommended task executor category: `unspecified-high`
  Commit: Y | `feat(recommendations): project evidence-backed next actions`

- [ ] 19. Build the longitudinal context and memory evaluation harness
  What to do / Must NOT do: Add fixed synthetic/private-safe datasets under `test/fixtures/personal-os/`, `tests/longitudinal/` suites, and `scripts/personal-os-eval.mjs` covering information extraction, multi-session reasoning, temporal reasoning, knowledge updates, abstention, conflict resolution, stale live state, and deletion; produce machine-readable metrics separated into task quality, memory precision/recall, stale-state usage, and safety. Must NOT copy real personal content into Git or grade prose wording.
  Parallelization: Wave 4 | Blocked by: 12, 15-18 | Blocks: 20-24, 36
  References (executor has NO interview context - be exhaustive): LongMemEval `https://arxiv.org/abs/2410.10813`; Linux Second Brain tests `test_search.py` and `test_conflict.py`; `tests/integration/negative-evidence.test.ts`.
  Acceptance criteria (agent-executable): deterministic Linux fixture generations cover no-data boot, transfer integrity, tombstone-on-restore, and Mac disconnect; benchmark emits stable counts/rates; thresholds remain memory precision≥0.85, recall≥0.80, temporal accuracy≥0.90, stale/no-data abstention=1.00, unauthorized/approval-bypass/duplicate/stale-authoritative/deletion-leak effects=0.
  QA scenarios (name the exact tool + invocation): happy: updated fact supersedes old and temporal query cites correct session; failure: stale-only, conflicting, deleted, injected, and unrelated-memory cases abstain or exclude exactly, Evidence `<attemptDir>/task-19-jarvis-personal-operating-system.json`.
  Recommended task executor category: `deep`
  Commit: Y | `test(personal-os): add longitudinal evaluation corpus`

- [ ] 20. Implement durable Daily Control Loop scheduling
  What to do / Must NOT do: Add `src/daily-control-loop.ts` and Linux microloop integration for morning 07:15 Asia/Seoul, event-driven in-day reconcile, evening 21:30, quiet hours 22:00-07:00, leases/fences/checkpoints/deadlines/budgets, missed-run recovery, and exactly-once logical identity; add hardened Linux `jm-second-brain-refresh.service` plus enabled `jm-second-brain-refresh.timer` at 07:00 KST with `Persistent=true`; subscribe to refresh completion and never invoke the pipeline from JARVIS. The old Mac automation `960f1c65-7f57-47e3-88f5-80bc5964ee7e` is not a production dependency and remains untouched.
  Parallelization: Wave 4 | Blocked by: 7-9, 12, 15-19 | Blocks: 23-24, 31, 36
  References (executor has NO interview context - be exhaustive): `src/microloops.ts`; `src/loopgraph.ts`; `src/live-supervisor.ts`; `src/service.ts`; Linux user-systemd units; `tests/integration/microloops.test.ts`.
  Acceptance criteria (agent-executable): injected KST tests prove one run per key, missed recovery once, no overlap, quiet-hour deferral, critical bypass, restart continuation, `no_data`/failed/capped refresh degradation, and Linux operation while Mac is off.
  QA scenarios (name the exact tool + invocation): happy: morning→in-day→evening fixture completes with three correlated run records; failure: crash after claim, clock rollback/DST, duplicate service, stale fence, and unavailable Second Brain produce deterministic retry/degrade without duplicate side effects, Evidence `<attemptDir>/task-20-jarvis-personal-operating-system.json`.
  Recommended task executor category: `deep`
  Commit: Y | `feat(loop): schedule durable daily control runs`

- [ ] 21. Generate the cited morning operating brief
  What to do / Must NOT do: Add `src/morning-brief.ts` on Linux to subscribe before the 07:00 refresh, wait only until 07:20, then assemble/rank NOW/BLOCKED/DECISIONS/NEXT 3/WORKERS/RISKS, show `no_data`/stale/unavailable sources and why, and persist one recommendation set plus notification intent. Must NOT depend on Mac automation, hide missing sources, claim completion without evidence, or auto-stage work.
  Parallelization: Wave 4 | Blocked by: 7-9, 12, 15-18, 20 | Blocks: 23, 31-32, 36
  References (executor has NO interview context - be exhaustive): `src/state-projection.ts`; Linux Second Brain worktree `sb/briefing.py`; Linux refresh state; `ORCA_MASTER_CHARTER.md`; `src/recommendations.ts`.
  Acceptance criteria (agent-executable): deterministic fixture emits all required sections and at most three cited actions; non-capped same-date refresh is fresh; capped/failed/previous-date/no-data at 07:20 yields an honest degraded brief; identical inputs yield identical digest.
  QA scenarios (name the exact tool + invocation): happy: customer task/owner decision/running workers produce correct order; failure: capped SB run, offline jm-server, conflicting priority, and empty day yield honest warnings/placeholders rather than fabricated content, Evidence `<attemptDir>/task-21-jarvis-personal-operating-system.md`.
  Recommended task executor category: `unspecified-high`
  Commit: Y | `feat(briefing): generate cited morning operations`

- [ ] 22. Implement the in-day decision queue and notification policy
  What to do / Must NOT do: Add Linux `src/notification-intents.ts` and event subscriptions that create, redact, persist, and deduplicate decision intents only for meaningful state/source changes; classify info/action/critical, apply quiet hours/rate limits/expiry, and deep-link to a stable Linux resource. Mac receives already-redacted intents for native delivery only. Must NOT execute from a notification, let Mac mint/persist intent authority, include sensitive context, repeat unchanged state, or poll.
  Parallelization: Wave 4 | Blocked by: 7-9, 12, 15-18 | Blocks: 23, 30-31, 36
  References (executor has NO interview context - be exhaustive): `src/dashboard/events.ts#ReconcileHub`; `src/microloops.ts`; `src/dashboard/redaction.ts`; `config/personal-os-policy.json`; `dashboard/src/store-sse.test.ts`.
  Acceptance criteria (agent-executable): exact event subscriptions are installed before triggers; stable dedup keys suppress repeats; info defers, action queues, critical bypasses quiet hours; payload contains only redacted title/category/resource ID/deep link and no authority token.
  QA scenarios (name the exact tool + invocation): happy: new owner decision emits one action intent and changed critical risk emits one immediate intent; failure: unchanged reconcile, secret-bearing title, expired decision, quiet-hour info, and replayed event suppress/fail exactly, Evidence `<attemptDir>/task-22-jarvis-personal-operating-system.json`.
  Recommended task executor category: `unspecified-high`
  Commit: Y | `feat(notifications): queue redacted decision intents`

- [ ] 23. Implement the evening closeout and continuity record
  What to do / Must NOT do: Add Linux `src/evening-closeout.ts` to summarize verified completions, failed/incomplete reasons, new decisions, memory candidates, tomorrow's first action, and unresolved risks; persist a signed/canonical continuity artifact and enqueue only eligible candidate IDs. Closeout remains valid in `no_data`/offline mode. Must NOT convert prose into completion, write directly to Second Brain, require Mac, or discard failed work.
  Parallelization: Wave 4 | Blocked by: 8-9, 18, 20-22 | Blocks: 31-32, 36
  References (executor has NO interview context - be exhaustive): `src/task-timeline.ts`; `src/negative-evidence.ts`; `src/state-projection.ts`; Linux Second Brain worktree `sb/briefing.py`; `ORCA_MASTER_CHARTER.md`.
  Acceptance criteria (agent-executable): closeout contains evidence refs for every completion, explicit reason for every open/failed item, tomorrow-first-action or `none`, candidate IDs rather than direct writes, and stable digest linked to the daily run.
  QA scenarios (name the exact tool + invocation): happy: one verified completion/one blocked/one owner decision yields a complete closeout; failure: worker “done” without artifact, verification conflict, duplicate closeout, and crash before persistence cannot mark the day complete, Evidence `<attemptDir>/task-23-jarvis-personal-operating-system.md`.
  Recommended task executor category: `unspecified-high`
  Commit: Y | `feat(closeout): persist verified daily continuity`

- [ ] 24. Add personal operating read APIs and projections
  What to do / Must NOT do: Extend dashboard contracts/read model/routes/SSE topics for Today, recommendation details, context evidence, daily run history, decision inbox, notification states, and source health; use bounded pagination/redaction and preserve current API compatibility. Must NOT expose raw memory bodies, passkey data, internal paths, or mutation through read routes.
  Parallelization: Wave 4 | Blocked by: 7-9, 18, 20-23 | Blocks: 31, 36
  References (executor has NO interview context - be exhaustive): `src/dashboard/contracts.ts`; `src/dashboard/read-model.ts`; `src/dashboard/read-routes.ts`; `src/dashboard/sse-route.ts`; `src/dashboard/events.ts`; `tests/integration/dashboard-read.test.ts`; `tests/integration/dashboard-sse.test.ts`.
  Acceptance criteria (agent-executable): versioned JSON fixtures cover all new resources; GETs are bounded/redacted and return source freshness/conflicts/omissions; SSE invalidation refetches only affected resources; old overview/task/agent/approval contracts remain passing.
  QA scenarios (name the exact tool + invocation): happy: hydrate Today then receive recommendation/decision reconcile; failure: unknown ID, oversize page, secret-bearing evidence, stale session, and malformed cursor return stable safe errors, Evidence `<attemptDir>/task-24-jarvis-personal-operating-system.json`.
  Recommended task executor category: `unspecified-high`
  Commit: Y | `feat(api): expose personal operating projections`

- [ ] 25. Stage one approved recommendation as one worker workflow
  What to do / Must NOT do: Extend control actions and `src/recommendation-executor.ts` so accepting a recommendation stages an exact `workflow.start` request with recommendation/context/evidence digests, target, budget, deadline, idempotency key, and requested-by principal; reuse `planTeamProposal`, `ControlPlane`, and `ApprovedCommandExecutor`. Must NOT dispatch on recommendation creation, accept stale evidence, create duplicate primary executors, or let the model choose authority level.
  Parallelization: Wave 5 | Blocked by: 2, 7-9, 17-18 | Blocks: 26, 31, 36
  References (executor has NO interview context - be exhaustive): `src/team-proposal.ts`; `src/dashboard/command-service.ts`; `src/control-actions.ts`; `src/control-plane.ts`; `src/approved-executor.ts`; `src/loopgraph.ts`; `tests/integration/dashboard-task-create.test.ts`.
  Acceptance criteria (agent-executable): same recommendation/action/context digest stages exactly one request; expired/superseded recommendation refuses; receipt binds exact target/args/budget/deadline; no Orca/GJC call occurs before claim of valid approved command.
  QA scenarios (name the exact tool + invocation): happy: approve one recommendation and observe one pending→approved→claimed workflow; failure: changed evidence, duplicate click, stale receipt, unapproved request, and conflicting active executor all fail closed, Evidence `<attemptDir>/task-25-jarvis-personal-operating-system.json`.
  Recommended task executor category: `deep`
  Commit: Y | `feat(orchestration): stage approved recommendations`

- [ ] 26. Correlate dispatch, signed progress, independent verification, and recovery
  What to do / Must NOT do: Extend workflow nodes/runtime so one approved recommendation correlates task/proposal/dispatch/terminal/worktree/session/incarnation/progress/verification/evidence IDs; use event-driven monitoring, leases/fences, uncertain-send blocking, bounded retries, cancellation, negative evidence, and independent verifier settlement. Must NOT poll by fixed sleeps, declare completion from idle/prompt return, retry an uncertain non-idempotent send, or use the implementer's self-review as approval.
  Parallelization: Wave 5 | Blocked by: 2, 7-9, 18, 25 | Blocks: 27, 31, 36
  References (executor has NO interview context - be exhaustive): `src/loopgraph.ts`; `src/live-supervisor.ts`; `src/progress-signal.ts`; `src/orca-resume.ts`; `src/microloops.ts`; `src/negative-evidence.ts`; `tests/integration/live-vertical-recovery.test.ts`; `tests/integration/worker-crash-idempotency.test.ts`.
  Acceptance criteria (agent-executable): fixture proves exactly one executor, signed fresh progress, separate verifier, artifact/test evidence, one terminal settlement, and restart recovery; ambiguous/uncertain states remain blocked and visible.
  QA scenarios (name the exact tool + invocation): happy: worker completes, verifier passes, workflow settles and emits candidate inputs; failure: crash after send, replayed progress, wrong incarnation, verifier reject, duplicate worker_done, and cancellation race each recover/fail exactly once, Evidence `<attemptDir>/task-26-jarvis-personal-operating-system.json`.
  Recommended task executor category: `deep`
  Commit: Y | `feat(orchestration): verify and recover recommendation work`

- [ ] 27. Classify verified memory candidates and confirmation requirements
  What to do / Must NOT do: Add `src/memory-candidates.ts` to create candidates only from explicit user instructions, verified outcomes, approved decisions, or labeled inferences; assign sensitivity, confidence, purpose, retention, source refs, content digest, dedup key, required confirmation, and expiry from policy. Must NOT persist arbitrary transcript text, agent claims, secrets, transient runtime state, or inferred personal traits as confirmed facts.
  Parallelization: Wave 5 | Blocked by: 2, 3, 8-9, 17-18 | Blocks: 28-30, 32, 36
  References (executor has NO interview context - be exhaustive): `config/personal-os-policy.json`; `src/negative-evidence.ts`; `src/task-timeline.ts`; Linux Second Brain worktree `sb/contracts.py` and `sb/conflict.py`.
  Acceptance criteria (agent-executable): exhaustive policy tests map input class/sensitivity/confidence to auto-stage/confirm/reject; classification may run in `no_data`, but delivery remains pending with `SECOND_BRAIN_NO_DATA`; same source/content dedups; conflicts do not overwrite; rejected/expired candidates cannot be written.
  QA scenarios (name the exact tool + invocation): happy: verified technical outcome auto-stages and sensitive inferred preference requests confirmation; failure: secret, raw transcript, worker assertion, duplicate, unresolved contradiction, and expired candidate reject, Evidence `<attemptDir>/task-27-jarvis-personal-operating-system.json`.
  Recommended task executor category: `ultrabrain`
  Commit: Y | `feat(memory): classify traceable memory candidates`

- [ ] 28. Extend Second Brain with idempotent write-request contracts
  What to do / Must NOT do: In the Linux Second Brain task worktree and fixture generation, add `sb/write_requests.py` and extend inbox/MCP contracts with candidate ID, operation (`remember|correct|forget|export`), expected prior source/version/digest, purpose, sensitivity, retention, JARVIS receipt digest, and idempotency key; write collision-safe request files only, leaving Linux compile/reindex ownership intact. Must NOT use the Mac production vault, expose arbitrary writes/deletes, trust receipt prose, or settle on inbox write alone.
  Parallelization: Wave 5 | Blocked by: 6, 9, 11-12, 27 | Blocks: 29-30, 32, 36
  References (executor has NO interview context - be exhaustive): Linux Second Brain worktree `sb/mcp.py`, `sb/inbox.py`, `sb/contracts.py`, `sb/compile.py`, `tests/test_mcp.py`, and `tests/test_connectors_inbox.py`.
  Acceptance criteria (agent-executable): repeated identical request returns same candidate/request identity; conflicting key/digest rejects; invalid receipt/operation/path/sensitivity rejects; live vault remains untouched in unit tests; MCP fixture digest is updated atomically in both repos.
  QA scenarios (name the exact tool + invocation): happy: remember/correct/forget/export fixture requests enter inbox once; failure: path escape, stale expected digest, forged receipt, duplicate key with changed body, and direct-delete attempt fail, Evidence `<attemptDir>/task-28-jarvis-personal-operating-system.json`.
  Recommended task executor category: `unspecified-high`
  Commit: Y | atomic commits: `feat(inbox): accept traceable memory requests` and `feat(second-brain): support write request contract`

- [ ] 29. Implement the cross-repository memory outbox saga
  What to do / Must NOT do: Add Linux `src/memory-outbox.ts` and an approved action that claims a candidate with fence, sends the exact stdio request once, records uncertain outcomes, reconciles through recent changes/page/source digest, retries only safe pre-dispatch states, and settles only after observing the expected Linux artifact/tombstone/export. Must NOT invoke refresh, mark success from exit, replay uncertain writes, use Mac, or delete audit trail.
  Parallelization: Wave 5 | Blocked by: 8-9, 12, 27-28 | Blocks: 30, 32, 36
  References (executor has NO interview context - be exhaustive): `src/approved-executor.ts`; `src/control-plane.ts`; `src/orca-resume.ts`; `src/negative-evidence.ts`; Linux Second Brain worktree `sb/mcp.py#sb_recent_changes` and `sb/inbox.py`.
  Acceptance criteria (agent-executable): two workers and restart produce one logical request; uncertain response remains reconciling; observed expected digest settles once; mismatch opens conflict/failed state; artifact observation has a configurable deadline (30s in tests, 10 minutes in runtime defaults), after which `RECONCILE_TIMEOUT` leaves the row in `reconciling` and never `settled` or silently dropped; all transitions are auditable and receipt-bound.
  QA scenarios (name the exact tool + invocation): happy: candidate→approved→sent→observed→settled across fixture process restart; failure: crash before/after write, lost response, duplicate delivery, changed source, compile failure, and offline MCP preserve exactly-once semantics, Evidence `<attemptDir>/task-29-jarvis-personal-operating-system.json`.
  Recommended task executor category: `deep`
  Commit: Y | `feat(memory): reconcile approved Second Brain writes`

- [ ] 30. Implement correction, forgetting, export, and deletion propagation
  What to do / Must NOT do: Add Linux Second Brain `sb/erasure.py` plus Linux JARVIS reconciliation so correction supersedes prior content, forgetting removes content from active pages/retrieval/lexical/vector/brief/cache/export surfaces, exports land only under `/home/jm/.local/state/second-brain/exports/<request-id>`, and a non-content tombstone proves disposition. Restore creates a new generation and reapplies tombstones before activation. Must NOT rewrite history, retain deleted content, reveal unrelated memories, reverse schemas, write back to Mac, or undo without a new receipt.
  Parallelization: Wave 5 | Blocked by: 2, 3, 8-9, 12, 22, 27-29 | Blocks: 32, 35-36
  References (executor has NO interview context - be exhaustive): Linux Second Brain worktree `sb/search.py`, `sb/hybrid_search.py`, `sb/compile.py`, and `sb/store/`; `src/task-timeline.ts`; GDPR Articles 16/17.
  Acceptance criteria (agent-executable): correction queries return only superseding fact with history marker; forgotten sentinel is absent from page/search/vector/daily/export/cache while tombstone contains no content; export scope matches requested source/sensitivity/time bounds; retries are idempotent.
  QA scenarios (name the exact tool + invocation): happy: remember→correct→forget sentinel and verify every surface; failure: stale correction, unauthorized export, partial reindex, locked file, crash mid-delete, and duplicate forget resume to safe reconciled state, Evidence `<attemptDir>/task-30-jarvis-personal-operating-system.md`.
  Recommended task executor category: `deep`
  Commit: Y | atomic commits: `feat(memory): propagate correction and erasure` in both repos

- [ ] 31. Build the Today and decision-inbox control surface
  What to do / Must NOT do: Add routed Today UI as a Mac/browser client of Linux APIs so the landing page shows NOW/BLOCKED/DECISIONS/NEXT 3/WORKERS/RISKS, citations, freshness, conflicts, unavailable sources, notification state, and receipt-bound controls. Linux validates acceptance, receipts, SSE settlement, and all state changes. Must NOT display hidden scores/raw private content, treat client cache as current, create browser/Mac authority, or fall back to a local AuthorityDb.
  Parallelization: Wave 6 | Blocked by: 4-5, 9, 18, 20-26 | Blocks: 33-34, 36
  References (executor has NO interview context - be exhaustive): `dashboard/src/root.tsx`; `dashboard/src/operational-shell.tsx`; `dashboard/src/store.ts`; `dashboard/src/authority-controls.tsx`; `dashboard/src/pages/approvals-page.tsx`; `dashboard/DESIGN.md`; `src/dashboard/contracts.ts`; todo 24 APIs.
  Acceptance criteria (agent-executable): desktop and 40rem layouts expose all required sections/accessibility names; citations/freshness/conflicts are keyboard reachable; accept stages exact request once; rejected/expired/superseded updates remove controls immediately; zero React warnings.
  QA scenarios (name the exact tool + invocation): happy: Playwright hydrates morning brief, opens evidence, accepts one action, observes SSE settlement; failure: offline source, expired recommendation, stale receipt, duplicate click, malformed API, and CJK long text remain accessible/fail safe, Evidence `<attemptDir>/task-31-jarvis-personal-operating-system/` screenshots+trace.
  Recommended task executor category: `visual-engineering`
  Commit: Y | `feat(dashboard): add Today decision surface`

- [ ] 32. Build the Memory search, conflict, correction, and privacy surface
  What to do / Must NOT do: Add Memory UI as a Mac/browser client of Linux authority APIs; show bounded search/detail/conflict/candidate/export/forget state, provenance, sensitivity, retention, and history; Linux binds confirmation/receipt and the Linux provider executes mutations. Must NOT expose vault browsing/paths, secrets, deleted content, embeddings, client-side mutation execution, or Mac filesystem access.
  Parallelization: Wave 6 | Blocked by: 4-6, 9, 21-23, 27-30 | Blocks: 36
  References (executor has NO interview context - be exhaustive): `dashboard/src/pages/approvals-page.tsx`; `dashboard/src/authority-api.ts`; `dashboard/src/api-mutations.ts`; `src/dashboard/authority-service.ts`; todos 27-30; Linux Second Brain MCP contract.
  Acceptance criteria (agent-executable): UI searches fixture memories, exposes provenance/conflicts, confirms/rejects candidates, and stages correction/forget/export once; sensitive values are redacted until permitted; deleted sentinel never renders; responsive/accessibility/CJK tests pass without warnings.
  QA scenarios (name the exact tool + invocation): happy: search→inspect citation→correct→observe superseded result→forget; failure: unauthorized sensitive read, stale digest, duplicate mutation, offline MCP, deleted result, and keyboard-only flow behave safely, Evidence `<attemptDir>/task-32-jarvis-personal-operating-system/` screenshots+trace.
  Recommended task executor category: `visual-engineering`
  Commit: Y | `feat(dashboard): add user-controlled memory surface`

- [ ] 33. Add redacted native notifications and Electron deep links
  What to do / Must NOT do: Extend the Mac Electron client to receive Linux-originated already-redacted notification intents, use macOS native notifications, register a private deep link/open-existing-instance flow, resolve resource IDs through Linux APIs, acknowledge delivery idempotently, and respect Linux-computed quiet hours/expiry. Linux persists undelivered intents so Mac disconnect is harmless. Must NOT run a Mac scheduler/queue/authority or embed tokens, excerpts, commands, or sensitive names.
  Parallelization: Wave 6 | Blocked by: 3, 7, 9, 31 | Blocks: 34, 36
  References (executor has NO interview context - be exhaustive): `scripts/lib/electron-shell.mjs`; `scripts/lib/package-electron-app.mjs`; `scripts/package-electron.mjs`; todo 22 notification contracts; `src/dashboard/redaction.ts`; `tests/integration/open-electron.test.ts`.
  Acceptance criteria (agent-executable): one intent produces one OS notification, duplicate/replay is suppressed, deep link focuses existing app at exact safe route, quiet/expired intents do not notify, and payload inspection finds no prohibited fields.
  QA scenarios (name the exact tool + invocation): happy: emit decision intent, click notification, observe Today decision; failure: malformed/deleted resource, second instance, secret-bearing payload, quiet-hour info, replay, and offline app fail/suppress safely, Evidence `<attemptDir>/task-33-jarvis-personal-operating-system.md` plus screenshots.
  Recommended task executor category: `unspecified-high`
  Commit: Y | `feat(electron): deliver redacted decision notifications`

- [ ] 34. Add a tailnet-only authenticated phone gateway
  What to do / Must NOT do: Add Linux `src/phone-gateway.ts`, `src/phone-gateway-main.ts`, `src/dashboard/phone-session.ts`, and `deploy/jm-jarvis-phone-gateway.service`; bind the Linux gateway to `127.0.0.1:4174`, prepare owner-gated `tailscale serve --https=443 http://127.0.0.1:4174` (never Funnel), accept identity headers only from loopback proxy and exact owner login, proxy bounded APIs to Linux `127.0.0.1:4173`, establish secure session/CSRF boundaries, and enforce origin/host/TLS/rate limits. Mac and phone are clients; no production Mac `.plist` or gateway exists. Must NOT rebind authority, trust non-loopback headers, expose terminal/raw memory, or provide public access.
  Parallelization: Wave 6 | Blocked by: 2-3, 7-9, 25-26, 31, 33 | Blocks: 36
  References (executor has NO interview context - be exhaustive): `src/dashboard/server.ts`; `src/dashboard/request-boundary.ts`; `src/dashboard/session.ts`; `src/dashboard/portfolio-auth.ts`; `deploy/jm-jarvis-dashboard.service`; Linux user-systemd units; todo-14-corrected `docs/dual-environment-monitoring.md` only; Tailscale Serve identity header `Tailscale-User-Login`.
  Acceptance criteria (agent-executable): socket tests prove authority and gateway remain separate loopback listeners; generated Tailscale Serve config is tailnet-only/no Funnel; gateway accepts identity headers only from loopback and only for the configured owner; spoofed/missing identity, wrong Host/Origin, non-loopback peer, rate excess, and raw-terminal route reject; release/rollback definitions remain isolated.
  QA scenarios (name the exact tool + invocation): happy: authenticated tailnet browser loads read-only Today/Memory redacted views; failure: LAN/public/spoofed principal, copied CSRF, forbidden route, TLS downgrade, and gateway outage cannot mutate or expose authority, Evidence `<attemptDir>/task-34-jarvis-personal-operating-system.md`.
  Recommended task executor category: `deep`
  Commit: Y | `feat(gateway): expose private authenticated phone access`

- [ ] 35. Bind remote approvals to WebAuthn and existing ControlPlane receipts
  What to do / Must NOT do: Add Linux `src/remote-approval.ts` and `src/dashboard/remote-auth-routes.ts` plus client `dashboard/src/pages/security-page.tsx`; Linux stores challenges/credentials, verifies command hash/action/target/args/principal/origin/RP ID/nonce/issued/expiry and UV, and mints/submits the existing ControlPlane receipt exactly once. Mac/phone only perform WebAuthn client ceremonies and native QA. Must NOT treat tailnet/session/CSRF as approval, store private keys/biometrics, verify or mint receipts on Mac, allow multi-user enrollment, or create a parallel executor.
  Parallelization: Wave 6 | Blocked by: 2-3, 7-9, 30, 33 | Blocks: 36
  References (executor has NO interview context - be exhaustive): `src/control-plane.ts#CommandApprovalReceipt`; `src/receipt.ts`; `src/dashboard/authority-validation.ts`; `src/dashboard/authority-service.ts`; todo 8 remote-auth schema; WebAuthn Level 3/RFC 6454 origin rules.
  Acceptance criteria (agent-executable): registered credential signs exact challenge; valid assertion yields one approved/rejected decision through ControlPlane; wrong command/origin/RP/principal, expired/replayed challenge, revoked credential, missing UV, counter regression, and cloned assertion fail closed and audit.
  QA scenarios (name the exact tool + invocation): happy: Playwright creates a virtual authenticator through CDP `WebAuthn.enable` + `WebAuthn.addVirtualAuthenticator`, enrolls it, approves one staged recommendation, and observes the executor claim; failure: modify one arg after challenge, replay assertion, wrong owner, expired challenge, revoked passkey, counter regression, and gateway-only session cannot approve. Real Touch ID is explicitly outside this automated gate and is labeled separately in evidence, Evidence `<attemptDir>/task-35-jarvis-personal-operating-system.json`.
  Recommended task executor category: `deep`
  Commit: Y | `feat(authority): require passkey for remote approval`

- [ ] 36. Prove 24-hour operation, recovery, release, and operator handoff
  What to do / Must NOT do: Integrate Linux retention/SLO metrics, immutable JARVIS/Second Brain release manifests, generated hardened systemd units, backup/restore logic, Linux gateway artifacts, Mac Electron client packaging, and operations/disaster-recovery/release docs plus `scripts/personal-os-release-rehearsal.mjs`. Retire `docs/control-center-release.md` and stale Mac sections of `docs/jm-control-center-release.md` as historical/non-executable, or replace them with Linux authority release procedures; do not cite them as executable inputs until corrected. Rehearse only: fixture baseline → build/checksummed JARVIS release under an isolated mirror of `/home/jm/.local/state/orca-jarvis/authority/releases/<sha>` → generate unit pointing to `authority/current` → backup/check `jarvis.sqlite` → migrate a cloned DB → activate isolated current symlink → `db quick_check`, `jarvis doctor --json`, service/status, dashboard health, scheduler/lease, MCP handshake, and uncertain-outbox gates → no-data/Mac-disconnect proof → optional fixture simulation of transfer/restore gates → rollback rehearsal → Mac/phone client QA. Must NOT activate production, run live migrations, consume personal-data gates, push/merge, sign, notarize, or change live units/symlinks.
  Parallelization: Wave 7 final | Blocked by: 1-35 | Blocks: F1-F4
  References (executor has NO interview context - be exhaustive): corrected Linux-only release/monitoring docs; `scripts/publish-control-center-release.mjs`; Linux deployment files/units; current live unit only as read-only migration evidence; Linux Second Brain generation procedures; all prior evidence. Any old `/Volumes/DevSpace`, LaunchAgent, `launchctl`, or Local-Mac/master-runtime command is historical and non-executable.
  Acceptance criteria (agent-executable): release manifest/checksums and generated unit use exact immutable authority paths; current live worktree-based unit migration is rehearsed but not applied; cloned-DB migration and health gates pass; Linux JARVIS/Second Brain suites, E2E, no-data/Mac-disconnect, backup→destroy-fixture→new-generation restore with tombstone replay, restart/missed-loop, rollback, phone, and Mac client QA all pass. Rollback switches JARVIS `authority/current` only when the previous release schema/provider compatibility ranges accept the current DB/provider; otherwise the newer authority binary remains and the affected capability enters typed unavailable. Production activation/personal transfer are skipped and evidence reports zero unauthorized/duplicate/stale-authoritative/deletion-leak events.
  QA scenarios (name the exact tool + invocation): happy: Linux `node scripts/personal-os-release-rehearsal.mjs --fixture test/fixtures/personal-os/full-loop.json --clock 2026-08-27T07:15:00+09:00 --release-root <attemptDir>/authority --json` emits `PERSONAL_OS_REHEARSAL_OK` after isolated release/current activation, cloned-DB migration, no-data boot, brief→virtual approval→worker→verification→fixture artifact→closeout→restart while Mac is disconnected; then Mac client QA targets Linux. Failure scenarios include `second-brain-no-data`, `second-brain-offline`, `mac-disconnected`, `schema-incompatible-rollback`, `jm-server-offline`, `crash-after-dispatch`, `lost-memory-response`, `expired-passkey`, `delete-sentinel`, `restore-tombstone`, and `rollback`, each with no live path mutation and authority bypass/data loss 0, Evidence `<attemptDir>/task-36-jarvis-personal-operating-system/`.
  Recommended task executor category: `unspecified-high`
  Commit: Y | `docs(operations): prove personal OS release and recovery`

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit
  Verify every Must have/Must NOT, todo, artifact, dependency, and cross-repo commit plus the host-ownership matrix; inspect Linux runtime/service/database/scheduler/gateway/backup/release artifacts separately from Mac client/package/native-QA artifacts. APPROVE only with 36/36 rows, no unexplained scope change, and no Mac production authority/runtime path.
  Evidence: `<attemptDir>/final-F1-plan-compliance.md`
  Recommended task executor category: `unspecified-high`
- [ ] F2. Code quality review
  Independently review Linux backend/migrations/idempotency/fencing/subprocess/env/service hardening/Second Brain generation switching/tombstone restore/no direct vault access, then separately review Mac Electron packaging/native notifications/deep links/client tests. Run all type/lint/test/build gates and APPROVE only with change-caused errors/warnings 0.
  Evidence: `<attemptDir>/final-F2-code-quality.md`
  Recommended task executor category: `unspecified-high`
- [ ] F3. Real manual QA
  First use Linux authority, gateway, scheduler, real fixture MCP provider, isolated write generation, worker, backup/restore, restart, rollback, and Mac-disconnect surfaces. Then use the packaged Mac client, native notification/deep link, tailnet phone browser, and virtual passkey/Touch ID-labeled QA against Linux. Production-vault QA occurs only after transfer approval.
  Evidence: `<attemptDir>/final-F3-real-qa/`
  Recommended task executor category: `unspecified-high`
- [ ] F4. Scope fidelity
  Compare behavior/diffs to the user's purpose and host matrix: Linux JARVIS operates/manages while agents implement; Linux Second Brain remains provider-owned rather than duplicated; Mac is client/package/native-QA only; live state is measured and effects remain receipt-bound. Reject any Mac database/scheduler/gateway/worker/receipt minting/production vault/backup/release ownership, destructive rollback, invented remote, public/paid/surveillance/self-modifying/unverified connector scope.
  Evidence: `<attemptDir>/final-F4-scope-fidelity.md`
  Recommended task executor category: `unspecified-high`

## Commit strategy
- Use the Linux JARVIS and Second Brain task worktrees named above. Never commit current unrelated `AGENTS.md` or `.omo/senpi-task/` changes. Mac client/package work uses a separate paused-or-new Orca-managed client worktree and never lands authority state.
- Commit each green todo atomically using the exact message declared on its row; cross-repo todos produce one green atomic commit in each repository, linked by candidate/contract digest in evidence.
- If the second repository commit fails after the first repository commit succeeds, create a local revert commit in the first repository, record the orphan/revert state in evidence, and retry from two clean worktree heads; never push or leave a half-committed cross-repo pair.
- Before every commit run the narrow type/lint/test gate covering that todo. Before a dependent wave begins, run the combined affected-domain gate.
- Do not squash/fixup/amend/rebase/push/merge without explicit owner authorization. This handoff is direct/local only and never uses `--make-pr`, creates a PR, pushes, merges, ships, deploys/activates production, signs, or notarizes. Any later PR or activation is a separate user-authorized operation outside this execution.
- Port CLI-JAW/Electron code into the clean Linux worktree by exact commit/patch identity; use Mac only for read-only client patch recovery and packaging/native QA; never commit or clean the dirty Mac source worktree.

## Success criteria
- A fresh session can answer “지금 뭘 해야 해?” with at most three deterministically ranked actions, citations, source freshness, conflicts/omissions, and explicit abstention when evidence is insufficient.
- Linux `jm-second-brain-refresh.timer` runs one persistent 07:00 KST refresh; JARVIS subscribes and runs one 07:15 synthesis plus one 21:30 closeout with restart-safe leases/fences and a bounded 07:20 degradation deadline. Mac automation is not a production dependency.
- One approved recommendation creates one primary worker workflow, one correlated evidence chain, one independent verification outcome, and one terminal settlement; unauthorized, duplicate, replayed, stale, or uncertain effects remain zero.
- Verified outcomes create traceable memory candidates; cross-repo write settlement requires observing the expected cited artifact; sensitive/inferred memory requires confirmation.
- Correction/forget/export are user-controlled, receipt-bound, idempotent, and deletion tests prove the sentinel absent from active pages, lexical/vector search, daily briefs, caches, exports, and UI.
- Linux remains authoritative while packaged Mac Electron provides Today, Memory, approvals, native redacted notifications, and deep links as a client; settled controls disappear after Linux settlement and no local-authority fallback exists.
- Tailnet phone access is private and authenticated; read routes are bounded/redacted; remote mutation requires an exact single-use WebAuthn assertion translated into the existing ControlPlane receipt.
- Mail/calendar/messenger remain visibly `unavailable` until separately verified; no fabricated data or silent omission appears in briefs.
- Linux JARVIS and Second Brain full type/lint/test/build, longitudinal/security/recovery, no-data/Mac-disconnect, backup/restore, restart, immutable release, and rollback gates pass with measured counts; Mac packaged-client/native QA and phone QA pass afterward against Linux.
- Final F1-F4 reviewers all return APPROVE; no implementation is declared complete before the user explicitly accepts the final verification results.
