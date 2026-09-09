# Explicit executor runtime probe

Status: implementation target for backlog21; not implemented or operationally enabled.
Inspection baseline23cc5d2. Actual compiled routing executors returned exit0,
1registered executor (claude-code),3missing configuration fields in the current
shell, readiness/authentication not_probed and execution_available false.
Evidence: /home/jm/.cache/jarvis-test-runtime-qa-20260908/task-executor-current-inventory.json.

The existing probeTaskExecutor invokes only the local authentication probe.
createClaudeRuntime.checkReady already resolves the trusted provider executable,
checks the independent verifier key/process, validates the clock and runs an empty
sandbox Node command. Reuse that implementation for an explicit runtime diagnostic;
keep passive inspection and auth-only probe behavior unchanged.

The runtime diagnostic must report unregistered, missing configuration, unavailable,
or locally ready with bounded reason codes. It must not produce a task candidate,
redeem an approval, write workflow state, or mark execution_available true. Local
readiness is not remote authentication success or task authority. Do not expose raw
errors, executable output, private key material or configured secret paths.

Acceptance: missing/unsupported settings cause no process launch; readiness failure
is represented independently of authentication; a real isolated verifier/sandbox
probe returns a structured local observation without model calls or DB writes.
Bind any configurable clock to validation, and make readiness rechecked at actual
execution so this observation never substitutes for execution preflight.
