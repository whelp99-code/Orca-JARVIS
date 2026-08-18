# Discovery and Baseline

## Repository evidence

| Status | Evidence | Finding |
|---|---|---|
| `CONFIRMED` | `src/doctor.ts:7-58` | Doctor checks runtime, database integrity, migrations, service heartbeat, and report backlog but has no provider capability matrix. |
| `CONFIRMED` | `src/cli.ts:160-166` | `capabilities --json` returns flat booleans and provider arrays. |
| `CONFIRMED` | `src/loopgraph.ts:70-92` | Workflow mutation requires approved receipts and records evidence digests. |
| `CONFIRMED` | `src/approved-executor.ts:24-40,87-116` | External effects use idempotency keys and terminal `uncertain` handling. |
| `CONFIRMED` | `src/task-timeline.ts:90-170` | Timeline is a read-only projection over authoritative records. |
| `CONFIRMED` | `migrations/026_task_timeline.sql` | Writable collaboration tables are permanently retired in favor of task timeline. |
| `CONFIRMED` | `tests/integration/collaboration-workspace.test.ts:11-22` | Former collaboration mutation paths fail closed. |
| `CONFIRMED` | `src/state-projection.ts:52-82` | JSON and Markdown are generated projections, not authority. |

## Upstream evidence

- `CONFIRMED` `kkirikkiri` implements executable environment probing in `scripts/check-env.js`.
- `CONFIRMED` Its detached job and provider adapter scripts exist, but do not provide JARVIS receipts, fencing, or uncertainty semantics.
- `CONFIRMED` Archetypes, interview rules, shared Markdown, and team replacement are protocol documents rather than enforced runtime state machines.
- `INFERRED` Capability-aware planning and archetype decomposition are reusable if isolated above the authority boundary.

Reference revision: `fivetaku/kkirikkiri@b3e21bc9c397664da7fc95dd3ab01960e00f2cd8`.

## Baseline verification

Command:

```text
npm run verify
```

Observed:

- Exit code: `0`.
- Runtime: Node `v24.19.0`, ABI `137`.
- Lint and `tsc --noEmit`: passed.
- Vitest: 31 files passed, 146 tests passed.
- Pre-GJC acceptance: `boundary=pre_gjc_ready`, `completion_promoted=true`, `gjc_dispatched=false`.
- Build and CLI smoke: passed.

## Existing constraints

1. Direct generic mutation engines are not exported from `src/index.ts`.
2. Existing CLI capability fields are already consumed by tests.
3. Shipped migration bytes are immutable; new schema requires migration `028`.
4. Lost external acknowledgement remains `uncertain` and is never blindly replayed.
5. New tests cannot rely on host-installed CLIs; executable and protocol probes must be injected.

