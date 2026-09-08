# Task executor registry shared by inspection and execution

Date: 2026-09-09. Backlog 21, following work routing preview 20.

Production task runtime creation and readiness previously assumed Claude directly.
Move the existing implementation into a private, compiled executor registration.
Both the approved execution path and readiness resolve the exact plan provider
through this registration; there is no fallback to a different provider.

The initial registered executor is `claude-code`, mapped to plan provider `claude`.
Its supported plan is version 2, verified_git_commit, with declared repository
file scope, existing single-use approval and independent verification. Runtime
creation retains the existing CLI, verifier and sandbox checks. The registry does
not relax request, signature, lease, revocation, deadline or completion checks.

`jarvis routing executors` lists compiled registrations; `jarvis routing executor
ID` inspects one ID used by the routing policy. These commands run before opening
AuthorityDb and do not call agents or inspect authentication. Configuration status
means only that all required host environment variables are nonempty; it does not
certify paths, credentials, protocol compatibility or authority. Only variable
names and missing names are emitted, never values or private paths. Every result
has execution_available=false and readiness/authentication=not_probed: an approved
plan and the normal runtime preflight are still required before dispatch.

Unregistered IDs remain unregistered, including cursor, mail-intelligence,
sangfor-os, sangfor-engineer-mcp and cowork from the routing preview. Codex task
plans remain unsupported. No external JSON can install factories or choose command
paths. Adding an executor requires a reviewed implementation and contract tests.

Remaining work includes external executor input/result contracts, authenticated
readiness, approval-bound routing in task admission, and actual external workflow
acceptance. Registry presence alone does not complete backlog 21.

## Verification evidence

- Backend build, 30 tests across registry/runtime/approved execution/routing CLI/
  module reviewability, lint and all three TypeScript configurations: exit 0.
  The test run took 17.44 seconds. Approval cancellation, expiry, revocation,
  verifier failure and uncertain publication are covered by existing regressions.
- Separate compiled CLI processes 1247649/1247663/1247713/1247746 exercised list,
  registered ID, unregistered ID and malformed ID. Exit codes: 0/0/0/2;
  database files created: 0. This is inspection acceptance, not a model execution.
  Receipt: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/executor-registry-l201mi_1/receipt.json`.
- Configured-but-unusable provider/key paths in the compiled CLI regression remain
  configuration=present, readiness/authentication=not_probed; provider marker and
  database files are absent, and supplied private values are absent from output.
- The separately running full verification uses frozen commit e70d113 and excludes
  this registry unit. Do not cite it as full verification of these changes.
- Read-only reviewer `/root/executor_registry_review`: ship, no required fixes.
  Requested gpt-5.6-terra/high; actual model and effort unavailable in metadata.
  Existing trusted host/test runtime injection remains supported and can bypass
  the factory, but still passes normal runtime and execution authority checks.
  Request/policy JSON cannot supply that injection.

## Shared resource limits

The registry now exposes `limits.plan`, `limits.provider` and `limits.files` from
the same immutable compiled module used by plan parsing, provider preparation and
transport, execution clock/verifier admission, workspace capture, candidate verification/artifact decoding, and Git
publication reads. This removes independently maintained copies of those limits.

Plan timeout remains 1,000–600,000ms and output budget 1,024–1,048,576 bytes, with
at most 128 declared files and 8 verification checks. Provider remaining budgets
can be as small as 1ms/1 byte; these are not new plan-admission minima. Prompt limit
is 524,288 bytes, individual file limit 4,194,304 bytes and aggregate file limit
16,777,216 bytes. These are independent upper bounds: prompt/envelope overhead and
the smaller plan budget can reject inputs or outputs below a file-size maximum.

No limits are writable through a policy or request. The artifact envelope's 24MiB
and measurement's 256KiB caps remain separate encoding limits. This change does
not introduce a configurable external adapter schema or authenticated readiness.

Initial validation: backend build, 131 tests in 11 files (32.27 seconds), lint and all
three TypeScript configurations completed with exit 0. Tests include plan-bound
admission, smaller remaining provider budgets, compiled registry inspection,
workspace checks, candidate artifacts and SIGKILL recovery around Git publication.
Separate compiled CLI inspection PID1294188/exit0 returned the declared limits,
execution_available=false and created zero database files. Receipt:
`/home/jm/.cache/jarvis-test-runtime-qa-20260908/executor-limits-K0TryU/receipt.json`.
This does not prove external model authentication or production deployment.

The initial read-only review returned fix-first for two remaining timeout literals
in execution-clock and verifier-process admission. Both now consume the shared
limits. The expanded rerun passed 152 tests in 14 files (32.99 seconds), including
clock, verifier process and actual verifier SIGKILL recovery.
Final backend build, lint and all three TypeScript configurations also exited 0.
A separate compiled Linux-clock/verifier-admission process PID1317066/exit0 checked eight boundary
cases without spawning a verifier or model:
`/home/jm/.cache/jarvis-test-runtime-qa-20260908/executor-clock-limits-P3trxH/receipt.json`.

Fresh final review `/root/execution_limits_final_review`: ship, findings 0.
Requested luna/high; actual model and effort are unavailable in tool metadata.
