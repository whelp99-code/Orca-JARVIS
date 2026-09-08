# Explicit executor authentication observation

Date: 2026-09-09. Backlog 21; does not complete external executor integration.

`jarvis routing probe-executor claude-code` explicitly invokes the configured
Claude executable with fixed `auth status --json` arguments. It uses the same
executable checks and HOME/PATH/LANG/TZ environment filter as candidate generation,
root cwd, no shell and closed stdin. It never invokes a model prompt. No database,
approval, workflow, verifier key or repository is opened by this command.

The official [CLI reference](https://code.claude.com/docs/en/cli-usage) specifies
JSON status, exit 0 when logged in and exit 1 when not. The installed CLI
`/home/jm/.local/share/claude/versions/2.1.261` also advertises JSON status in help.
Only boolean loggedIn=true/exit0 and false/exit1 become `reported_logged_in` and
`reported_logged_out`. This reports the CLI's claim; `remote_verification` remains
`not_performed`. It does not certify token validity, account scope, quota, model
access or a future request. No cached observation grants execution authority.

The status subprocess receives the remaining portion of a 5-second monotonic
budget after executable preparation. Combined stdout/stderr is capped at 32KiB.
Timeout/overflow kill the process group and resolve only after process close.
Local executable preparation uses the existing filesystem checks; it is not a
separately interruptible filesystem operation. Failure, malformed UTF-8/JSON,
duplicate keys or contradictory exit/status yield unknown with a fixed reason
code. Raw stdout, stderr, email, organization, paths and method identifiers are
never returned. Strict JSON also bounds nesting and parser work.

Missing executable configuration or an unregistered executor remains not_probed.
Other missing runtime configuration does not prevent inspecting CLI login, but
execution_available=false/readiness=not_probed are preserved. Existing `routing
executor(s)`, normal runtime preflight and dashboard reads do not automatically
spawn this probe. This is an explicit observation command, not an activation API.

Validation: 66 tests in 9 files, 24.62 seconds; backend build, lint and all three
TypeScript checks exit 0. A real fixture timeout returned after 5,005ms and the
child PID no longer existed. Tests cover login/logout, contradictory status,
duplicate keys, malformed bytes, private fields, output overflow, fixed argv,
environment filtering, missing config and retained approval execution regressions.

Actual installed CLI through the compiled JARVIS command: PID1391313, exit0,
reported_logged_in/remote_verification=not_performed, configuration=missing,
execution_available=false, zero JARVIS DB files and zero exposed identity fields.
Only JARVIS_TASK_CLAUDE_PATH was supplied to that process; verifier settings were
empty. No persistent runtime configuration or service deployment was changed.
Receipt: `/home/jm/.cache/jarvis-test-runtime-qa-20260908/executor-auth-live-qj3c24_n/receipt.json`.
The concurrent full verify is frozen at 8b98cd8 and excludes this unit.

Remaining: authenticated model-transport acceptance, permission-scope admission,
external adapter result contracts and integration with approved task routing.
Do not turn a reported login into automatic execution readiness.

Read-only review `/root/executor_auth_review`: ship, findings 0. Requested
terra/high; actual model and effort were not exposed by tool metadata.
