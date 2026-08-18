# PR Plan

## Dependency graph

```text
PR-001 capability matrix
  ├─> PR-002 proposal-only archetypes
  └─> PR-003 immutable negative evidence
```

## PR-001 — Capability matrix walking skeleton

- Risk: R2
- Execution type: SEQUENTIAL
- Related requirement: REQ-CAP-001
- Purpose: add typed capability facts through library, doctor, and CLI without breaking flat output
- Predecessors: none
- Successors: PR-002 and PR-003
- CREATE: `src/capabilities.ts`, `tests/unit/capabilities.test.ts`
- MODIFY: `src/doctor.ts`, `src/cli.ts`, `src/index.ts`, `tests/unit/doctor.test.ts`, `tests/integration/task-timeline.test.ts`
- FORBIDDEN: `migrations/001_authority.sql` through `migrations/027_control_execution_hardening.sql`, `src/approved-executor.ts`, `src/control-plane.ts`
- New symbols: contracts from `03-ARCHITECTURE-CONTRACTS.md`
- Change budget: 7 modified/created files, 0 migrations, at most 350 logical lines

### PR-001-SUB-001 — Pure capability evaluator

- CREATE: `src/capabilities.ts`, `tests/unit/capabilities.test.ts`
- READ_ONLY: `src/db.ts`, `src/live-supervisor.ts`, `src/gjc.ts`
- FORBIDDEN: migrations and executor files
- Steps:
  1. Add the exact capability interfaces and monotonic-stage validation.
  2. Add injected five-stage observations, version/protocol parsing, and fixed redacted evidence.
  3. Test healthy, missing, incompatible, and secret-bearing probe results.
- Verification: `npx vitest run tests/unit/capabilities.test.ts --no-file-parallelism`
- Expected exit: 0
- Expected result: all capability tests pass in one run.

### PR-001-SUB-002 — Doctor and CLI integration

- MODIFY: `src/doctor.ts`, `src/cli.ts`, `src/index.ts`, `tests/unit/doctor.test.ts`, `tests/integration/task-timeline.test.ts`
- READ_ONLY: `src/capabilities.ts`
- FORBIDDEN: migrations and executor files
- Steps:
  1. Add `capabilities: CapabilityMatrixV1` to `DoctorReport`.
  2. Append `matrix` to `capabilities --json` while retaining current fields.
  3. Export only read-only capability types and builders.
  4. Assert zero database changes around matrix construction.
- Verification: `npx vitest run tests/unit/capabilities.test.ts tests/unit/doctor.test.ts tests/integration/task-timeline.test.ts --no-file-parallelism`
- Expected exit: 0
- Expected result: existing flat fields and new matrix both pass.

## Known adjustment points

| # | Plan assumption | Why it may differ | Execution check |
|---|---|---|---|
| 1 | `AuthorityDb.gjcOperational()` remains the operational source | Method may be renamed before execution | Use LSP references on `gjcOperational` and adapt the call only |
| 2 | CLI capability object remains inline | Concurrent work may extract it | Use LSP symbols in `src/cli.ts` and integrate at the extracted location |

Where code differs, inspect it with LSP/read, adapt without asking, and report the adjustment. Stop only if the contract itself conflicts.

## AUTONOMOUS / MANUAL

- AUTONOMOUS: all implementation and verification in PR-001.
- MANUAL: N/A — no credentials, deployment, external service, or production mutation is required.

## Dispatch prompt — PR-001

```text
TASK: PR-001 — Add a read-only typed capability matrix.

DELIVERABLE:
- Changes limited to the PR-001 file list
- Verification output with exit codes
- Adjustment report, or "none"

SCOPE:
- Read docs/planning/02-REQUIREMENTS-ACCEPTANCE.md REQ-CAP-001 and docs/planning/03-ARCHITECTURE-CONTRACTS.md.
- Modify only PR-001 CREATE/MODIFY files.
- Do not modify migrations, approved execution, or control-plane authority.
- Keep all existing flat capability fields.
- Do not use host-dependent tests or expose probe stderr.
- If code differs, use LSP/read to adapt and report it; stop on contract contradiction.

VERIFY: npm run verify
Expected exit: 0. Expected: runtime check, lint, typecheck, 31+ test files, 146+ tests, acceptance, build, and smoke pass.
Report WORKING/BLOCKED.
```

## PR-002 — Capability-aware proposal-only archetypes

- Risk: R2
- Execution type: SEQUENTIAL
- Related requirement: REQ-TEAM-001
- Purpose: add deterministic interview and archetype proposal output without spawning or persistence
- Predecessor: PR-001
- Successors: none
- CREATE: `src/team-proposal.ts`, `tests/unit/team-proposal.test.ts`, `tests/integration/team-proposal-cli.test.ts`
- MODIFY: `src/cli.ts`, `src/index.ts`, `tests/integration/cli-help.test.ts`
- FORBIDDEN: all migrations, `src/approved-executor.ts`, `src/control-plane.ts`, `src/gjc.ts`, `src/orca-resume.ts`
- New symbols: team proposal contracts in `03-ARCHITECTURE-CONTRACTS.md`
- Change budget: 6 files, 0 migrations, at most 400 logical lines

### PR-002-SUB-001 — Deterministic interview and archetype planner

- CREATE: `src/team-proposal.ts`, `tests/unit/team-proposal.test.ts`
- READ_ONLY: `src/capabilities.ts`, `src/canonical.ts`
- FORBIDDEN: state and executor modules
- Steps:
  1. Parse exact request keys and bounded strings.
  2. Return 2–3 fixed-registry questions when work type or completion evidence is absent.
  3. Map complete requests to the smallest sufficient archetype set.
  4. Block unavailable requested capabilities.
  5. Hash canonical ready proposals without timestamps.
- Verification: `npx vitest run tests/unit/team-proposal.test.ts --no-file-parallelism`
- Expected exit: 0
- Expected result: deterministic needs-input, blocked, ready, and no-side-effect cases pass.

### PR-002-SUB-002 — Read-only CLI and public API

- CREATE: `tests/integration/team-proposal-cli.test.ts`
- MODIFY: `src/cli.ts`, `src/index.ts`, `tests/integration/cli-help.test.ts`
- READ_ONLY: `src/team-proposal.ts`, `src/capabilities.ts`
- FORBIDDEN: state and executor modules
- Steps:
  1. Add `team propose <request.json> --db <database>`.
  2. Add an injected `CapabilityProbe` dependency to the CLI dependency object.
  3. Build the capability matrix, call the pure planner, and serialize its result.
  4. Export only proposal types and the pure planner.
  5. Assert database `total_changes()` is unchanged and no injected command runner is invoked.
- Verification: `npx vitest run tests/unit/team-proposal.test.ts tests/integration/team-proposal-cli.test.ts tests/integration/cli-help.test.ts --no-file-parallelism`
- Expected exit: 0
- Expected result: command output matches the contract and mutation count remains unchanged.

## Dispatch prompt — PR-002

```text
TASK: PR-002 — Add capability-aware, proposal-only team archetypes.

DELIVERABLE:
- Changes limited to the PR-002 file list
- Focused and full verification outputs with exit codes
- Adjustment report, or "none"

SCOPE:
- Read REQ-TEAM-001 and the team proposal contract before editing.
- Implement deterministic pure planning and a read-only CLI.
- Do not spawn agents, invoke providers, mutate terminals, persist proposals, or accept proposals as receipts.
- Modify no migrations, approved executor, control plane, GJC, or Orca resume code.
- Adapt via LSP/read when symbols moved; stop on contract contradiction.

VERIFY: npm run verify
Expected exit: 0. Expected: all existing checks plus new proposal tests pass.
Report WORKING/BLOCKED.
```

## PR-003 — Immutable negative evidence

- Risk: R3
- Execution type: PARALLEL_SAFE after PR-001; no shared writable files with PR-002
- Related requirement: REQ-EVID-001
- Purpose: record approved failed approaches as typed authority data and expose them through read-only projections
- Predecessor: PR-001
- Successors: none
- CREATE: `migrations/028_negative_evidence.sql`, `src/negative-evidence.ts`, `tests/integration/negative-evidence.test.ts`
- MODIFY: `src/control-actions.ts`, `src/approved-executor.ts`, `src/task-timeline.ts`, `src/state-projection.ts`, `tests/integration/migrations.test.ts`, `tests/unit/public-api.test.ts`
- FORBIDDEN: migrations 001–027, retired collaboration tables, `src/cli.ts`, `src/index.ts`, `src/gjc.ts`, `src/orca-resume.ts`
- New internal symbols: parser, deterministic ID builder, and recorder implementing the contract in `03-ARCHITECTURE-CONTRACTS.md`
- Change budget: 9 files, 1 migration, at most 500 logical lines

### PR-003-SUB-001 — Schema and internal ledger

- CREATE: `migrations/028_negative_evidence.sql`, `src/negative-evidence.ts`
- MODIFY: `tests/integration/migrations.test.ts`
- READ_ONLY: `src/canonical.ts`, `src/control-plane.ts`
- FORBIDDEN: migrations 001–027
- Steps:
  1. Add the exact table, checks, indexes, immutable triggers, and foreign keys.
  2. Parse exact input keys and reject secret-shaped summaries.
  3. Derive the ID from canonical task/attempt/reason/scope/evidence digest.
  4. Insert with request and receipt binding; distinguish idempotent identity from conflict.
- Verification: `npx vitest run tests/integration/migrations.test.ts --no-file-parallelism`
- Expected exit: 0
- Expected result: migration applies repeatedly, prior checksums hold, update/delete fail.

### PR-003-SUB-002 — Approved execution and projections

- CREATE: `tests/integration/negative-evidence.test.ts`
- MODIFY: `src/control-actions.ts`, `src/approved-executor.ts`, `src/task-timeline.ts`, `src/state-projection.ts`, `tests/unit/public-api.test.ts`
- READ_ONLY: `src/negative-evidence.ts`, `src/control-plane.ts`
- FORBIDDEN: CLI, package exports, GJC, Orca resume
- Steps:
  1. Register exact action `evidence.negative.record` at minimum level 2 in the closed control-action registry.
  2. Add exact action-level-2 handling inside `ApprovedCommandExecutor`.
  3. Bind every row to the claimed request and receipt.
  4. Add timeline evidence events correlated by task ID.
  5. Add at most three recent negative-evidence records to the BLOCKED projection.
  6. Prove no direct recorder is exported.
  7. Test valid, invalid, unauthorized, replay, immutability, timeline, and Markdown projection paths.
- Verification: `npx vitest run tests/integration/negative-evidence.test.ts tests/integration/migrations.test.ts tests/unit/public-api.test.ts --no-file-parallelism`
- Expected exit: 0
- Expected result: all authority and projection cases pass in one run.

## Dispatch prompt — PR-003

```text
TASK: PR-003 — Add immutable approved negative evidence and read-only projections.

DELIVERABLE:
- Migration, internal ledger, executor, timeline/projection, and test changes within the PR-003 file list
- Focused and full verification outputs with exit codes
- Adjustment report, or "none"

SCOPE:
- Read REQ-EVID-001, ADR-003, and the negative-evidence data/error contracts.
- Preserve migrations 001–027 byte-for-byte.
- Permit inserts only through ApprovedCommandExecutor with an action-level-2 claimed receipt.
- Do not export a direct writer or mutate retired collaboration tables.
- Markdown remains generated projection only.
- Do not auto-retry, replace teams, or change task terminal state.

VERIFY: npm run verify
Expected exit: 0. Expected: prior 31 files/146 tests remain green, new tests pass, acceptance/build/smoke pass.
Report WORKING/BLOCKED.
```

## Traceability

| Requirement | Acceptance | PR | SUB | Files | Verification | Status |
|---|---|---|---|---|---|---|
| REQ-CAP-001 | ACCEPT-CAP-001-A/B/C | PR-001 | SUB-001/002 | capability, doctor, CLI, exports, tests | focused Vitest + `npm run verify` | planned |
| REQ-TEAM-001 | ACCEPT-TEAM-001-A/B/C/D | PR-002 | SUB-001/002 | proposal planner, CLI, exports, tests | focused Vitest + `npm run verify` | planned |
| REQ-EVID-001 | ACCEPT-EVID-001-A/B/C/D | PR-003 | SUB-001/002 | migration, ledger, approved executor, timeline/projection, tests | focused Vitest + `npm run verify` | planned |

## REVIEW LOG

- Date: 2026-08-18
- Machine check: `vague=0`, `incomplete=0`, `pending=0`.
- Command check: `npm run verify` exists; every focused Vitest command uses existing Vitest plus a test file created by its owning PR.
- Traceability check: 3 MUST requirements, 11 acceptance cases, 3 PRs, and 6 SUBs are linked.
- Ownership check: PR-002 and PR-003 have no shared CREATE/MODIFY file.
- Tier check: 19 unique changed files, 1 migration, highest risk R3; M tier retained.
- Author corrections before fresh review:
  - corrected intake file count from 16 to 19;
  - expanded `CapabilityProbe` to return all five capability stages;
  - added `completion_evidence` required by the proposal acceptance contract;
  - added explicit CLI capability-probe dependency injection.
  - added `src/control-actions.ts` to PR-003 after execution proved the closed descriptor registry had no extension seam for `evidence.negative.record`.
- Fresh review verdict: APPROVE.
- Findings: CRITICAL 0, HIGH 0, MEDIUM 0, LOW 0.
- Residual risk: implementation must preserve existing flat capability fields and must not export the negative-evidence recorder.

